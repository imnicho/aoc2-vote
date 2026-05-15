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

function boolEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function csvLowerEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
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
  OPERATOR_IGNS: string[];
  SESSION_SECRET: string | null;
  SESSION_TTL_MS: number;
  MINT_TTL_MS: number;
  PUBLIC_BASE_URL: string;
  PTERO_DRY_RUN: boolean;
  PTERO_MOCK_ROSTER: string[];
  SPAWN_COORDS: { x: number; y: number; z: number };
}

function intEnvSigned(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig(): Config {
  const dryRun = boolEnv('PTERO_DRY_RUN');
  const allowedOrigin = required('ALLOWED_ORIGIN');

  // CI safety net: refuse to start with dry-run enabled against anything
  // that looks like a real production origin.
  if (dryRun) {
    const lower = allowedOrigin.toLowerCase();
    const looksLocal =
      lower.includes('localhost') ||
      lower.includes('127.0.0.1') ||
      lower.includes('::1');
    if (!looksLocal) {
      throw new Error(
        `PTERO_DRY_RUN=true is only allowed with localhost ALLOWED_ORIGIN (got: ${allowedOrigin})`,
      );
    }
  }

  // Dry-run can fall back to a placeholder token because no real Pterodactyl
  // call is ever made. In normal mode the token is required as before.
  const pteroBase = dryRun
    ? (process.env.PTERO_BASE || 'http://dry-run.invalid').replace(/\/+$/, '')
    : required('PTERO_BASE').replace(/\/+$/, '');
  const pteroServerId = dryRun
    ? process.env.PTERO_SERVER_ID || 'dry-run'
    : required('PTERO_SERVER_ID');
  const pteroToken = dryRun
    ? process.env.PTERO_TOKEN || 'dry-run'
    : required('PTERO_TOKEN');

  // SESSION_SECRET is required whenever we want to mint anyone's token. In
  // dry-run we fall back to a placeholder so the server boots without env
  // setup; otherwise require it at the standard min length.
  let sessionSecret: string | null = process.env.SESSION_SECRET || null;
  if (dryRun && !sessionSecret) {
    sessionSecret = 'dry-run-session-secret-dry-run-session-secret-32+';
  }
  if (sessionSecret !== null && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  if (!dryRun && sessionSecret === null) {
    throw new Error('Missing required env var: SESSION_SECRET');
  }

  const operatorIgns = csvLowerEnv('OPERATOR_IGNS');
  const mockRoster = csvLowerEnv('PTERO_MOCK_ROSTER');
  const publicBase = (process.env.PUBLIC_BASE_URL || 'https://nicho.wtf').replace(
    /\/+$/,
    '',
  );

  return {
    PTERO_BASE: pteroBase,
    PTERO_SERVER_ID: pteroServerId,
    PTERO_TOKEN: pteroToken,
    ALLOWED_ORIGIN: allowedOrigin,
    PORT: intEnv('PORT', 3000),
    DB_PATH: process.env.DB_PATH || '/data/aoc2-vote.db',
    POLL_TTL_MS: intEnv('POLL_TTL_MS', 300_000),
    COOLDOWN_MS: intEnv('COOLDOWN_MS', 600_000),
    ROSTER_REFRESH_MS: intEnv('ROSTER_REFRESH_MS', 30_000),
    OPERATOR_IGNS: operatorIgns,
    SESSION_SECRET: sessionSecret,
    SESSION_TTL_MS: intEnv('SESSION_TTL_MS', 4 * 60 * 60 * 1000),
    MINT_TTL_MS: intEnv('MINT_TTL_MS', 5 * 60 * 1000),
    PUBLIC_BASE_URL: publicBase,
    PTERO_DRY_RUN: dryRun,
    PTERO_MOCK_ROSTER: dryRun && mockRoster.length === 0 ? ['nicho'] : mockRoster,
    SPAWN_COORDS: {
      x: intEnvSigned('SPAWN_X', -1756),
      y: intEnvSigned('SPAWN_Y', 119),
      z: intEnvSigned('SPAWN_Z', 1201),
    },
  };
}
