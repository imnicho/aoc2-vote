import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.js';
import type { PteroClient } from '../src/ptero.js';
import { Roster } from '../src/roster.js';
import { verifySessionToken } from '../src/sessionToken.js';
import { WelcomeFlow, buildWelcomeComponents } from '../src/welcomeFlow.js';

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
    PTERO_DRY_RUN: false,
    PTERO_MOCK_ROSTER: [],
    SPAWN_COORDS: { x: -1780, y: 117, z: 1187 },
  };
  return { ...base, ...overrides };
}

interface Recorded {
  value: string;
}

function makePtero(): { client: PteroClient; cmds: Recorded[] } {
  const cmds: Recorded[] = [];
  const client = {
    runCommand: async (c: string): Promise<void> => {
      cmds.push({ value: c });
    },
    power: async (): Promise<void> => undefined,
    captureTps: async (): Promise<string | null> => null,
  } as unknown as PteroClient;
  return { client, cmds };
}

test('on join, an operator IGN gets a tellraw with a valid mint token URL', async () => {
  const cfg = makeCfg();
  const roster = new Roster();
  const { client, cmds } = makePtero();
  const welcome = new WelcomeFlow({ cfg, roster, ptero: client });
  welcome.start();

  roster.addPlayer('nicho');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(cmds.length, 1);
  const cmd = cmds[0]!.value;
  // Selector targets only the joining player.
  assert.match(cmd, /^tellraw @a\[name=nicho\] /);
  // Includes the dashboard URL with a ?t= token.
  const urlMatch = cmd.match(/http:\/\/localhost:4321\/aoc2\/vote\?t=([^"\s]+)/);
  assert.ok(urlMatch, `expected dashboard URL with token in: ${cmd}`);
  const token = urlMatch![1]!;

  const verified = verifySessionToken(token, 'mint', SECRET);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.value.ign, 'nicho');
    assert.equal(verified.value.is_operator, true);
  }
  welcome.stop();
});

test('on join, a non-operator IGN gets is_operator=false in their mint token', async () => {
  const cfg = makeCfg({ OPERATOR_IGNS: ['nicho'] });
  const roster = new Roster();
  const { client, cmds } = makePtero();
  const welcome = new WelcomeFlow({ cfg, roster, ptero: client });
  welcome.start();

  roster.addPlayer('alice');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(cmds.length, 1);
  const cmd = cmds[0]!.value;
  const urlMatch = cmd.match(/http:\/\/localhost:4321\/aoc2\/vote\?t=([^"\s]+)/);
  assert.ok(urlMatch);
  const verified = verifySessionToken(urlMatch![1]!, 'mint', SECRET);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.value.ign, 'alice');
    assert.equal(verified.value.is_operator, false);
  }
  welcome.stop();
});

test('welcome is skipped when SESSION_SECRET is null', async () => {
  const cfg = makeCfg({ SESSION_SECRET: null });
  const roster = new Roster();
  const { client, cmds } = makePtero();
  const welcome = new WelcomeFlow({ cfg, roster, ptero: client });
  welcome.start();
  roster.addPlayer('nicho');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cmds.length, 0);
  welcome.stop();
});

test('dispatch dedupes back-to-back calls within the dedupe window', async () => {
  const cfg = makeCfg();
  const roster = new Roster();
  const { client, cmds } = makePtero();
  const welcome = new WelcomeFlow({ cfg, roster, ptero: client });
  welcome.start();

  await welcome.dispatch('nicho');
  await welcome.dispatch('nicho');
  await welcome.dispatch('NICHO');

  assert.equal(cmds.length, 1, `expected 1 tellraw, got ${cmds.length}`);
  welcome.stop();
});

test('dispatch dedupe is per-IGN — different players each get their own welcome', async () => {
  const cfg = makeCfg();
  const roster = new Roster();
  const { client, cmds } = makePtero();
  const welcome = new WelcomeFlow({ cfg, roster, ptero: client });
  welcome.start();

  await welcome.dispatch('nicho');
  await welcome.dispatch('alice');
  await welcome.dispatch('bob');

  assert.equal(cmds.length, 3);
  welcome.stop();
});

test('buildWelcomeComponents produces a click_event open_url with the supplied URL', () => {
  const cmps = buildWelcomeComponents('nicho', 'http://example/path?t=XYZ');
  // Find the clickable component.
  const clickable = cmps.find(
    (c) => typeof c === 'object' && c !== null && (c as { clickEvent?: unknown }).clickEvent !== undefined,
  ) as { clickEvent: { action: string; value: string } } | undefined;
  assert.ok(clickable);
  assert.equal(clickable!.clickEvent.action, 'open_url');
  assert.equal(clickable!.clickEvent.value, 'http://example/path?t=XYZ');
});

test('buildWelcomeComponents: no component is bold (every entry sets bold:false)', () => {
  const cmps = buildWelcomeComponents('nicho', 'http://example/path?t=XYZ');
  for (const c of cmps) {
    assert.ok(typeof c === 'object' && c !== null);
    const o = c as { bold?: unknown };
    assert.notEqual(o.bold, true);
    assert.equal(o.bold, false);
  }
});

test('buildWelcomeComponents: link text has no inner spaces inside brackets', () => {
  const cmps = buildWelcomeComponents('nicho', 'http://x') as Array<Record<string, unknown>>;
  const link = cmps.find((c) => typeof c.text === 'string' && (c.text as string).includes('open dashboard'));
  assert.ok(link);
  assert.equal(link!.text, '[open dashboard ↗]');
});
