# aoc2-vote

Backend service for the AoC2 player-voting page on `nicho.wtf`. Talks to a
Pterodactyl-managed Minecraft server (`a7f365e9` on Godlike), keeps a live
roster, runs short consensus polls, and exposes a small HTTP + SSE API to
the static frontend.

The wire contract is the source of truth and lives at
`game-modding/Minecraft/aoc2/.orchestrate/api-contract.md`.

## Run

```bash
# install once
npm install

# build TS -> dist/, then start
npm run build && PTERO_BASE=https://panel.godlike.host PTERO_SERVER_ID=a7f365e9 PTERO_TOKEN=ptlc_xxx ALLOWED_ORIGIN=https://nicho.wtf npm start
```

## Endpoints

| Method | Path                          | Description |
|-------:|-------------------------------|-------------|
| POST   | `/api/auth/redeem`            | Exchange a one-time mint token (from the in-game welcome tellraw) for a 4-h bearer session. Body: `{token}` |
| GET    | `/api/state`                  | SSE stream; emits `state` events whenever roster, polls, cooldowns, or last-TPS change. Public — no bearer needed. |
| POST   | `/api/poll`                   | Open a vote for an action. Header: `Authorization: Bearer <session>`. Body: `{action}` |
| POST   | `/api/poll/:id/vote`          | Cast a vote. Header: `Authorization: Bearer <session>`. Body: `{}` |
| POST   | `/api/op/execute`             | Run an enum action solo. Header: `Authorization: Bearer <session>` (session must carry `is_operator:true`). Body: `{action}` |
| GET    | `/healthz`                    | Liveness probe |

Actions: `weather_clear`, `item_cleanup`, `day`, `night`, `tps`, `save_all`, `gather_at_spawn`, `restart`.

## Env vars

All required unless a default is shown. Boot fails fast if a required var is
missing.

| Var                  | Default                | Notes |
|----------------------|------------------------|-------|
| `PTERO_BASE`         | —                      | e.g. `https://panel.godlike.host` |
| `PTERO_SERVER_ID`    | —                      | Pterodactyl server slug |
| `PTERO_TOKEN`        | —                      | client-API token (`ptlc_...`) |
| `ALLOWED_ORIGIN`     | —                      | CORS allow-list, single origin |
| `PORT`               | `3000`                 | listen port |
| `DB_PATH`            | `/data/aoc2-vote.db`   | SQLite file (Coolify volume) |
| `POLL_TTL_MS`        | `300000` (5 min)       | poll expiry |
| `COOLDOWN_MS`        | `600000` (10 min)      | per-action cooldown after passing/expiring |
| `ROSTER_REFRESH_MS`  | `5000`                 | how often to send `list` and poll resources |
| `OPERATOR_IGNS`      | (empty)                | comma-separated allowlist of IGNs that receive `is_operator:true` in their session token. Lowercased on parse. Empty disables operator-mode entirely. |
| `SESSION_SECRET`     | —                      | 32+ byte random secret used to sign HMAC mint + session tokens. Required outside dry-run. |
| `SESSION_TTL_MS`     | `14400000` (4 h)       | bearer session lifetime |
| `MINT_TTL_MS`        | `300000` (5 min)       | one-time mint-token (the `?t=...` link from chat) lifetime |
| `PUBLIC_BASE_URL`    | `https://nicho.wtf`    | base URL embedded in the welcome tellraw link |
| `PTERO_DRY_RUN`      | `false`                | local-dev mode; see "Dry-run mode" below |
| `PTERO_MOCK_ROSTER`  | `nicho` (in dry-run)   | comma-separated mock roster used when `PTERO_DRY_RUN=true` |
| `SPAWN_X`            | `-1780`                | world-spawn X for `gather_at_spawn` |
| `SPAWN_Y`            | `117`                  | world-spawn Y for `gather_at_spawn` |
| `SPAWN_Z`            | `1187`                 | world-spawn Z for `gather_at_spawn` |

## Auth model

There is no password, PIN, or IGN-IP binding. Authentication is bootstrapped
from the Minecraft server itself:

1. Player joins the server. Console emits `<ign> joined the game`.
2. Service mints a one-time **mint token** (HMAC-signed, 5 min TTL) and
   dispatches a private `tellraw @a[name=<ign>] ...` with a clickable link
   like `https://nicho.wtf/aoc2/vote?t=<mint>`.
3. Player clicks the link. Browser POSTs the mint token to
   `/api/auth/redeem`; service exchanges it for a 4-hour **session token**
   (also HMAC-signed) carrying `{ign, is_operator}`.
4. All mutating routes require `Authorization: Bearer <session>`.

If a player misses the chat link they can type `/dashboard` in chat at any
time and the service replies with a fresh mint-token link (rate-limited to
3/min/IGN). The `/dashboard` command is provided by the small server-side
`aoc2-dashboard` NeoForge mod, which runs `/dashboard` under the hood —
the legacy `/dashboard` emote still works as a fallback.

Operators are site-only (not Minecraft `/op`s). When an IGN appears in
`OPERATOR_IGNS`, its session carries `is_operator:true` and the frontend
shows the op-mode toggle. The op route checks this flag from the verified
bearer — no PIN, no separate token.

Hard constraint: there is no "raw command" endpoint — `POST /api/op/execute`
takes a single `{"action":"..."}` field that must match the closed enum
exactly. The session token never confers the ability to send arbitrary
console input.

Both token kinds use the same HMAC-SHA256 + constant-time-compare path; the
kind (`mint` or `sess`) is part of the signed body so a mint token cannot
be replayed as a session.

### Migration from the PIN flow

