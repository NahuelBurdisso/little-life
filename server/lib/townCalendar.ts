/**
 * The town calendar at work: announcing what's coming, holding the festivals
 * and their contests, and running each season's mayoral election.
 *
 * Why this exists. Days 5–30 of a town had no rhythm — every world event was a
 * random hourly roll with a mood bonus, unannounced and unremembered. The dates
 * now come from data/calendar.ts, and this module makes each one a story:
 *
 *   two days ahead   feed notice + everyone hears of it (a memory); the paper's
 *                    "Coming up" and every plan prompt mention it
 *   on the day       a real world event at the square (decorations, crowd,
 *                    audio — all keyed on its type/family), attended through the
 *                    existing crowd pull (decisions.ts)
 *   contest          judged near the end: hobby skill + trade + temperament + a
 *                    little luck (lib/contest.ts) → a public win (reputation fact,
 *                    feed beat, memories) and, for vain or rival losers, envy
 *   election         3 days of campaigning (a `campaign` goal, candidates seek
 *                    company and talk about the vote; each chat moves a hidden
 *                    support score), then the count on the square: every
 *                    resident votes (lib/election.ts), the winner becomes mayor
 *                    through `changeJob`, a sore loser may hold a grudge
 *
 * All state lives in `world_state.civic` (schema.ts has why), keyed by the
 * calendar entry, so every step is idempotent: the pass can run any number of
 * times in the same hour, after a restart or a save load, and each thing still
 * happens once. It runs every 10 game minutes from engine/tick.ts inside a
 * transaction; the endorsement listener runs inside the conversations phase's.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  agentStates, agents, aspirations, economy, goals, locations, needs, relationshipEvents, relationships,
  shared_knowledge, worldEvents, worldState,
} from '../db/schema';
import {
  ANNOUNCE_DAYS_AHEAD, ELECTION, FESTIVALS, calendarOn, electionDayFor, whenPhrase,
  type CalendarEntry,
} from '../data/calendar';
import { WORLD_EVENTS } from '../data/worldEventCatalog';
import { startWorldEvent } from '../engine/systems/events';
import { emitter } from '../engine/emitter';
import { logActivity } from './activityLogger';
import { simEvents, type SimEventPayloads } from './simEvents';
import { createFact } from './gossip';
import { getHobbyLevel } from './hobbyEngine';
import { adjustReputation, getReputation } from './reputationEngine';
import { getAgentStates } from './states';
import { JOBLESS, changeJob, jobFit, jobTitleOf } from './careers';
import { VACANCIES, openVacancies } from './vacancies';
import { envyChance, judgeContest, type Entrant } from './contest';
import {
  SUPPORT_CAP, endorsementDelta, pickCandidates, tallyElection, tieKey,
  type ElectionInput, type Hopeful, type Tie,
} from './election';
import { loadStore } from './challenges/store';
import { makeRng, stringToSeed } from './worldgen/rng';
import { MINUTES_PER_DAY, type ClockTime } from './gameClock';
import type { PersonalityProfile } from './personality';

// ─── State ───────────────────────────────────────────────────────────────────

export interface ElectionState {
  electionDay: number;
  candidates: number[];
  incumbentId: number | null;
  /** Hidden campaign support: candidateId → voterId → points (±SUPPORT_CAP). */
  support: Record<string, Record<string, number>>;
}

export interface ElectionResult {
  electionDay: number;
  winnerId: number;
  incumbentId: number | null;
  votes: Record<string, number>;
}

export interface CivicState {
  /** Steps already taken, key → the game day it belongs to (pruned after a week). */
  done: Record<string, number>;
  election: ElectionState | null;
  lastElection: ElectionResult | null;
}

export function emptyCivic(): CivicState {
  return { done: {}, election: null, lastElection: null };
}

/** Tolerant read of the stored JSON: a hand-edited or older row can't crash the tick. */
export function parseCivic(raw: unknown): CivicState {
  const c = emptyCivic();
  if (!raw || typeof raw !== 'object') return c;
  const r = raw as Record<string, unknown>;
  if (r.done && typeof r.done === 'object') {
    for (const [k, v] of Object.entries(r.done as Record<string, unknown>)) if (typeof v === 'number') c.done[k] = v;
  }
  const e = r.election as Partial<ElectionState> | null | undefined;
  if (e && typeof e.electionDay === 'number' && Array.isArray(e.candidates)) {
    c.election = {
      electionDay: e.electionDay,
      candidates: e.candidates.filter((id): id is number => typeof id === 'number'),
      incumbentId: typeof e.incumbentId === 'number' ? e.incumbentId : null,
      support: e.support && typeof e.support === 'object' ? e.support as ElectionState['support'] : {},
    };
  }
  const l = r.lastElection as Partial<ElectionResult> | null | undefined;
  if (l && typeof l.electionDay === 'number' && typeof l.winnerId === 'number') {
    c.lastElection = {
      electionDay: l.electionDay, winnerId: l.winnerId,
      incumbentId: typeof l.incumbentId === 'number' ? l.incumbentId : null,
      votes: l.votes && typeof l.votes === 'object' ? l.votes as Record<string, number> : {},
    };
  }
  return c;
}

