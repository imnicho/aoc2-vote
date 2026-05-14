import type { Context } from 'hono';

/**
 * Extract the client IP for a request that may have transited Traefik/Coolify.
 *
 * Header semantics:
 *   - `X-Real-IP` (when present) is set by Traefik to the actual client and
 *     takes precedence.
 *   - Traefik *appends* to `X-Forwarded-For` rather than overwriting it, so the
 *     rightmost entry is the trusted IP. Reading the leftmost entry would let
 *     a remote attacker spoof their address by sending the header themselves.
 *   - As a last resort, fall back to the connection-level peer address. If
 *     that's unavailable we return the string `'unknown'`.
 */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real) {
    const trimmed = real.trim();
    if (trimmed) return trimmed;
  }

  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const parts = fwd
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) return remote;

  return 'unknown';
}