The legacy `operators` SQLite table (bcrypt PINs) is dropped on first boot
after the redesign. Existing operators don't need to do anything special —
they just click the welcome link the next time they join. No DB migration
script is needed.

## Dry-run mode

Set `PTERO_DRY_RUN=true` for local development without a real Pterodactyl
server:

- The roster is sourced from `PTERO_MOCK_ROSTER` (comma-separated IGNs),
  defaulting to `nicho`.
- `runCommand` and `power` log `[dry-run] cmd=<x>` to stdout and resolve OK.
- `captureTps` returns `"DRY-RUN: TPS 20.0/20.0/20.0"` after ~200ms.
- No websocket is opened, no HTTP calls to Pterodactyl are made.
- World spawn comes from the `SPAWN_X/Y/Z` env vars (or built-in defaults).

Safety net: boot fails if `PTERO_DRY_RUN=true` is combined with any
`ALLOWED_ORIGIN` other than a `localhost` / `127.0.0.1` URL — so the dry-run
build can't be deployed against production CORS by accident.

## World spawn lookup

The `gather_at_spawn` action teleports every currently-online player (always
`@a`, never any other selector) to the world spawn. The coordinates are read
from the `SPAWN_X` / `SPAWN_Y` / `SPAWN_Z` env vars at boot (defaults
`-1780 / 117 / 1187`). Change them in Coolify and redeploy to pick up a
new spawn.

## Behavior

- Roster: opens a websocket to Pterodactyl, sends `list` every
  `ROSTER_REFRESH_MS`, parses `There are N of a max of M players online: ...`.
  Falls back to REST `POST /command` if the websocket is down.
- A poll's `needed` count is recomputed at every vote: it is the number of
  currently-online players. Voters who log off stay in `voters` but no longer
  count, so a poll auto-passes when all remaining-online players have voted.
- The initiator's vote is auto-recorded. If the initiator is the only online
  player, the action runs immediately.
- All `say` messages are plain ASCII; no Minecraft section-sign formatting is
  forwarded.
- On startup any leftover `open` polls whose `expires_at` has passed are
  marked `expired` and their cooldown is started.

## In-game voting

Players don't have to leave Minecraft to vote. When a poll opens — and again
on every state change while it's still open — the service posts a `tellraw`
into the server console targeting only players who haven't acted yet:

```
[VOTE] nicho wants to clear the weather — 1/3 voted
[ YES ]   [ SKIP ]
```

`YES` records a vote (same effect as clicking on the web page). `SKIP` marks
the player as abstaining and removes them from the threshold denominator —
3 online, 1 SKIP, 2 YES is enough to pass.

How it works:

- Each open poll gets a 6-char [Crockford base32](https://www.crockford.com/base32.html)
  `short_id` (no I/L/O/U). It's unique across currently-open polls.
- The buttons use `clickEvent.run_command` with `/me votes yes <shortId>` and
  `/me skips <shortId>`. `/me` is the cheapest emote that surfaces on console
  as `* <ign> votes yes <ABCDEF>` — Mojang has already authenticated the IGN
  for us by the time it reaches the websocket.
- The console parser strips the Pterodactyl prefix, runs a strict regex
  against the payload, and calls `PollManager.castVote` / `abstain`. A soft
  per-IGN rate limit of 5 actions/min/IGN keeps spam clicks from cascading.
- Selectors are `@a` only — never `@e`. Every IGN is validated against
  `^[A-Za-z0-9_]{3,16}$` before it can flow into a selector or a command.
- Abstainers live in memory and reset on boot — that's intentional for v1.

`PublicPoll` exposes the new fields `short_id` and `abstained` (count only,
no IGN list) over SSE.

## Spark TPS capture

Single regex used to detect the spark TPS header line in console output:

```
/TPS from last\s+([^:]+):\s*(.*)$/
```

It matches both the single-line shape:

```
TPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97
```

and the spark-default split shape (header on one line, values on the next).
The capture strips a leading Pterodactyl log prefix (`[12:34:56 INFO]: `),
strips ANSI colour escapes, and removes spark's `*` "good-value" marker
before joining the parts as `TPS from last <window>: <values>`.

## Running locally without a real Pterodactyl

Point `PTERO_BASE` at any HTTP server that returns a small stub for
`/api/client/servers/<id>/websocket` (an object with `data.token` and
`data.socket`) and a stub for `/resources`. The roster will simply stay
empty until console output starts arriving. Unit tests cover the pure parts
(actions, list parsing, spark regex) without any network.

## Tests

```bash
npm test
```

Coverage: `actions.ts`, `roster.ts` (list parsing + join/leave),
`spark.ts` (TPS regex), `sessionToken.ts` (sign/verify roundtrip, tampered,
expired, kind mismatch, nonce replay), `auth.ts` middleware,
`welcomeFlow.ts`, `operatorExec.ts`, `clientIp.ts`, and transactional/poll
error paths via `node --test`.

## Deployment notes

This service **must** run behind a reverse proxy that strips inbound
`X-Forwarded-For` and rewrites it to the real client IP (Traefik in Coolify
appends to XFF rather than overwriting, so the rightmost entry is the
trusted one; `X-Real-IP`, when present, takes precedence). Exposing the
container directly to the internet will misattribute every request to whatever
the client sends, defeating the per-IP rate limiter.

## Docker

```bash
docker build -t aoc2-vote .
docker run --rm -p 3000:3000 \
  -e PTERO_BASE=https://panel.godlike.host \
  -e PTERO_SERVER_ID=a7f365e9 \
  -e PTERO_TOKEN=ptlc_xxx \
  -e ALLOWED_ORIGIN=https://nicho.wtf \
  -v aoc2-vote-data:/data \
  aoc2-vote
```