export function loadCivic(): CivicState {
  const row = db.select({ civic: worldState.civic }).from(worldState).limit(1).get();
  return parseCivic(row?.civic);
}

function saveCivic(civic: CivicState): void {
  db.update(worldState).set({ civic: civic as unknown as Record<string, unknown> }).run();
}

/** Keys older than this many days are dropped: nothing looks that far back. */
const DONE_KEEP_DAYS = 7;

// ─── Small helpers ───────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;
type LocationRow = typeof locations.$inferSelect;

function living(): AgentRow[] {
  return db.select().from(agents).where(eq(agents.is_active, true)).all();
}

function asleepOrGone(a: AgentRow): boolean {
  const t = (a.current_action as { type?: string } | null)?.type;
  return t === 'sleeping' || t === 'dead' || getAgentStates(a.id).includes('arrested');
}

/** The place an entry is held: its first location type the town has (lowest id). */
export function venueFor(types: readonly string[], all: readonly Pick<LocationRow, 'id' | 'type' | 'name'>[]): Pick<LocationRow, 'id' | 'type' | 'name'> | null {
  for (const type of types) {
    const hit = all.filter((l) => l.type === type).sort((a, b) => a.id - b.id)[0];
    if (hit) return hit;
  }
  return null;
}

function allLocations() {
  return db.select({ id: locations.id, type: locations.type, name: locations.name }).from(locations).all();
}

/** "the square" reads better than "Town Square" mid-sentence; other places keep their name. */
function placePhrase(venue: { name: string } | null): string {
  return venue ? venue.name : 'the square';
}

function remember(agentId: number, description: string, valence: number, importance: number, related?: number): void {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId: related });
}

function addMood(agentId: number, value: number, source: string, minutes: number, now: number): void {
  const row = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  if (!row) return;
  const mods = row.mood_modifiers.filter((m) => m.source !== source);
  mods.push({ source, value, expiresAt: now + minutes });
  db.update(needs).set({ mood_modifiers: mods }).where(eq(needs.id, row.id)).run();
}

function startState(agentId: number, type: 'envious' | 'angry', targetId: number, minutes: number, now: number, source: string): void {
  if (getAgentStates(agentId).includes(type)) return;
  db.insert(agentStates).values({
    agent_id: agentId, type, severity: 0.6, started_at: now, duration: minutes,
    target_agent_id: targetId, source, metadata: null,
  }).run();
}

