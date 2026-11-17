/**
 * What a speaker can see, or knows, about the person in front of them.
 *
 * Why this exists. The dialogue prompt gave the model only the SPEAKER's own
 * states, so a neighbour stopped a feverish man in the street to talk about the
 * weather, chatted brightly to a widow the day after the funeral, and greeted a
 * man just out of jail as if he had been away on a trip. A real townsperson
 * sees some of it at a glance and has heard the rest. One or two short lines:
 *
 *   - visible to anyone, always: ill, in mourning (and for whom — a death is
 *     the town's news), drunk, low, new in town, out of work (a trade is public);
 *   - known only through what the speaker holds: just out of jail (the `released`
 *     or `arrest` fact), in debt (the `debt` fact, a loan to them, or living with
 *     them), thinking of leaving or their birthday (close friends and family),
 *     a feud and its sides (once it is a town feud, or when the speaker is in it).
 *
 * Never the content of a secret, never the adult layer: a feud's cause is not
 * named, and a minor is told nothing of a feud that grew out of a betrayal.
 *
 * `partnerViewLine` is pure (the template tier and tests read it); `partnerViewFor`
 * does the reads. A small ledger of recent news (out of jail, out of work, a
 * birthday) is kept here from simEvents, in game minutes, per world
 * (cleared by worldCaches.ts).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { agents, agentStates, loans, relationships, shared_knowledge, worldState } from '../db/schema';
import { firstName, pronounsFor, type Pronouns } from '../ai/names';
import { simEvents } from './simEvents';
import { gameMinutesNow } from './worldClock';
import { isNewcomer } from './newcomers';
import { isAdultAge } from './intimacy/eligibility';
import { leavingThoughts } from './populationFlow';
import { activeFeuds, stanceIn } from './factions/store';
import { JOBLESS } from './careers';
import type { ChatNews } from '../data/smallTalkScripts';

const HOUR = 60;
const DAY = 24 * HOUR;

/** News stays "recent" this long. */
const NEWS_FRESH_MIN = { released: 2 * DAY, lostJob: 3 * DAY, birthday: 20 * HOUR } as const;
type NewsKind = keyof typeof NEWS_FRESH_MIN;

const news = new Map<number, Partial<Record<NewsKind, number>>>();

export function clearPartnerNews(): void {
  news.clear();
}

export function notePartnerNews(agentId: number, kind: NewsKind, nowMin: number): void {
  news.set(agentId, { ...(news.get(agentId) ?? {}), [kind]: nowMin });
}

function fresh(agentId: number, kind: NewsKind, nowMin: number): boolean {
  const at = news.get(agentId)?.[kind];
  return at != null && nowMin >= at && nowMin - at < NEWS_FRESH_MIN[kind];
}

/** How the partner's place in a feud reads to the speaker. */
export interface FeudView {
  /** The partner is one of the two who fell out (with `other`), or took `withName`'s side against `other`. */
  role: 'principal' | 'side';
  withName: string;
  other: string;
  /** Where the speaker stands relative to the partner. */
  speaker: 'same' | 'opposite' | 'neutral' | 'none';
}

export interface PartnerView {
  sick?: boolean;
  /** Mourning: the dead's name, or '' when unknown. */
  grievingFor?: string;
  drunk?: boolean;
  low?: boolean;
  newcomer?: boolean;
  outOfWork?: boolean;
  justReleased?: boolean;
  inDebt?: boolean;
  leaving?: boolean;
  birthday?: boolean;
  feud?: FeudView;
}

export { pronounsFor };
export type { Pronouns };

