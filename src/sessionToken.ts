import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless HMAC-signed token used in two flavours:
 *
 *   kind = 'mint'  — single-use, short-lived link token issued when a player
 *                    joins the game. Consumed at /api/auth/redeem.
 *   kind = 'sess'  — bearer session token. Presented as
 *                    `Authorization: Bearer <token>` on mutating routes.
 *
 * Wire shape (single base64url string):
 *   <kind>.<ign>.<is_operator:0|1>.<expires_ms>.<nonce>.<hex hmac-sha256>
 * The HMAC is taken over the body `kind|ign|is_operator|expires_ms|nonce`
 * (`|` separator so a mint token can never replay as a session — the kind is
 * part of the signed payload).
 */
export type TokenKind = 'mint' | 'sess';

export interface SignedToken {
  token: string;
  expires_at: number;
  nonce: string;
}

export interface VerifiedToken {
  kind: TokenKind;
  ign: string;
  is_operator: boolean;
  expires_at: number;
  nonce: string;
}

export type VerifyError =
  | 'invalid_token'
  | 'token_expired'
  | 'token_kind_mismatch';

const IGN_RE = /^[a-z0-9_]{3,16}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function isKind(v: string): v is TokenKind {
  return v === 'mint' || v === 'sess';
}

export function signSessionToken(
  kind: TokenKind,
  ign: string,
  isOperator: boolean,
  secret: string,
  ttlMs: number,
  now: () => number = Date.now,
  nonce: string = randomBytes(18).toString('base64url'),
): SignedToken {
  const lowered = ign.toLowerCase();
  const expiresAt = now() + ttlMs;
  const op = isOperator ? '1' : '0';
  const body = `${kind}|${lowered}|${op}|${expiresAt}|${nonce}`;
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const raw = `${kind}.${lowered}.${op}.${expiresAt}.${nonce}.${sig}`;
  return {
    token: Buffer.from(raw, 'utf8').toString('base64url'),
    expires_at: expiresAt,
    nonce,
  };
}

export function verifySessionToken(
  token: string,
  expectedKind: TokenKind,
  secret: string,
  now: () => number = Date.now,
): { ok: true; value: VerifiedToken } | { ok: false; err: VerifyError } {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return { ok: false, err: 'invalid_token' };
  }
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return { ok: false, err: 'invalid_token' };
  }
  const parts = raw.split('.');
  if (parts.length !== 6) return { ok: false, err: 'invalid_token' };
  const [kindStr, ign, opStr, expStr, nonce, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!kindStr || !ign || !opStr || !expStr || !nonce || !sig) {
    return { ok: false, err: 'invalid_token' };
  }
  if (!isKind(kindStr)) return { ok: false, err: 'invalid_token' };
  if (!IGN_RE.test(ign)) return { ok: false, err: 'invalid_token' };
  if (opStr !== '0' && opStr !== '1') return { ok: false, err: 'invalid_token' };
  if (!NONCE_RE.test(nonce)) return { ok: false, err: 'invalid_token' };
  const expiresAt = Number.parseInt(expStr, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, err: 'invalid_token' };
  }

  const body = `${kindStr}|${ign}|${opStr}|${expiresAt}|${nonce}`;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return { ok: false, err: 'invalid_token' };
  }
  if (sigBuf.length !== expBuf.length || sigBuf.length === 0) {
    return { ok: false, err: 'invalid_token' };
  }
  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, err: 'invalid_token' };
  }
  // Kind check happens AFTER signature so a tampered-kind token still reports
  // invalid_token rather than leaking that the signature was otherwise valid.
  if (kindStr !== expectedKind) {
    return { ok: false, err: 'token_kind_mismatch' };
  }
  if (expiresAt <= now()) return { ok: false, err: 'token_expired' };
  return {
    ok: true,
    value: {
      kind: kindStr,
      ign,
      is_operator: opStr === '1',
      expires_at: expiresAt,
      nonce,
    },
  };
}

/**
 * Tracks consumed mint-token nonces so a one-time token cannot be redeemed
 * twice. Entries are evicted on demand (the nonce is dropped after the token's
 * own expiry — there's no point retaining it longer since the signature check
 * will reject any later attempt anyway).
 */
export class ConsumedNonceStore {
  private readonly map = new Map<string, number>();

  /**
   * Returns true if the nonce was fresh (and is now marked consumed), false
   * if it had already been used within the still-valid window.
   */
  consume(nonce: string, expiresAt: number, now: () => number = Date.now): boolean {
    const t = now();
    const existing = this.map.get(nonce);
    if (existing !== undefined && existing > t) return false;
    this.map.set(nonce, expiresAt);
    return true;
  }

  /** Drop entries whose expiry has passed. */
  sweep(now: () => number = Date.now): void {
    const t = now();
    for (const [k, exp] of this.map) {
      if (exp <= t) this.map.delete(k);
    }
  }

  size(): number {
    return this.map.size;
  }
}
