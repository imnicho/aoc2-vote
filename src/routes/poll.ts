import { Hono } from 'hono';
import { isAction } from '../actions.js';
import { bearerAuth } from '../auth.js';
import { clientIp } from '../clientIp.js';
import type { Config } from '../config.js';
import type { PollManager } from '../poll.js';
import type { PteroClient } from '../ptero.js';
import type { RateLimiter } from '../rateLimit.js';

interface OpenBody {
  action?: unknown;
}

interface PollRouteDeps {
  cfg: Config;
  polls: PollManager;
  limiter: RateLimiter;
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
  const { cfg, polls, limiter, ptero } = deps;
  const rosterFreshTimeoutMs = deps.rosterFreshTimeoutMs ?? 2000;
  const app = new Hono();

  const auth = bearerAuth(cfg.SESSION_SECRET);

  app.post('/api/poll', auth, async (c) => {
    const ip = clientIp(c);
    if (!limiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);

    const session = c.get('auth');

    let body: OpenBody;
    try {
      body = (await c.req.json()) as OpenBody;
    } catch {
      return c.json({ error: 'invalid_action' }, 400);
    }
    const action = body.action;
    if (!isAction(action)) {
      return c.json({ error: 'invalid_action' }, 400);
    }

    await ensureFreshRoster(ptero, rosterFreshTimeoutMs);

    const res = polls.open(session.ign, action);
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
    return c.json({ poll_id: res.result.poll.id });
  });

  app.post('/api/poll/:id/vote', auth, async (c) => {
    const ip = clientIp(c);
    if (!limiter.take(ip)) return c.json({ error: 'rate_limited' }, 429);

    const session = c.get('auth');
    const id = c.req.param('id');

    await ensureFreshRoster(ptero, rosterFreshTimeoutMs);

    const res = polls.vote(id, session.ign);
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
