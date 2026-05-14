import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { clientIp } from '../clientIp.js';
import type { SseBroadcaster, StateSnapshot } from '../sse.js';

export function stateRoute(
  sse: SseBroadcaster,
  snapshot: () => StateSnapshot,
): Hono {
  const app = new Hono();
  app.get('/api/state', (c) => {
    const ip = clientIp(c);
    const reservation = sse.reserve(ip);
    if (!reservation.ok) {
      if (reservation.reason === 'per_ip') {
        return c.json({ error: 'rate_limited' }, 429);
      }
      return c.text('Too many subscribers', 503);
    }
    return streamSSE(c, async (stream) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        reservation.release();
      };
      // initial event
      await stream.writeSSE({ event: 'state', data: JSON.stringify(snapshot()) });
      const sub = sse.subscribe((payload) => {
        stream.writeSSE({ event: 'state', data: payload }).catch(() => undefined);
      });
      if (!sub.ok) {
        release();
        await stream.close();
        return;
      }
      const hb = setInterval(() => {
        stream.write(':hb\n\n').catch(() => undefined);
      }, 20_000);
      stream.onAbort(() => {
        clearInterval(hb);
        sub.unsubscribe();
        release();
      });
      // Hold the stream open until aborted.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(hb);
      sub.unsubscribe();
      release();
    });
  });
  return app;
}
