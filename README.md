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
| GET    | `/api/check-ign?ign=NAME`     | Is the IGN currently in the online roster? |
| GET    | `/api/state`                  | SSE stream; emits `state` events whenever roster, polls, cooldowns, or last-TPS change |
| POST   | `/api/poll`                   | Open a vote for an action. Body: `{ign, action}` |
| POST   | `/api/poll/:id/vote`          | Cast a vote. Body: `{ign}` |
| GET    | `/healthz`                    | Liveness probe |

Actions: `weather_clear`, `item_cleanup`, `day`, `night`, `tps`, `save_all`, `restart`.

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

Coverage: `actions.ts`, `roster.ts` (list parsing), `spark.ts` (TPS regex),
`ignBinding.ts`, `clientIp.ts`, and transactional/poll error paths via
`node --test`.

## Deployment notes

This service **must** run behind a reverse proxy that strips inbound
`X-Forwarded-For` and rewrites it to the real client IP (Traefik in Coolify
appends to XFF rather than overwriting, so the rightmost entry is the
trusted one; `X-Real-IP`, when present, takes precedence). Exposing the
container directly to the internet will misattribute every request to whatever
the client sends, defeating the per-IP rate limiter and the IGN→IP soft
binding.

`POST /api/poll` and `POST /api/poll/:id/vote` soft-bind the supplied IGN to
the source IP for a 10-minute sliding window. While a binding is live, the
same IGN may not act from a different IP — the route returns
`403 {"error":"ign_ip_mismatch"}`. The binding is in-memory only and is
forgotten across restarts; first-touch from any IP is allowed.

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
