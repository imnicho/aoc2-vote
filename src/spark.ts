/**
 * spark `/spark tps` output looks like (one line per timeframe block):
 *   TPS from last 5s, 10s, 1m, 5m, 15m:
 *       *20.0, *20.0, *20.0, 19.97, 19.95
 *
 * We capture the header line plus the next non-empty line of values and
 * collapse them into a single string for SSE.
 *
 * Regex matches the header on a single console line:
 *   TPS from last 5s, 10s, 1m: 20.0, 20.0, 19.97
 * OR just the header with the values on the next line. We accept both.
 */
export const TPS_HEADER_REGEX = /TPS from last\s+([^:]+):\s*(.*)$/;
export const TPS_VALUES_REGEX = /([\d.*,\s]+\d)/;

export interface TpsCaptureState {
  awaitingValues: boolean;
  header: string | null;
  result: string | null;
}

export function makeCaptureState(): TpsCaptureState {
  return { awaitingValues: false, header: null, result: null };
}

/**
 * Feed one console line. Returns the captured TPS summary string when complete,
 * or null while still collecting / no match.
 */
export function feedLine(state: TpsCaptureState, line: string): string | null {
  const stripped = stripPrefixes(line);
  const m = TPS_HEADER_REGEX.exec(stripped);
  if (m) {
    const window = (m[1] ?? '').trim();
    const tail = (m[2] ?? '').trim();
    if (tail.length > 0 && TPS_VALUES_REGEX.test(tail)) {
      // Values on same line.
      const cleaned = cleanValues(tail);
      state.result = `TPS from last ${window}: ${cleaned}`;
      state.awaitingValues = false;
      state.header = null;
      return state.result;
    }
    state.awaitingValues = true;
    state.header = window;
    return null;
  }
  if (state.awaitingValues) {
    const trimmed = stripped.trim();
    if (trimmed.length === 0) return null;
    if (TPS_VALUES_REGEX.test(trimmed)) {
      const cleaned = cleanValues(trimmed);
      state.result = `TPS from last ${state.header}: ${cleaned}`;
      state.awaitingValues = false;
      state.header = null;
      return state.result;
    }
    // Unexpected non-empty line — abandon capture.
    state.awaitingValues = false;
    state.header = null;
  }
  return null;
}

function cleanValues(s: string): string {
  // spark prefixes "good" measurements with `*` (and ANSI colour). Strip both.
  return s.replace(/\[[0-9;]*m/g, '').replace(/\*/g, '').trim();
}

function stripPrefixes(line: string): string {
  // Pterodactyl console lines often start with timestamps / log level tags.
  // Strip a leading "[hh:mm:ss INFO]: " or similar prefix if present.
  return line.replace(/^\s*\[[^\]]*\]:?\s*/, '').replace(/\[[0-9;]*m/g, '');
}
