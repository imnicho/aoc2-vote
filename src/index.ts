import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AfkTracker } from './afkTracker.js';
import { loadConfig } from './config.js';
import { DashboardCommandParser } from './dashboardCommandParser.js';
import { openDb } from './db.js';
import { OperatorExec } from './operatorExec.js';
import { PteroClient } from './ptero.js';
import { PollManager } from './poll.js';
import { RateLimiter } from './rateLimit.js';
import { ConsumedNonceStore } from './sessionToken.js';
import { SseBroadcaster, type StateSnapshot } from './sse.js';
import { VoteParser } from './voteParser.js';
import { WelcomeFlow } from './welcomeFlow.js';
import { authRoute } from './routes/auth.js';
import { stateRoute } from './routes/state.js';
import { pollRoute } from './routes/poll.js';
import { opRoute } from './routes/op.js';

const cfg = loadConfig();
const db = openDb(cfg.DB_PATH);
const ptero = new PteroClient(cfg);
const polls = new PollManager(cfg, db, ptero, ptero.roster);
const limiter = new RateLimiter();
// Auth redemption: 30/min/IP (clicking the welcome link from chat is cheap).
const authLimiter = new RateLimiter({ capacity: 30, refillPerMs: 30 / 60_000 });
// Op execute: 20/min/IP.
const opExecuteLimiter = new RateLimiter({ capacity: 20, refillPerMs: 20 / 60_000 });
const sse = new SseBroadcaster(200, 4);
const ops = new OperatorExec({ cfg, ptero, polls });
const consumed = new ConsumedNonceStore();
const welcome = new WelcomeFlow({ cfg, roster: ptero.roster, ptero });
const afkTracker = new AfkTracker(ptero.roster);

function snapshot(): StateSnapshot {
  return {
    online: ptero.roster.get(),
    afk: ptero.roster.afkList(),
    polls: polls.publicPolls(),
    cooldowns: polls.cooldowns(),
    last_tps: polls.lastTpsValue(),
    server_status: ptero.serverStatus(),
    operator_enabled: cfg.OPERATOR_IGNS.length > 0 && cfg.SESSION_SECRET !== null,
    uptime_ms: ptero.uptimeMs(),
    ping_ms: ptero.pingMs(),
  };
}

function broadcast(): void {
  sse.publish(snapshot());
}

ptero.start();
// Pause expensive polling when no one is watching the dashboard.
sse.onActivityChange((active) => {
  // eslint-disable-next-line no-console
  console.info(`[ptero] poll ${active ? 'resumed' : 'paused'} (subscribers=${sse.size()})`);
  ptero.setActive(active);
});
ptero.roster.onChange(broadcast);
ptero.onStatus(broadcast);
ptero.onResources(broadcast);
ptero.onTpsAuto((value) => {
  polls.setLastTps(value);
  broadcast();
});
polls.start(broadcast);
welcome.start();
afkTracker.start();
// A roster-join is an unambiguous activity signal: clear any stale AFK flag
// and seed the activity timestamp.
ptero.roster.onPlayerJoin((ign) => afkTracker.recordActivity(ign));

const voteParser = new VoteParser(polls);
const dashboardParser = new DashboardCommandParser(ptero.roster, welcome);
ptero.onConsole((line) => {
  afkTracker.handleLine(line);
  voteParser.handleLine(line);
  dashboardParser.handleLine(line);
});

// initial publish so any client connecting before first ptero refresh has data
broadcast();

const app = new Hono();
app.use(
  '*',
  cors({
    origin: cfg.ALLOWED_ORIGIN,
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  }),
);

app.get('/healthz', (c) => c.text('ok'));
app.route('/', authRoute({ cfg, limiter: authLimiter, consumed }));
app.route('/', stateRoute(sse, snapshot));
app.route('/', pollRoute({ cfg, polls, limiter, ptero }));
app.route('/', opRoute({ cfg, ops, executeLimiter: opExecuteLimiter }));

const limiterSweep = setInterval(() => {
  limiter.sweep();
  authLimiter.sweep();
  opExecuteLimiter.sweep();
  consumed.sweep();
}, 60_000);

// Dry-run quality-of-life: simulate `nicho joined the game` shortly after
// boot so the welcome flow logs a usable token link in /tmp/aoc2-vote.log.
// The mock roster initialised by ptero.start() already includes nicho, so we
// briefly remove + re-add to trigger the join event (and exercise the same
// codepath a real `<ign> joined the game` console line would take).
if (cfg.PTERO_DRY_RUN) {
  setTimeout(() => {
    const ign = cfg.PTERO_MOCK_ROSTER[0] ?? 'nicho';
    ptero.roster.removePlayer(ign);
    ptero.roster.addPlayer(ign);
  }, 500);
}

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`aoc2-vote listening on :${info.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  // eslint-disable-next-line no-console
  console.log(`received ${signal}, shutting down`);
  clearInterval(limiterSweep);
  afkTracker.stop();
  welcome.stop();
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
