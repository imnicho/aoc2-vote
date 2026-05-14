import {
  ACTION_LABELS,
  commandsFor,
  isPowerAction,
  type Action,
} from './actions.js';
import type { Config } from './config.js';
import type { PollManager } from './poll.js';
import type { PteroClient } from './ptero.js';

/**
 * Closed-enum-guarded executor for operator-driven actions. There is no
 * authentication in here — the route layer checks the bearer session for
 * `is_operator: true` and calls `execute(ign, action)` only after that.
 */
export type ExecuteError =
  | { kind: 'invalid_action' }
  | { kind: 'action_on_cooldown'; until: number };

export interface OperatorExecDeps {
  cfg: Config;
  ptero: PteroClient;
  polls: PollManager;
}

export class OperatorExec {
  private readonly cfg: Config;
  private readonly ptero: PteroClient;
  private readonly polls: PollManager;

  constructor(deps: OperatorExecDeps) {
    this.cfg = deps.cfg;
    this.ptero = deps.ptero;
    this.polls = deps.polls;
  }

  async execute(
    ign: string,
    action: unknown,
  ): Promise<{ ok: true } | { ok: false; err: ExecuteError }> {
    if (!isOperatorAction(action)) {
      return { ok: false, err: { kind: 'invalid_action' } };
    }

    const cooldownUntil = this.polls.cooldownFor(action);
    if (cooldownUntil !== null && cooldownUntil > Date.now()) {
      return {
        ok: false,
        err: { kind: 'action_on_cooldown', until: cooldownUntil },
      };
    }

    const spawnCoords = this.cfg.SPAWN_COORDS;
    this.polls.applyCooldown(action);

    const label = ACTION_LABELS[action];
    this.ptero
      .runCommand(`say ${sanitize(`Operator ${ign} ran ${label}.`)}`)
      .catch((err) => logOpError('execute say', err));

    if (isPowerAction(action)) {
      this.ptero.power('restart').catch((err) => logOpError('execute power', err));
    } else {
      for (const cmd of commandsFor(action, { spawn: spawnCoords })) {
        this.ptero.runCommand(cmd).catch((err) =>
          logOpError(`execute cmd ${action}`, err),
        );
      }
      if (action === 'tps') {
        this.ptero
          .captureTps()
          .then((tps) => {
            if (!tps) return;
            this.polls.setLastTps(tps);
            this.ptero
              .runCommand(`say ${sanitize(tps)}`)
              .catch((err) => logOpError('execute tps-say', err));
          })
          .catch((err) => logOpError('execute captureTps', err));
      }
    }

    // eslint-disable-next-line no-console
    console.info(`[op] ${ign} ran ${action}`);
    return { ok: true };
  }
}

function isOperatorAction(v: unknown): v is Action {
  if (typeof v !== 'string') return false;
  switch (v) {
    case 'weather_clear':
    case 'item_cleanup':
    case 'day':
    case 'night':
    case 'tps':
    case 'save_all':
    case 'gather_at_spawn':
    case 'restart':
      return true;
    default:
      return false;
  }
}

function sanitize(s: string): string {
  return s.replace(/§./g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
}

function logOpError(action: string, err: unknown): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const trimmed = message.replace(/(Pterodactyl [^:]+:\s*\d+)\s.*/s, '$1');
  // eslint-disable-next-line no-console
  console.error(`[op] ${action}: ${trimmed}`);
}
