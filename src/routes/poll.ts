import { Hono } from 'hono';
import { isAction } from '../actions.js';
import { clientIp } from '../clientIp.js';
import type { IgnBinding } from '../ignBinding.js';
import type { PollManager } from '../poll.js';
import type { PteroClient } from '../ptero.js';
import type { RateLimiter } from '../rateLimit.js';

interface OpenBody {
  ign?: unknown;
  action?: unknown;
}

interface VoteBody {
  ign?: unknown;
}

interface PollRouteDeps {
  polls: PollManager;
  limiter: RateLimiter;
  binding: IgnBinding;
  ptero: PteroClient;
  /**
   * Hard ceiling on how long we'll wait for a fresh roster cycle when the
   * cached roster is older than the stale-threshold. The route never 500s on
   * timeout — it falls through to the cached value.
   */
  rosterFreshTimeoutMs?: number;
}

const ROSTER_STALE_MS = 1500;

export function pollRoute(deps: PollRouteDeps): Hono {
  const { polls, limiter, binding, ptero } = deps;
  const rosterFreshTimeoutMs = deps.rosterFreshTimeoutMs ?? 2000;
  const app = new Hono();

  app.post('/api/poll', async (c) => {
    const ip = clientIp(c);
    if (!limiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);

    let body: OpenBody;
    try {
      body = (await c.req.json()) as OpenBody;
    } catch {
      return c.json({ error: 'invalid_action' }, 400);
    }
    const ign = typeof body.ign === 'string' ? body.ign.trim() : '';
    const action = body.action;
    if (!ign || !/^[A-Za-z0-9_]{1,32}$/.test(ign)) {
      return c.json({ error: 'ign_not_online' }, 400);
    }
    if (!isAction(action)) {
      return c.json({ error: 'invalid_action' }, 400);
    }

    const bindCheck = binding.check(ign, ip);
    if (bindCheck.kind === 'mismatch') {
      return c.json({ error: 'ign_ip_mismatch' }, 403);
    }

    await ensureFreshRoster(ptero, rosterFreshTimeoutMs);

    const res = polls.open(ign, action);
    if (!res.ok) {
      switch (res.err.kind) {
        case 'ign_not_online':
          return c.json({ error: 'ign_not_online' }, 400);
        case 'poll_already_open':
          return c.json({ error: 'poll_already_open' }, 409);
        case 'action_on_cooldown':
          return c.json({ error: 'action_on_cooldown', until: res.err.until }, 409);
      }
    }
    binding.record(ign, ip);
    return c.json({ poll_id: res.result.poll.id });
  });

  app.post('/api/poll/:id/vote', async (c) => {
    const ip = clientIp(c);
    if (!limiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);

    const id = c.req.param('id');
    let body: VoteBody;
    try {
      body = (await c.req.json()) as VoteBody;
    } catch {
      return c.json({ error: 'ign_not_online' }, 400);
    }
    const ign = typeof body.ign === 'string' ? body.ign.trim() : '';
    if (!ign || !/^[A-Za-z0-9_]{1,32}$/.test(ign)) {
      return c.json({ error: 'ign_not_online' }, 400);
    }

    const bindCheck = binding.check(ign, ip);
    if (bindCheck.kind === 'mismatch') {
      return c.json({ error: 'ign_ip_mismatch' }, 403);
    }

    await ensureFreshRoster(ptero, rosterFreshTimeoutMs);

    const res = polls.vote(id, ign);
    if (!res.ok) {
      switch (res.err.kind) {
        case 'ign_not_online':
          return c.json({ error: 'ign_not_online' }, 400);
        case 'poll_not_found':
          return c.json({ error: 'poll_not_found' }, 404);
        case 'poll_expired':
          return c.json({ error: 'poll_expired' }, 410);
        case 'already_voted':
          return c.json({ error: 'already_voted' }, 409);
      }
    }
    binding.record(ign, ip);
    const out: { ok: true; votes: number; needed: number; executed?: true } = {
      ok: true,
      votes: res.result.votes,
      needed: res.result.needed,
    };
    if (res.result.executed) out.executed = true;
    return c.json(out);
  });

  return app;
}

/**
 * If the roster cache is older than `ROSTER_STALE_MS`, kick off an on-demand
 * `list` request and await one roster cycle. The wait is bounded by
 * `timeoutMs`; on timeout we silently fall through to the cached value
 * rather than 500ing.
 */
async function ensureFreshRoster(ptero: PteroClient, timeoutMs: number): Promise<void> {
  if (ptero.roster.age() <= ROSTER_STALE_MS) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = ptero.roster.onChange(finish);
    const timer = setTimeout(finish, timeoutMs);
    ptero.requestList();
  });
}
