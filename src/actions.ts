export const ACTIONS = [
  'weather_clear',
  'item_cleanup',
  'day',
  'night',
  'tps',
  'save_all',
  'restart',
] as const;

export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  weather_clear: 'clear the weather',
  item_cleanup: 'clean up dropped items',
  day: 'set the time to day',
  night: 'set the time to night',
  tps: 'run a TPS report',
  save_all: 'save the world',
  restart: 'restart the server',
};

export function isAction(v: unknown): v is Action {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

export function actionLabel(a: Action): string {
  return ACTION_LABELS[a];
}

/**
 * The minecraft-side command(s) to run for a given action.
 * `restart` is handled via Pterodactyl power, not console; returns an empty list.
 * `tps` returns the spark command; the say-summary is sent after capture.
 */
export function commandsFor(a: Action): readonly string[] {
  switch (a) {
    case 'weather_clear':
      return ['weather clear'];
    case 'item_cleanup':
      return ['kill @e[type=item]'];
    case 'day':
      return ['time set day'];
    case 'night':
      return ['time set night'];
    case 'tps':
      return ['spark tps'];
    case 'save_all':
      return ['save-all'];
    case 'restart':
      return [];
  }
}

/**
 * Whether this action runs via Pterodactyl power signal (restart) rather than console.
 */
export function isPowerAction(a: Action): boolean {
  return a === 'restart';
}