/** How `from` feels about `to` (-100..100) and how far they trust them. */
function tieBetween(rels: ReadonlyArray<typeof relationships.$inferSelect>, from: number, to: number): Tie {
  const r = rels.find((x) => (x.agent_a === from && x.agent_b === to) || (x.agent_a === to && x.agent_b === from));
  if (!r) return { friendship: 0, trust: 0 };
  return r.agent_a === from
    ? { friendship: r.friendship_ab, trust: r.trust_ab }
    : { friendship: r.friendship_ba, trust: r.trust_ba };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Deterministic luck per calendar occurrence (and world), so a replayed pass agrees with itself. */
function rngFor(key: string): () => number {
  const worldId = db.select({ world_id: worldState.world_id }).from(worldState).limit(1).get()?.world_id ?? '';
  const rng = makeRng(stringToSeed(`${worldId}:${key}`));
  return () => rng.next();
}

// ─── The pass ────────────────────────────────────────────────────────────────

/** Announcements go out from this hour, with the morning's news. */
export const ANNOUNCE_HOUR = 7;
/** The campaign opens at this hour of its first day. */
export const CAMPAIGN_OPEN_HOUR = 8;

/**
 * Every 10 game minutes (engine/tick.ts): announce, open the campaign, start
 * the day's events, judge contests, count the vote. Each step at most once per
 * calendar entry (see the file comment).
 */
export function townCalendarTick(time: ClockTime, nowMinutes: number): void {
  initTownCalendar();
  const civic = loadCivic();
  const before = JSON.stringify(civic);
  const { day, hour } = time;

  // A count the town missed (the evening went by paused, or the save was
  // loaded days later) is held before anything else — a new campaign must not
  // overwrite an election nobody counted.
  if (civic.election && day > civic.election.electionDay) countVotes(civic, nowMinutes);

  if (hour >= ANNOUNCE_HOUR) announceUpcoming(civic, day);

  // The campaign: open it on its first day, or late (a world that started
  // mid-campaign, or on election day itself) the first time the pass sees it.
  const electionDay = electionDayFor(day);
  if (electionDay != null && hour >= CAMPAIGN_OPEN_HOUR && civic.election?.electionDay !== electionDay
    && civic.done[`campaign:${electionDay}`] == null) {
    openCampaign(civic, electionDay, nowMinutes);
  }

  for (const entry of calendarOn(day)) {
    if (!entry.eventType) continue;
    const dur = WORLD_EVENTS[entry.eventType].durationHours;
    if (hour >= entry.startHour && hour < entry.startHour + dur) startEntry(civic, entry);
    if (entry.kind === 'festival' && entry.festivalId) {
      const def = FESTIVALS[entry.festivalId];
      if (hour >= entry.startHour + def.contestAfterHours && civic.done[`start:${entry.key}`] != null
        && civic.done[`contest:${entry.key}`] == null) {
        civic.done[`contest:${entry.key}`] = day;
        holdContest(entry, nowMinutes);
      }
    }
  }

  // The count, read out on the square at the result hour.
  const e = civic.election;
  if (e && day === e.electionDay && hour >= ELECTION.resultHour) countVotes(civic, nowMinutes);

  for (const [key, d] of Object.entries(civic.done)) if (d < day - DONE_KEEP_DAYS) delete civic.done[key];
  if (JSON.stringify(civic) !== before) saveCivic(civic);
}

// ─── Announcements ───────────────────────────────────────────────────────────

/**
 * Festivals and elections within ANNOUNCE_DAYS_AHEAD days, each once. Markets
 * come every week and are left to the paper and their own start line. A day
 * already too close for the two-day notice (a world that started late) is
 * announced anyway, with the right "tomorrow".
 */
function announceUpcoming(civic: CivicState, day: number): void {
  for (let ahead = 1; ahead <= ANNOUNCE_DAYS_AHEAD; ahead++) {
    for (const entry of calendarOn(day + ahead)) {
      if (entry.kind === 'market' || entry.kind === 'campaign') continue;
      const key = `announce:${entry.key}`;
      if (civic.done[key] != null) continue;
      civic.done[key] = entry.day;
      announce(entry, ahead, civic);
    }
  }
}

function announce(entry: CalendarEntry, ahead: number, civic: CivicState): void {
  const venue = venueFor(entry.locationTypes, allLocations());
  const when = whenPhrase(ahead);
  let text: string;
  let memory: string;
  if (entry.kind === 'festival' && entry.festivalId) {
    const def = FESTIVALS[entry.festivalId];
    text = `${def.icon} The ${def.name} is ${when} at ${placePhrase(venue)}: ${def.activities}.`;
    memory = `The ${def.name} is ${when} at ${placePhrase(venue)} — ${def.activities}.`;
  } else {
    const e = civic.election;
    const names = e?.electionDay === entry.day ? namesOf(e.candidates) : [];
    const field = names.length > 1 ? ` ${joinNames(names)} are standing.` : names.length === 1 ? ` ${names[0]} stands unopposed.` : '';
    text = `${ELECTION.icon} The town votes for its mayor ${when}; the count is on ${placePhrase(venue)} at ${ELECTION.countHour}:00.${field}`;
    memory = `The election for mayor is ${when}.${field}`;
  }
  logActivity({ type: 'calendar_notice', ...(venue ? { location: venue.id } : {}), templateData: { description: text } });
  for (const a of living()) simEvents.emit('event:world', { agentId: a.id, name: entry.name, description: memory });
}

function namesOf(ids: readonly number[]): string[] {
  if (ids.length === 0) return [];
  const rows = db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, [...ids])).all();
  return ids.map((id) => rows.find((r) => r.id === id)?.name).filter((n): n is string => !!n);
}

// ─── Festivals and markets ───────────────────────────────────────────────────

