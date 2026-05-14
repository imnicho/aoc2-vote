import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { IgnBinding } from './ignBinding.js';
import { PteroClient } from './ptero.js';
import { PollManager } from './poll.js';
import { RateLimiter } from './rateLimit.js';
import { SseBroadcaster, type StateSnapshot } from './sse.js';
import { checkIgnRoute } from './routes/checkIgn.js';
import { stateRoute } from './routes/state.js';
import { pollRoute } from './routes/poll.js';

const cfg = loadConfig();
const db = openDb(cfg.DB_PATH);
const ptero = new PteroClient(cfg);
const polls = new PollManager(cfg, db, ptero, ptero.roster);
const limiter = new RateLimiter();
// Separate, more generous bucket for the cheap `check-ign` probe.
const checkIgnLimiter = new RateLimiter({ capacity: 60, refillPerMs: 60 / 60_000 });
const binding = new IgnBinding();
const sse = new SseBroadcaster(200, 4);

function snapshot(): StateSnapshot {
  return {
    online: ptero.roster.get(),
    polls: polls.publicPolls(),
    cooldowns: polls.cooldowns(),
    last_tps: polls.lastTpsValue(),
    server_status: ptero.serverStatus(),
  };
}

function broadcast(): void {
  sse.publish(snapshot());
}

ptero.start();
ptero.roster.onChange(broadcast);
ptero.onStatus(broadcast);
polls.start(broadcast);

// initial publish so any client connecting before first ptero refresh has data
broadcast();

const app = new Hono();
app.use(
  '*',
  cors({
    origin: cfg.ALLOWED_ORIGIN,
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type'],
    credentials: false,
  }),
);

app.get('/healthz', (c) => c.text('ok'));
app.route('/', checkIgnRoute(ptero.roster, checkIgnLimiter));
app.route('/', stateRoute(sse, snapshot));
app.route('/', pollRoute({ polls, limiter, binding, ptero }));

const limiterSweep = setInterval(() => {
  limiter.sweep();
  checkIgnLimiter.sweep();
  binding.sweep();
}, 60_000);

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`aoc2-vote listening on :${info.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  // eslint-disable-next-line no-console
  console.log(`received ${signal}, shutting down`);
  clearInterval(limiterSweep);
  polls.stop();
  ptero.stop();
  server.close(() => {
    db.raw.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