function join(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * At most two short lines ("[You can see] …", "[You know] …"), or null when
 * there is nothing to say. Kept short on purpose: the context is pinned at 8192
 * tokens and the prompt is already long.
 */
export function partnerViewLine(v: PartnerView, otherFirst: string, p: Pronouns): string | null {
  const seen: string[] = [];
  if (v.sick) seen.push('looks ill');
  if (v.grievingFor != null) seen.push(v.grievingFor ? `is in mourning for ${v.grievingFor}` : 'is in mourning');
  if (v.drunk) seen.push('has had a good deal to drink');
  if (v.low && !v.grievingFor) seen.push('looks low');
  if (v.newcomer) seen.push('is new in town');
  if (v.outOfWork) seen.push(`has just lost ${p.pos} work`);

  const known: string[] = [];
  if (v.birthday) known.push(`it is ${p.pos} birthday today`);
  if (v.justReleased) known.push(`${p.subj} ${p.be} just out of jail`);
  if (v.inDebt) known.push(`${p.subj} ${p.be} in debt`);
  if (v.leaving) known.push(`${p.subj} ${p.be} thinking of leaving town`);
  if (v.feud) {
    const f = v.feud;
    const side = f.withName === 'you' ? 'your side' : `${f.withName}'s side`;
    const where = f.role === 'principal' ? `${p.subj} ${p.be} at odds with ${f.other}` : `${p.subj} took ${side} against ${f.other}`;
    const you = f.speaker === 'same' ? ', and you stand with them'
      : f.speaker === 'opposite' ? `, and you are on the other side`
        : f.speaker === 'neutral' ? ', and you have kept out of it' : '';
    known.push(`${where}${you}`);
  }
  const lines: string[] = [];
  if (seen.length) lines.push(`[You can see] ${otherFirst} ${join(seen)}.`);
  if (known.length) {
    const s = join(known);
    lines.push(`[You know] ${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
  }
  return lines.length ? lines.join('\n') : null;
}

const KIN_TAGS = new Set(['married', 'engaged']);

/** What `speakerId` can see or knows of `otherId` right now (the reads behind `partnerViewLine`). */
export function partnerViewFor(speakerId: number, otherId: number, nowMin = gameMinutesNow()): PartnerView {
  const people = db.select().from(agents).where(inArray(agents.id, [speakerId, otherId])).all();
  const speaker = people.find((a) => a.id === speakerId);
  const other = people.find((a) => a.id === otherId);
  if (!speaker || !other) return {};
  const v: PartnerView = {};
  const states = db.select().from(agentStates).where(eq(agentStates.agent_id, otherId)).all();
  const has = (t: string) => states.some((s) => s.type === t);
  if (has('sick')) v.sick = true;
  const grief = states.find((s) => s.type === 'grieving');
  if (grief) {
    const deadId = /^event:death_of_(\d+)$/.exec(grief.source ?? '')?.[1];
    const dead = deadId ? db.select({ name: agents.name }).from(agents).where(eq(agents.id, Number(deadId))).get()?.name : null;
    v.grievingFor = dead ? firstName(dead) : '';
  }
  if (has('drunk')) v.drunk = true;
  if (has('depressed') || has('heartbroken')) v.low = true;
  const tick = db.select({ time: worldState.time }).from(worldState).limit(1).get()?.time.totalTicks ?? 0;
  if (isNewcomer(other.created_at, tick)) v.newcomer = true;
  if (fresh(otherId, 'lostJob', nowMin)) v.outOfWork = true;

  const rel = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(speakerId, otherId)), eq(relationships.agent_b, Math.max(speakerId, otherId)))).get();
  const regard = rel ? (rel.agent_a === speakerId ? rel.friendship_ab : rel.friendship_ba) : 0;
  const housemate = speaker.home != null && speaker.home === other.home;
  const close = regard >= 40 || housemate || (rel?.tags ?? []).some((t) => KIN_TAGS.has(t)) || rel?.status === 'partners';

  if (close && fresh(otherId, 'birthday', nowMin)) v.birthday = true;
  if (fresh(otherId, 'released', nowMin) && holdsFact(speakerId, otherId, ['released', 'arrest'])) v.justReleased = true;
  if (has('in_debt') && (housemate || holdsFact(speakerId, otherId, ['debt']) || lendsTo(speakerId, otherId))) v.inDebt = true;
  if (close && leavingThoughts().some((l) => l.agentId === otherId)) v.leaving = true;

  // A feud: public once the town has split over it, otherwise only to those in it.
  for (const f of activeFeuds()) {
    const theirs = stanceIn(f, otherId);
    if (theirs !== 'a' && theirs !== 'b') continue;
    const mine = stanceIn(f, speakerId);
    if (f.townSinceMin == null && mine == null) continue;
    // A feud born of a betrayal is the adult layer's: a minor hears nothing of it.
    if (f.adultCause && !isAdultAge(speaker.age)) continue;
    const isPrincipal = otherId === f.aId || otherId === f.bId;
    const withId = theirs === 'a' ? f.aId : f.bId;
    const againstId = theirs === 'a' ? f.bId : f.aId;
    // The speaker is the one they fell out with: their own relationship already says so.
    if (speakerId === againstId && isPrincipal) continue;
    const nameOf = (id: number) => firstName(db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone');
    const speakerIsPrincipal = speakerId === f.aId || speakerId === f.bId;
    v.feud = {
      role: isPrincipal ? 'principal' : 'side',
      withName: speakerId === withId ? 'you' : nameOf(withId),
      other: speakerId === againstId ? 'you' : nameOf(againstId),
      // A principal's own stance needs no saying ("she took your side… and you stand with them").
      speaker: mine == null || speakerIsPrincipal ? 'none' : mine === theirs ? 'same' : mine === 'a' || mine === 'b' ? 'opposite' : 'neutral',
    };
    break;
  }
  return v;
}

function holdsFact(speakerId: number, subjectId: number, types: string[]): boolean {
  return db.select({ known: shared_knowledge.known_by }).from(shared_knowledge)
    .where(and(eq(shared_knowledge.subject_id, subjectId), inArray(shared_knowledge.type, types), eq(shared_knowledge.is_active, true))).all()
    .some((f) => (f.known as number[]).includes(speakerId));
}

function lendsTo(lenderId: number, borrowerId: number): boolean {
  return db.select({ id: loans.id }).from(loans)
    .where(and(eq(loans.lender_id, lenderId), eq(loans.borrower_id, borrowerId), inArray(loans.status, ['open', 'overdue']))).get() != null;
}

/** The single piece of news a template chat may open on (smallTalkScripts.ts `their_news`), most pressing first. */
export function newsKeyOf(v: PartnerView): ChatNews | null {
  if (v.justReleased) return 'released';
  if (v.outOfWork) return 'lost_job';
  if (v.leaving) return 'leaving';
  if (v.birthday) return 'birthday';
  if (v.inDebt) return 'in_debt';
  return null;
}

// ─── The news ledger's listeners ─────────────────────────────────────────────

let initialized = false;

function initPartnerNews(): void {
  if (initialized) return;
  initialized = true;
  const guard = <T>(fn: (p: T) => void) => (p: T) => {
    try {
      fn(p);
    } catch (err) {
      console.warn('[partnerView] news listener failed:', (err as Error).message);
    }
  };
  simEvents.on('crime:released', guard<{ agentId: number }>((p) => notePartnerNews(p.agentId, 'released', gameMinutesNow())));
  simEvents.on('agent:birthday', guard<{ agentId: number }>((p) => notePartnerNews(p.agentId, 'birthday', gameMinutesNow())));
  simEvents.on('life:job_changed', guard<{ agentId: number; from: string; to: string; reason: string }>((p) => {
    // Out of work, not by choice (the same reading as the consolation call, socialCalls/kinds.ts).
    if (!JOBLESS.has(p.from) && p.to === 'unemployed' && p.reason !== 'ambition') notePartnerNews(p.agentId, 'lostJob', gameMinutesNow());
  }));
}

initPartnerNews();
