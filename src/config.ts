function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  return n;
}

export interface Config {
  PTERO_BASE: string;
  PTERO_SERVER_ID: string;
  PTERO_TOKEN: string;
  ALLOWED_ORIGIN: string;
  PORT: number;
  DB_PATH: string;
  POLL_TTL_MS: number;
  COOLDOWN_MS: number;
  ROSTER_REFRESH_MS: number;
}

export function loadConfig(): Config {
  return {
    PTERO_BASE: required('PTERO_BASE').replace(/\/+$/, ''),
    PTERO_SERVER_ID: required('PTERO_SERVER_ID'),
    PTERO_TOKEN: required('PTERO_TOKEN'),
    ALLOWED_ORIGIN: required('ALLOWED_ORIGIN'),
    PORT: intEnv('PORT', 3000),
    DB_PATH: process.env.DB_PATH || '/data/aoc2-vote.db',
    POLL_TTL_MS: intEnv('POLL_TTL_MS', 300_000),
    COOLDOWN_MS: intEnv('COOLDOWN_MS', 600_000),
    ROSTER_REFRESH_MS: intEnv('ROSTER_REFRESH_MS', 5_000),
  };
}