function startEntry(civic: CivicState, entry: CalendarEntry): void {
  const key = `start:${entry.key}`;
  if (civic.done[key] != null || !entry.eventType) return;
  civic.done[key] = entry.day;
  // A random roll of the same type may already be running (a market day on
  // market day): the town doesn't need two.
  const running = db.select({ id: worldEvents.id }).from(worldEvents)
    .where(and(eq(worldEvents.is_active, true), eq(worldEvents.type, entry.eventType))).get();
  if (running) return;
  const venue = venueFor(entry.locationTypes, allLocations());
  const def = WORLD_EVENTS[entry.eventType];
  const description = entry.kind === 'election'
    ? `The town gathers at ${placePhrase(venue)} to count the votes for mayor.`
    : `${def.description.replace(/[.!]$/, '')} — at ${placePhrase(venue)}.`;
  startWorldEvent(entry.eventType, {
    triggeredBy: `calendar:${entry.key}`,
    name: entry.kind === 'election' ? 'Election Count' : entry.name,
    description,
    locationId: venue?.id ?? null,
    // It is on the calendar: it happens whatever else is going on.
    enforceLimits: false,
  });
}

/** Most entrants a contest takes (the keenest, by skill). */
export const MAX_ENTRANTS = 8;

/**
 * Judge the day's contest among the people at the festival. With fewer than
 * two there, the town's keenest practitioners who are awake step up — a
 * contest nobody enters is no contest, but a quiet square shouldn't cancel it.
 */
function holdContest(entry: CalendarEntry, now: number): void {
  const def = FESTIVALS[entry.festivalId!];
  const event = db.select().from(worldEvents)
    .where(and(eq(worldEvents.type, def.eventType), eq(worldEvents.triggered_by, `calendar:${entry.key}`))).get();
  const venueId = event?.location_id ?? null;
  const town = living().filter((a) => !asleepOrGone(a));
  const jobs = new Map(db.select({ agent_id: economy.agent_id, job: economy.job }).from(economy).all().map((r) => [r.agent_id, r.job]));
  const toEntrant = (a: AgentRow): Entrant => ({
    id: a.id, name: a.name, personality: a.personality as Record<string, number> | null,
    hobbyLevel: getHobbyLevel(a.id, def.contest.activity), job: jobs.get(a.id) ?? '',
  });
  const attending = town.filter((a) => venueId != null && a.current_location === venueId).map(toEntrant);
  let entrants = attending;
  if (entrants.length < 2) {
    const keen = town.map(toEntrant).filter((e) => !entrants.some((x) => x.id === e.id) && e.hobbyLevel > 0)
      .sort((a, b) => b.hobbyLevel - a.hobbyLevel || a.id - b.id);
    entrants = [...entrants, ...keen].slice(0, Math.max(2, entrants.length));
  }
  entrants = [...entrants].sort((a, b) => b.hobbyLevel - a.hobbyLevel || a.id - b.id).slice(0, MAX_ENTRANTS);

  const result = judgeContest(entrants, def.contest, rngFor(`contest:${entry.key}`));
  if (!result) return;
  const byId = new Map(entrants.map((e) => [e.id, e]));
  const winner = byId.get(result.winnerId)!;
  const runners = result.ranking.slice(1, 3).map((r) => byId.get(r.id)!.name);
  const crowd = [...new Set([...attending.map((e) => e.id), ...entrants.map((e) => e.id)])];

  const ahead = runners.length > 0 ? `, ahead of ${joinNames(runners)}` : '';
  logActivity({
    type: 'drama',
    initiator: winner.id,
    agents: result.ranking.slice(0, 3).map((r) => r.id),
    ...(venueId != null ? { location: venueId } : {}),
    templateData: { description: `${winner.name} won ${def.contest.name} at the ${def.name}${ahead}.` },
    metadata: { beat: 'contest_win' },
  });
  // Public at once (sensitivity 1): the crowd saw it. Feeds reputation daily.
  createFact('contest_win', winner.id, null, 1, crowd, 'event', { detail: def.contest.prize });
  adjustReputation(winner.id, 4);
  remember(winner.id, `I won ${def.contest.name} at the ${def.name}! The whole square cheered.`, 0.9, 7);
  addMood(winner.id, 12, `contest:${entry.key}`, 12 * 60, now);

  const rels = db.select().from(relationships).all();
  const rng = rngFor(`envy:${entry.key}`);
  result.ranking.slice(1).forEach((r, i) => {
    const loser = byId.get(r.id)!;
    const place = i === 0 ? 'I came second' : 'I didn\'t place';
    remember(loser.id, `${winner.name} won ${def.contest.name} at the ${def.name}. ${place}.`, -0.2, 4, winner.id);
    const chance = envyChance(loser.personality, tieBetween(rels, loser.id, winner.id).friendship);
    if (rng() < chance) startState(loser.id, 'envious', winner.id, MINUTES_PER_DAY, now, 'event:contest');
  });
  emitter.markDirty('agents.all');
}

