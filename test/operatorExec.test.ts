import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { OperatorExec } from '../src/operatorExec.js';
import { PollManager } from '../src/poll.js';
import { Roster } from '../src/roster.js';
import type { PteroClient } from '../src/ptero.js';

const SECRET = 'test-secret-test-secret-test-secret-32+';

function makeCfg(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    PTERO_BASE: 'http://localhost',
    PTERO_SERVER_ID: 'srv-test',
    PTERO_TOKEN: 'ptlc_TEST',
    ALLOWED_ORIGIN: 'http://localhost',
    PORT: 0,
    DB_PATH: ':memory:',
    POLL_TTL_MS: 300_000,
    COOLDOWN_MS: 600_000,
    ROSTER_REFRESH_MS: 5_000,
    OPERATOR_IGNS: ['nicho'],
    SESSION_SECRET: SECRET,
    SESSION_TTL_MS: 4 * 60 * 60 * 1000,
    MINT_TTL_MS: 5 * 60 * 1000,
    PUBLIC_BASE_URL: 'http://localhost:4321',
    PTERO_DRY_RUN: true,
    PTERO_MOCK_ROSTER: ['nicho'],
    SPAWN_COORDS: { x: -1780, y: 117, z: 1187 },
  };
  return { ...base, ...overrides };
}

function makeDb(): DB {
  const dir = mkdtempSync(join(tmpdir(), 'aoc2-vote-op-'));
  return openDb(join(dir, 'test.db'));
}

interface RecordedCmd {
  kind: 'cmd' | 'power';
  value: string;
}

function makePtero(): { client: PteroClient; cmds: RecordedCmd[] } {
  const cmds: RecordedCmd[] = [];
  const client = {
    runCommand: async (c: string): Promise<void> => {
      cmds.push({ kind: 'cmd', value: c });
    },
    power: async (s: string): Promise<void> => {
      cmds.push({ kind: 'power', value: s });
    },
    captureTps: async (): Promise<string | null> => 'DRY-RUN: TPS 20.0/20.0/20.0',
  } as unknown as PteroClient;
  return { client, cmds };
}

test('execute rejects an unknown action (closed enum)', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho']);
  const { client } = makePtero();
  const polls = new PollManager(cfg, db, client, roster);
  const ops = new OperatorExec({ cfg, ptero: client, polls });

  for (const action of [
    'rm -rf /',
    'op @a',
    'restart; rm -rf /',
    'restart\nop @a',
    'RESTART',
    'eval',
    'execute',
    'time set day',
    '',
    null,
    undefined,
    123,
    { action: 'restart' },
    ['restart'],
    'restart ',
    ' restart',
    'op',
  ]) {
    const r = await ops.execute('nicho', action as unknown);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(action)}`);
    if (!r.ok) assert.equal(r.err.kind, 'invalid_action');
  }
  db.raw.close();
});

test('execute accepts every enum action and only sends known commands', async () => {
  const cfg = makeCfg();
  const db = makeDb();
  const roster = new Roster();
  roster.set(['nicho']);
  const { client, cmds } = makePtero();
  const polls = new PollManager(cfg, db, client, roster);
  const ops = new OperatorExec({ cfg, ptero: client, polls });

  for (const action of [
    'weather_clear',
    'item_cleanup',
    'day',
    'night',
    'tps',
    'save_all',
    'gather_at_spawn',
    'restart',
  ] as const) {
    const r = await ops.execute('nicho', action);
    assert.equal(r.ok, true, `expected ${action} to be accepted`);
    const r2 = await ops.execute('nicho', action);
    assert.equal(r2.ok, false, `expected cooldown on second ${action}`);
    if (!r2.ok) assert.equal(r2.err.kind, 'action_on_cooldown');
  }

  for (const c of cmds) {
    if (c.kind === 'power') {
      assert.equal(c.value, 'restart');
      continue;
    }
    assert.ok(!c.value.includes(';'), `unexpected ; in ${c.value}`);
    assert.ok(!c.value.includes('\n'), `unexpected newline in ${c.value}`);
    assert.ok(!c.value.includes('`'), `unexpected backtick in ${c.value}`);
  }
  db.raw.close();
});
