import { and, eq, or } from 'drizzle-orm';
import { db } from '../db';
import { agents, relationships } from '../db/schema';
import { canBeAttractedTo, isAdultAge } from '../lib/intimacy/eligibility';
import { committedTo } from '../lib/intimacy/committed';
import { getAgentIntimacy, getPairIntimacy } from '../lib/intimacy/state';
import { ENGAGED_TAG, MARRIED_TAG } from '../lib/marriage';
import { isAdultContent } from '../lib/worldRules';
import { addressName } from './names';

/**
 * What a speaker privately knows about their history with the person in front of
 * them, as at most two second-person lines for the relationship block of the
 * dialogue prompt ("You and Rosa are lovers; nobody may know.").
 *
 * The model cannot act on a secret it was never told: without these lines a
 * married woman who spent the night with the baker chats to him like any
 * acquaintance, and his wife's name never crosses her mind. States already have
 * their own prompt lines (afterglow, guilty, suspicious: STATE_DEFINITIONS), so
 * nothing here restates a mood; this is the *fact* of the pair.
 *
 * Content lines, held by the tests:
 * - adults only. If either party is under 18 the result is empty, whatever the
 *   tags say (the same fail-closed `isAdultAge` the rest of the layer uses);
 * - the wording never goes past "kissed" / "lovers": what a night held is not
 *   described here or anywhere else;
 * - the adult-only lines (lovers, longing) need the `adultContent` rule on.
 *   A kiss is PG and always on.
 *
 * `intimacyLines` is a pure function of `IntimacyContext`; `intimacyLinesFor`
 * gathers that context (in-memory intimacy state, a couple of indexed lookups
 * only when a line could actually use them) for the prompt builder.
 */

/** How the speaker is bound to somebody who is not the person they are talking to. */
type BondKind = 'married' | 'engaged' | 'partner';

export interface IntimacyContext {
  /** The `adultContent` rule, read once by the caller. */
  adultContent: boolean;
  /** The pair's relationship tags (`kissed`, `lovers`, `crush`...). */
  tags: readonly string[];
  /** Number of nights they have spent together (pair state, in-memory). */
  trysts: number;
  /** Nobody in town knows about them (yet). */
  secret: boolean;
  /** The speaker's longing, 0..100. */
  longing: number;
  /** The speaker is drawn to the listener (orientation fits and the feeling is real). */
  drawn: boolean;
  /** Somebody else the speaker is committed to (spouse, fiance(e), partner). */
  ownBond: { name: string; kind: BondKind } | null;
  /** Somebody else the listener is committed to. */
  otherBond: { name: string } | null;
}

interface IntimacyParty {
  age: number;
}

const KISSED = 'kissed';
const LOVERS = 'lovers';
const ACHE_THRESHOLD = 70;
const MAX_INTIMACY_LINES = 2;

const bondPhrase = (kind: BondKind, name: string): string =>
  kind === 'married' ? `You are married to ${name}; if this came out it would ruin you.`
    : kind === 'engaged' ? `You are engaged to ${name}; if this came out it would break the engagement.`
      : `You are together with ${name}; if this came out it would break their heart.`;

export function intimacyLines(
  self: IntimacyParty,
  other: IntimacyParty & { name: string },
  ctx: IntimacyContext,
): string[] {
  if (!isAdultAge(self.age) || !isAdultAge(other.age)) return [];
  const kissed = ctx.tags.includes(KISSED);
  const lovers = ctx.adultContent && (ctx.tags.includes(LOVERS) || ctx.trysts > 0);

  // Priority order; the first two survive.
  const lines: string[] = [];
  if (lovers) {
    lines.push(ctx.secret
      ? `You and ${other.name} are lovers; nobody may know.`
      : `You and ${other.name} are lovers.`);
  } else if (kissed) {
    lines.push(`You have kissed ${other.name}.`);
  }
  if (ctx.ownBond && (kissed || lovers)) lines.push(bondPhrase(ctx.ownBond.kind, ctx.ownBond.name));
  if (ctx.adultContent && ctx.drawn && ctx.longing >= ACHE_THRESHOLD) lines.push(`You ache for ${other.name}.`);
  if (ctx.drawn && ctx.otherBond) lines.push(`${other.name} is already spoken for by ${ctx.otherBond.name}.`);
  return lines.slice(0, MAX_INTIMACY_LINES);
}

/** The bond between two agents, as the tags say (the strongest one). */
function bondKindBetween(a: number, b: number): BondKind {
  const row = db.select({ tags: relationships.tags }).from(relationships)
    .where(or(
      and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)),
      and(eq(relationships.agent_a, b), eq(relationships.agent_b, a)),
    )).get();
  const tags = row?.tags ?? [];
  return tags.includes(MARRIED_TAG) ? 'married' : tags.includes(ENGAGED_TAG) ? 'engaged' : 'partner';
}

function bondOf(agentId: number, except: number): { name: string; kind: BondKind } | null {
  const id = committedTo(agentId, except);
  if (id === null) return null;
  const row = db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get();
  return row ? { name: addressName(row.name), kind: bondKindBetween(agentId, id) } : null;
}

interface IntimacySelf extends IntimacyParty {
  id: number;
  gender: string;
  orientation?: string | null;
}

interface IntimacyOther extends IntimacyParty {
  id: number;
  gender: string;
}

/**
 * The lines for one speaker about one listener. `romance` is the speaker's own
 * feeling for the listener and `tags` the pair's tags (both from the relationship
 * row the prompt already holds); `otherName` is the spoken name the rest of the
 * relationship block uses. Reads the rule once, and touches the DB only when a
 * line could use it, since this runs on every dialogue turn.
 */
export function intimacyLinesFor(
  self: IntimacySelf,
  other: IntimacyOther,
  otherName: string,
  tags: readonly string[],
  romance: number,
): string[] {
  if (!isAdultAge(self.age) || !isAdultAge(other.age)) return [];
  const adultContent = isAdultContent();
  const pair = getPairIntimacy(self.id, other.id);
  const trysts = pair?.trysts ?? 0;
  const affair = tags.includes(KISSED) || tags.includes(LOVERS) || trysts > 0;
  const drawn = canBeAttractedTo(self, other) && (romance > 35 || tags.includes('crush'));
  const ctx: IntimacyContext = {
    adultContent,
    tags,
    trysts,
    secret: pair?.secret === true,
    longing: getAgentIntimacy(self.id)?.longing ?? 0,
    drawn,
    ownBond: affair ? bondOf(self.id, other.id) : null,
    otherBond: drawn ? bondOf(other.id, self.id) : null,
  };
  return intimacyLines(self, { ...other, name: otherName }, ctx);
}