// ─── The election ────────────────────────────────────────────────────────────

/** Who may stand: grown, in town, not in a cell. */
const MIN_CANDIDATE_AGE = 21;
const MIN_VOTER_AGE = 18;

function openCampaign(civic: CivicState, electionDay: number, now: number): void {
  civic.done[`campaign:${electionDay}`] = electionDay;
  const town = living();
  const jobs = new Map(db.select({ agent_id: economy.agent_id, job: economy.job }).from(economy).all().map((r) => [r.agent_id, r.job]));
  const incumbent = town.filter((a) => jobs.get(a.id) === 'mayor').sort((a, b) => a.id - b.id)[0] ?? null;
  const ambitions = new Map(db.select().from(aspirations).where(eq(aspirations.status, 'active')).all()
    .map((r) => [r.agent_id, r]));
  const hopefuls: Hopeful[] = town
    .filter((a) => a.age >= MIN_CANDIDATE_AGE && !getAgentStates(a.id).includes('arrested'))
    .map((a) => ({
      id: a.id,
      personality: a.personality as Record<string, number> | null,
      reputation: getReputation(a.id),
      ambitionType: ambitions.get(a.id)?.type ?? null,
      ambitionText: ambitions.get(a.id)?.description ?? null,
    }));
  const drafted = (loadStore()?.active ?? []).filter((c) => c.kind === 'kingmaker').map((c) => c.agentIds[0]);
  const candidates = pickCandidates(hopefuls, incumbent?.id ?? null, drafted);
  if (candidates.length === 0) return;
  civic.election = { electionDay, candidates, incumbentId: incumbent?.id ?? null, support: {} };

  const names = namesOf(candidates);
  const labelled = candidates.map((id, i) => (id === incumbent?.id ? `${names[i]} (the mayor)` : names[i]));
  const venue = venueFor(ELECTION.locationTypes, allLocations());
  const text = candidates.length === 1
    ? `${ELECTION.icon} ${labelled[0]} stands for mayor unopposed. The town votes on day ${electionDay}.`
    : `${ELECTION.icon} Campaign season: ${joinNames(labelled)} are standing for mayor. The town votes on day ${electionDay}, and the count is on ${placePhrase(venue)}.`;
  logActivity({ type: 'election_campaign', agents: candidates, templateData: { description: text } });

  const expires = (electionDay + 1) * MINUTES_PER_DAY;
  for (const id of candidates) {
    db.insert(goals).values({
      agent_id: id, type: 'campaign', target_id: null, motivation: 'election',
      priority: 0.8, progress: 0, status: 'active', created_at: now, expires_at: expires,
      description: `Win the election for mayor on day ${electionDay}: talk to as many townsfolk as I can`,
      strategy: 'Canvass: seek out people, ask for their vote, talk about what I would do for the town',
      mapped_interactions: null, source: 'election',
    }).run();
    const rivals = joinNames(names.filter((n) => n !== names[candidates.indexOf(id)]));
    remember(id, rivals
      ? `I'm standing for mayor against ${rivals}. The vote is on day ${electionDay}; I need to win people over.`
      : `I'm standing for mayor, unopposed. The vote is on day ${electionDay}.`, 0.4, 7);
    simEvents.emit('plan:evaluate-replan', {
      agentId: id, type: 'state', description: 'is standing for mayor', sentiment: 0.4, isDramatic: true,
    });
  }
  for (const a of town) {
    if (candidates.includes(a.id)) continue;
    simEvents.emit('event:world', { agentId: a.id, name: 'Election for mayor', description: text.replace(`${ELECTION.icon} `, '') });
  }
  emitter.markDirty('agents.all');
}

/**
 * Tally the votes, announce, and hand the mayor's chair over. Candidates who
 * died or left since the campaign opened are off the ballot.
 */
