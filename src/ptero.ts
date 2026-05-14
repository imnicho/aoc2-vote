import WebSocket from 'ws';
import type { Config } from './config.js';
import { Roster, parseListLine } from './roster.js';
import { feedLine, makeCaptureState, type TpsCaptureState } from './spark.js';

export type ServerStatus = 'running' | 'starting' | 'offline' | 'unknown';

interface WsCredentials {
  token: string;
  socket: string;
}

type ConsoleListener = (line: string) => void;

interface PendingTps {
  resolve: (value: string | null) => void;
  state: TpsCaptureState;
  timer: NodeJS.Timeout;
}

export class PteroClient {
  private cfg: Config;
  private ws: WebSocket | null = null;
  private wsReady = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private consoleListeners = new Set<ConsoleListener>();
  private pendingTps: PendingTps | null = null;
  private listPollTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private status: ServerStatus = 'unknown';
  private statusListeners = new Set<(s: ServerStatus) => void>();
  private stopped = false;

  readonly roster: Roster;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.roster = new Roster();
  }

  start(): void {
    this.connect().catch(() => this.scheduleReconnect());
    this.listPollTimer = setInterval(() => {
      this.requestList();
    }, this.cfg.ROSTER_REFRESH_MS);
    this.statusTimer = setInterval(() => {
      this.pollStatus().catch(() => undefined);
    }, this.cfg.ROSTER_REFRESH_MS);
    this.pollStatus().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.listPollTimer) clearInterval(this.listPollTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listPollTimer = null;
    this.statusTimer = null;
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  onConsole(fn: ConsoleListener): () => void {
    this.consoleListeners.add(fn);
    return () => this.consoleListeners.delete(fn);
  }

  onStatus(fn: (s: ServerStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  serverStatus(): ServerStatus {
    return this.status;
  }

  /**
   * Send a console command via Pterodactyl client REST API.
   * Used for `say` and action commands.
   */
  async runCommand(command: string): Promise<void> {
    const res = await fetch(
      `${this.cfg.PTERO_BASE}/api/client/servers/${this.cfg.PTERO_SERVER_ID}/command`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.cfg.PTERO_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ command }),
      },
    );
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      throw new Error(`Pterodactyl command failed: ${res.status} ${text}`);
    }
  }

  async power(signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
    const res = await fetch(
      `${this.cfg.PTERO_BASE}/api/client/servers/${this.cfg.PTERO_SERVER_ID}/power`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.cfg.PTERO_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ signal }),
      },
    );
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      throw new Error(`Pterodactyl power failed: ${res.status} ${text}`);
    }
  }

  /**
   * Request a TPS report via spark; resolves with the captured summary line
   * (or null on timeout).
   */
  captureTps(timeoutMs = 8000): Promise<string | null> {
    if (this.pendingTps) {
      // cancel previous
      clearTimeout(this.pendingTps.timer);
      this.pendingTps.resolve(null);
      this.pendingTps = null;
    }
    return new Promise<string | null>((resolve) => {
      const state = makeCaptureState();
      const timer = setTimeout(() => {
        if (this.pendingTps?.state === state) {
          this.pendingTps = null;
        }
        resolve(null);
      }, timeoutMs);
      this.pendingTps = { resolve, state, timer };
      // fire and forget; if WS not ready, fall back to REST command
      this.sendWsCommand('spark tps').catch(() => {
        this.runCommand('spark tps').catch((err) => logPteroError('captureTps', err));
      });
    });
  }

  /**
   * Force an immediate roster refresh.
   */
  requestList(): void {
    this.sendWsCommand('list').catch(() => {
      this.runCommand('list').catch((err) => logPteroError('requestList', err));
    });
  }

  // ---------------- internals ----------------

  private async fetchWsCredentials(): Promise<WsCredentials> {
    const res = await fetch(
      `${this.cfg.PTERO_BASE}/api/client/servers/${this.cfg.PTERO_SERVER_ID}/websocket`,
      {
        headers: {
          'Authorization': `Bearer ${this.cfg.PTERO_TOKEN}`,
          'Accept': 'application/json',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`Websocket credentials fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as { data?: { token?: string; socket?: string } };
    if (!body.data?.token || !body.data?.socket) {
      throw new Error('Websocket credentials missing token/socket');
    }
    return { token: body.data.token, socket: body.data.socket };
  }

  private async pollStatus(): Promise<void> {
    try {
      const res = await fetch(
        `${this.cfg.PTERO_BASE}/api/client/servers/${this.cfg.PTERO_SERVER_ID}/resources`,
        {
          headers: {
            'Authorization': `Bearer ${this.cfg.PTERO_TOKEN}`,
            'Accept': 'application/json',
          },
        },
      );
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[ptero] pollStatus: ${res.status}`);
        this.updateStatus('unknown');
        return;
      }
      const body = (await res.json()) as { attributes?: { current_state?: string } };
      const state = body.attributes?.current_state ?? 'unknown';
      const mapped: ServerStatus =
        state === 'running'
          ? 'running'
          : state === 'starting'
            ? 'starting'
            : state === 'offline' || state === 'stopping'
              ? 'offline'
              : 'unknown';
      this.updateStatus(mapped);
    } catch (err) {
      logPteroError('pollStatus', err);
      this.updateStatus('unknown');
    }
  }

  private updateStatus(s: ServerStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusListeners) {
      try {
        fn(s);
      } catch {
        // ignore
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const creds = await this.fetchWsCredentials();
    const ws = new WebSocket(creds.socket, {
      headers: { Origin: this.cfg.PTERO_BASE },
    });
    this.ws = ws;
    this.wsReady = false;

    ws.on('open', () => {
      this.sendRaw({ event: 'auth', args: [creds.token] });
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => {
      this.wsReady = false;
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private handleMessage(msg: unknown): void {
    if (!isWsMessage(msg)) return;
    switch (msg.event) {
      case 'auth success':
        this.wsReady = true;
        this.reconnectDelay = 1000;
        // Subscribe to console + status, ask for initial list.
        this.sendRaw({ event: 'send logs', args: [null] });
        this.sendRaw({ event: 'send stats', args: [null] });
        this.requestList();
        break;
      case 'token expiring':
      case 'token expired':
        this.refreshToken().catch(() => undefined);
        break;
      case 'console output':
      case 'install output':
      case 'daemon message': {
        const line = msg.args?.[0];
        if (typeof line === 'string') this.handleConsoleLine(line);
        break;
      }
      case 'status': {
        const state = msg.args?.[0];
        if (typeof state === 'string') {
          const mapped: ServerStatus =
            state === 'running'
              ? 'running'
              : state === 'starting'
                ? 'starting'
                : state === 'offline' || state === 'stopping'
                  ? 'offline'
                  : 'unknown';
          this.updateStatus(mapped);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleConsoleLine(line: string): void {
    // roster
    const parsed = parseListLine(line);
    if (parsed) this.roster.set(parsed.players);

    // spark
    if (this.pendingTps) {
      const captured = feedLine(this.pendingTps.state, line);
      if (captured) {
        clearTimeout(this.pendingTps.timer);
        const { resolve } = this.pendingTps;
        this.pendingTps = null;
        resolve(captured);
      }
    }

    for (const fn of this.consoleListeners) {
      try {
        fn(line);
      } catch {
        // ignore
      }
    }
  }

  private async refreshToken(): Promise<void> {
    try {
      const creds = await this.fetchWsCredentials();
      this.sendRaw({ event: 'auth', args: [creds.token] });
    } catch (err) {
      logPteroError('refreshToken', err);
      this.scheduleReconnect();
    }
  }

  private sendRaw(msg: { event: string; args: unknown[] }): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  private async sendWsCommand(command: string): Promise<void> {
    if (!this.wsReady) throw new Error('ws not ready');
    this.sendRaw({ event: 'send command', args: [command] });
  }
}

interface WsMessage {
  event: string;
  args?: unknown[];
}

function isWsMessage(v: unknown): v is WsMessage {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.event === 'string';
}

/**
 * Log a Pterodactyl-side failure to stderr. Strips response bodies after the
 * HTTP status so operator-sensitive payloads from Pterodactyl don't surface,
 * and never echoes the bearer token (which never appears in thrown messages
 * — `runCommand`/`power` only build them from `res.status` and `text`).
 */
function logPteroError(action: string, err: unknown): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const trimmed = message.replace(/(Pterodactyl [^:]+:\s*\d+)\s.*/s, '$1');
  // eslint-disable-next-line no-console
  console.error(`[ptero] ${action}: ${trimmed}`);
}
