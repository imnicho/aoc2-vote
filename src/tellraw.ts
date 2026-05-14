/**
 * Pure builder for the in-game vote prompt. Renders a `/tellraw` command
 * targeting only players who haven't voted or abstained yet.
 *
 * Hard constraints:
 *  - selector is `@a[...]` only — never `@e` or any entity selector
 *  - every IGN that flows into a selector or click command is validated
 *    against `IGN_RE` first; anything outside is rejected
 *  - short_id must be Crockford base32 (no I/L/O/U)
 */

export const IGN_RE = /^[A-Za-z0-9_]{3,16}$/;
export const SHORT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export interface BuildPromptInput {
  shortId: string;
  initiator: string;
  actionLabel: string;
  voted: string[];      // IGNs who already cast a vote
  abstained: string[];  // IGNs who clicked SKIP
  rosterSize: number;
  votes: number;        // current vote count
  needed: number;       // current threshold (max(1, rosterSize - abstained))
}

function isValidIgn(s: string): boolean {
  return typeof s === 'string' && IGN_RE.test(s);
}

/**
 * Build the `/tellraw @a[...] [...]` command. Returns `null` if every roster
 * member has already acted (nothing to broadcast) or if any IGN is malformed.
 */
export function buildVotePromptCommand(input: BuildPromptInput): string | null {
  if (!SHORT_ID_RE.test(input.shortId)) return null;
  if (!isValidIgn(input.initiator)) return null;

  // Union of acted IGNs — these get excluded from the broadcast selector.
  const acted = new Set<string>();
  for (const ign of input.voted) {
    if (!isValidIgn(ign)) return null;
    acted.add(ign);
  }
  for (const ign of input.abstained) {
    if (!isValidIgn(ign)) return null;
    acted.add(ign);
  }

  // If the entire roster has acted, no one needs the prompt — bail.
  if (acted.size >= input.rosterSize) return null;

  // Compose the `@a` selector. Minecraft selector arg `name=!<x>` repeats.
  // Selector is `@a` when no exclusions, else `@a[name=!a,name=!b,...]`.
  const exclusions = [...acted].map((ign) => `name=!${ign}`).join(',');
  const selector = exclusions ? `@a[${exclusions}]` : '@a';

  const components = buildVotePromptComponents({
    shortId: input.shortId,
    initiator: input.initiator,
    actionLabel: input.actionLabel,
    votes: input.votes,
    needed: input.needed,
  });

  return `tellraw ${selector} ${JSON.stringify(components)}`;
}

export interface BuildComponentsInput {
  shortId: string;
  initiator: string;
  actionLabel: string;
  votes: number;
  needed: number;
}

/**
 * The raw JSON-text component array. Exported so tests can assert structure
 * without re-parsing the wrapper command.
 */
export function buildVotePromptComponents(
  input: BuildComponentsInput,
): unknown[] {
  const { shortId, initiator, actionLabel, votes, needed } = input;
  return [
    { text: '[VOTE] ', color: 'gold', bold: true },
    { text: initiator, color: 'yellow' },
    { text: ' wants to ' },
    { text: actionLabel, color: 'aqua' },
    { text: ` — ${votes}/${needed} voted\n` },
    { text: '[ ', color: 'gray' },
    {
      text: 'YES',
      color: 'green',
      bold: true,
      clickEvent: { action: 'run_command', value: `/me votes yes ${shortId}` },
      hoverEvent: { action: 'show_text', contents: 'cast your vote' },
    },
    { text: ' ]   [ ', color: 'gray' },
    {
      text: 'SKIP',
      color: 'red',
      bold: true,
      clickEvent: { action: 'run_command', value: `/me skips ${shortId}` },
      hoverEvent: {
        action: 'show_text',
        contents: 'abstain — remove yourself from this poll',
      },
    },
    { text: ' ]', color: 'gray' },
  ];
}

/**
 * Generate a 6-char Crockford base32 short id (no I/L/O/U).
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateShortId(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CROCKFORD[Math.floor(rand() * CROCKFORD.length)];
  }
  return out;
}