function countVotes(civic: CivicState, now: number): void {
  const e = civic.election!;
  civic.election = null;
  civic.done[`count:${e.electionDay}`] = e.electionDay;
  const town = living();
  const alive = new Set(town.map((a) => a.id));
  const standing = e.candidates.filter((id) => alive.has(id));
  if (standing.length === 0) return;

  const rels = db.select().from(relationships).all();
  const ties = new Map<string, Tie>();
  const voters = town.filter((a) => a.age >= MIN_VOTER_AGE);
  for (const v of voters) for (const c of standing) ties.set(tieKey(v.id, c), tieBetween(rels, v.id, c));
  const byId = new Map(town.map((a) => [a.id, a]));
  const input: ElectionInput = {
    candidates: standing.map((id) => ({
      id, personality: byId.get(id)!.personality as Record<string, number> | null,
      reputation: getReputation(id), incumbent: id === e.incumbentId,
    })),
    voters: voters.map((v) => ({ id: v.id, personality: v.personality as Record<string, number> | null })),
    ties,
    secrets: db.select().from(shared_knowledge).where(eq(shared_knowledge.is_active, true)).all()
      .filter((s) => s.sensitivity >= 2)
      .map((s) => ({ subjectId: s.subject_id, sensitivity: s.sensitivity, isPublic: !!s.is_public, knownBy: (s.known_by ?? []) as number[] })),
    support: e.support,
  };
  const tally = tallyElection(input, rngFor(`election:${e.electionDay}`));
  if (!tally) return;
  const winner = byId.get(tally.winnerId)!;
  const incumbent = e.incumbentId != null ? byId.get(e.incumbentId) ?? null : null;
  const reelected = incumbent?.id === winner.id;
  const venue = venueFor(ELECTION.locationTypes, allLocations());

  const counts = tally.ranking.map((r) => `${byId.get(r.id)!.name} ${r.votes}`).join(', ');
  const headline = standing.length === 1
    ? `${winner.name} is ${reelected ? 're-elected' : 'elected'} mayor unopposed.`
    : `${winner.name} is ${reelected ? 're-elected' : 'elected'} mayor — ${counts}.`;
  logActivity({
    type: 'election_result',
    agents: tally.ranking.map((r) => r.id),
    ...(venue ? { location: venue.id } : {}),
    templateData: { description: `${ELECTION.icon} ${headline}` },
  });
  civic.lastElection = {
    electionDay: e.electionDay, winnerId: winner.id, incumbentId: incumbent?.id ?? null,
    votes: Object.fromEntries(tally.ranking.map((r) => [String(r.id), r.votes])),
  };

  // The chair changes hands. The old mayor goes first so the town hall is free
  // for the winner to take over (careers.ts `takesOverWorkplace`).
  if (!reelected) {
    // Read BEFORE the winner's job changes: it is the trade he leaves behind.
    const winnerTrade = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, winner.id)).get()?.job ?? null;
    if (incumbent) changeJob(incumbent.id, 'unemployed', 'election', { because: `${winner.name} won the election` });
    changeJob(winner.id, 'mayor', 'election', { because: 'the town has voted' });
    if (incumbent) resettleOustedMayor(incumbent, winner, winnerTrade);
  }

  // The campaign goals settle with the count.
  const campaignGoals = db.select().from(goals)
    .where(and(eq(goals.type, 'campaign'), eq(goals.status, 'active'))).all()
    .filter((g) => e.candidates.includes(g.agent_id));
  for (const g of campaignGoals) {
    const won = g.agent_id === winner.id;
    db.update(goals).set({ status: won ? 'completed' : 'failed', progress: won ? 1 : g.progress, completed_at: now })
      .where(eq(goals.id, g.id)).run();
  }

  remember(winner.id, reelected
    ? 'The town has kept me on as mayor. They still trust me.'
    : 'The town elected me mayor! I can hardly believe it.', 0.9, 9);
  addMood(winner.id, 15, `election:${e.electionDay}`, 24 * 60, now);
  const rng = rngFor(`grudge:${e.electionDay}`);
  for (const r of tally.ranking.slice(1)) {
    const loser = byId.get(r.id)!;
    remember(loser.id, `I lost the election for mayor to ${winner.name}. ${r.votes} people voted for me.`, -0.6, 8, winner.id);
    addMood(loser.id, -10, `election:${e.electionDay}`, 24 * 60, now);
    holdGrudge(loser, winner, rels, rng, now);
  }
  for (const a of town) {
    if (standing.includes(a.id)) continue;
    const mine = tally.ballots.get(a.id);
    const how = mine === winner.id ? 'I voted for them.' : mine != null ? `I voted for ${byId.get(mine)?.name ?? 'someone else'}.` : '';
    simEvents.emit('event:world', { agentId: a.id, name: 'Election result', description: `${headline} ${how}`.trim() });
  }
  // Friends call on the winner, and on the ones who lost (lib/socialCalls).
  const result: SimEventPayloads['civic:election'] = { winnerId: winner.id, loserIds: tally.ranking.slice(1).map((r) => r.id) };
  simEvents.emit('civic:election', result);
  emitter.markDirty('agents.all');
}

/**
 * The ousted mayor is a person with a living to make, not an "unemployed": she
 * takes the trade the winner just left (his workplace, wage and the building he
 * ran come with it, careers.ts `changeJob`), or, when the winner had none, an
 * essential trade nobody holds (the same openings lib/vacancies.ts fills, the
 * best fit for her first). Unemployed is the last resort: nothing is open, or she
 * is too old to be hired (`VACANCIES.MAX_AGE`).
 */
function resettleOustedMayor(
  incumbent: Pick<AgentRow, 'id' | 'age' | 'personality'>,
  winner: Pick<AgentRow, 'name'>,
  winnerTrade: string | null,
): string | null {
  if (incumbent.age >= VACANCIES.MAX_AGE) return null;
  let trade: string | null = winnerTrade != null && !JOBLESS.has(winnerTrade) && winnerTrade !== 'mayor' ? winnerTrade : null;
  let because = `${winner.name} has left the trade to be mayor`;
  if (trade == null) {
    const personality = incumbent.personality as Record<string, number> | null;
    trade = openVacancies()
      .filter((j) => j !== 'mayor')
      .sort((a, b) => jobFit(personality, b) - jobFit(personality, a))[0] ?? null;
    if (trade != null) because = `the town had no ${jobTitleOf(trade).toLowerCase()}`;
  }
  if (trade == null) return null;
  return changeJob(incumbent.id, trade, 'vacancy', { because }) ? trade : null;
}

/**
 * A loser takes it personally when they are proud or quick-tempered, or never
 * liked the winner: friendship sours, envy for two days, and the bitterest
 * are angry (which the goal triggers turn into revenge — goalRegistry) and
 * the town hears they hold a grudge.
 */
function holdGrudge(loser: AgentRow, winner: AgentRow, rels: ReadonlyArray<typeof relationships.$inferSelect>, rng: () => number, now: number): void {
  const p = (loser.personality ?? {}) as Partial<PersonalityProfile>;
  const pride = ((p.vanity ?? 50) + (p.aggression ?? 50)) / 2;
  const friendship = tieBetween(rels, loser.id, winner.id).friendship;
  const chance = Math.max(0, Math.min(0.9, 0.2 + (pride - 50) / 60 + (friendship < 0 ? 0.25 : friendship > 50 ? -0.3 : 0)));
  if (rng() >= chance) return;
  db.insert(relationshipEvents).values({
    agent_a: loser.id, agent_b: winner.id, event_type: 'election_grudge',
    description: `${loser.name} lost the election to ${winner.name}`,
    friendship_delta_ab: -10, friendship_delta_ba: 0,
    romance_delta_ab: 0, romance_delta_ba: 0,
    trust_delta_ab: -5, trust_delta_ba: 0,
    sentiment: -0.6, processed: false, timestamp: Date.now(),
  }).run();
  startState(loser.id, 'envious', winner.id, 2 * MINUTES_PER_DAY, now, 'event:election');
  if ((p.aggression ?? 50) >= 65) {
    startState(loser.id, 'angry', winner.id, 12 * 60, now, 'event:election');
    createFact('grudge', loser.id, winner.id, 2, [loser.id], 'election', { detail: 'over the election for mayor' });
  }
}

// ─── Campaign support (conversations) ────────────────────────────────────────

interface ConversationEnded {
  agentId: number;
  perpetratorId?: number | null;
  sentiment?: number;
  summary?: string;
}

/**
 * A candidate's chat with a voter moves that voter's hidden support for them.
 * Handled on the candidate's own `conversation:ended` (the event fires once per
 * participant), so a chat between two candidates counts for neither.
 */
export function onCampaignConversation(p: ConversationEnded): void {
  const other = p.perpetratorId;
  if (other == null || other === p.agentId) return;
  const civic = loadCivic();
  const e = civic.election;
  if (!e || !e.candidates.includes(p.agentId) || e.candidates.includes(other)) return;
  const about = /\b(election|mayor|vote|campaign)/i.test(p.summary ?? '');
  const c = String(p.agentId);
  const v = String(other);
  const byVoter = e.support[c] ?? (e.support[c] = {});
  const next = (byVoter[v] ?? 0) + endorsementDelta(p.sentiment ?? 0, about);
  byVoter[v] = Math.max(-SUPPORT_CAP, Math.min(SUPPORT_CAP, Math.round(next * 10) / 10));
  saveCivic(civic);
  // Canvassing is the campaign goal's progress: one voter at a time.
  const reached = Object.keys(byVoter).length;
  db.update(goals).set({ progress: Math.min(0.95, reached / 10) })
    .where(and(eq(goals.agent_id, p.agentId), eq(goals.type, 'campaign'), eq(goals.status, 'active'))).run();
}

let initialized = false;

/** Register the conversation listener once (the tick calls it; tests may too). */
export function initTownCalendar(): void {
  if (initialized) return;
  initialized = true;
  simEvents.on('conversation:ended', (p: ConversationEnded) => {
    try {
      onCampaignConversation(p);
    } catch (err) {
      console.warn('[townCalendar] campaign support failed:', (err as Error).message);
    }
  });
}

// ─── Readers: decisions, plans, the paper, Brewing ───────────────────────────

/** The running campaign's candidates (empty when there is none). */
export function campaignCandidates(civic: CivicState = loadCivic()): Set<number> {
  return new Set(civic.election?.candidates ?? []);
}

function entryLine(entry: CalendarEntry, venueName: string, relative: string): string {
  if (entry.kind === 'festival' && entry.festivalId) {
    const def = FESTIVALS[entry.festivalId];
    return `${relative} is the ${def.name} at ${venueName} from ${def.startHour}:00 (${def.activities}).`;
  }
  if (entry.kind === 'market') return `${relative} is market day at ${venueName}.`;
  if (entry.kind === 'election') return `${relative} the town votes for its mayor; the count is at ${venueName} at ${ELECTION.countHour}:00.`;
  return '';
}

/**
 * Lines for a resident's daily plan prompt (planning/planPrompts.ts): what is
 * on today and tomorrow, and — for a candidate — that they are campaigning.
 * Without it residents planned their usual day and walked past the fair.
 */
export function planCalendarNote(agentId: number, day: number): string[] {
  // Context, not the plan itself: a read failing here must not cost the day's plan.
  try {
    return calendarNoteLines(agentId, day);
  } catch (err) {
    console.warn('[townCalendar] plan note failed:', (err as Error).message);
    return [];
  }
}

function calendarNoteLines(agentId: number, day: number): string[] {
  const all = allLocations();
  const lines: string[] = [];
  for (const [offset, relative] of [[0, 'Today'], [1, 'Tomorrow']] as const) {
    for (const entry of calendarOn(day + offset)) {
      if (entry.kind === 'campaign') continue;
      const line = entryLine(entry, placePhrase(venueFor(entry.locationTypes, all)), relative);
      if (line) lines.push(line);
    }
  }
  const e = loadCivic().election;
  if (e && day <= e.electionDay) {
    const until = whenPhrase(e.electionDay - day);
    if (e.candidates.includes(agentId)) {
      const rivals = namesOf(e.candidates.filter((id) => id !== agentId));
      lines.push(`You are standing for mayor${rivals.length ? ` against ${joinNames(rivals)}` : ''}; the vote is ${until}. Spend time talking to as many townsfolk as you can and ask for their vote.`);
    } else if (e.electionDay - day >= 1) {
      lines.push(`The election for mayor is ${until}: ${joinNames(namesOf(e.candidates))} ${e.candidates.length > 1 ? 'are' : 'is'} standing.`);
    }
  }
  return lines;
}

/**
 * "Coming up" for the Town Crier (lib/gazette.ts): the next few days' calendar
 * and who is standing, from the day the edition is printed.
 */
export function comingUpLines(day: number, days = 3): string[] {
  const all = allLocations();
  const lines: string[] = [];
  for (let d = day; d <= day + days; d++) {
    for (const entry of calendarOn(d)) {
      if (entry.kind === 'campaign') continue;
      const rel = d === day ? 'Today' : d === day + 1 ? 'Tomorrow' : `On day ${d}`;
      const line = entryLine(entry, placePhrase(venueFor(entry.locationTypes, all)), rel);
      if (line) lines.push(line);
    }
  }
  const e = loadCivic().election;
  if (e && e.electionDay >= day) {
    const names = namesOf(e.candidates);
    if (names.length > 0) lines.push(`Standing for mayor: ${joinNames(names)}.`);
  }
  return lines;
}

/** The running election for the Journal's Brewing tab (lib/brewing.ts). */
export interface ElectionBrewing {
  electionDay: number;
  daysLeft: number;
  candidates: Array<{ id: number; support: number; incumbent: boolean }>;
}

export function electionBrewing(day: number): ElectionBrewing | null {
  const e = loadCivic().election;
  if (!e) return null;
  return {
    electionDay: e.electionDay,
    daysLeft: Math.max(0, e.electionDay - day),
    candidates: e.candidates.map((id) => ({
      id,
      support: Object.values(e.support[String(id)] ?? {}).reduce((s, v) => s + v, 0),
      incumbent: id === e.incumbentId,
    })),
  };
}

