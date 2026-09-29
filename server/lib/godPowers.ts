import { db } from '../db';
import { agents, agentStates, relationships, shared_knowledge } from '../db/schema';
import { and, eq, or } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { createFact } from './gossip';
import { memoryService } from './memory/instance';
import { gameMinutesNow } from './worldClock';
import { emitter } from '../engine/emitter';
import { registerWhisper } from './playerOutcomes';
import type { PersonalityProfile } from './personality';

/**
 * God powers that PLANT something and then leave it alone: a thought in one
 * head, a rumor in one mouth, a feeling in one heart. Unlike the older nudges
 * (walk here, talk to them), none of these orders anyone to do anything — they
 * seed state the simulation already knows how to grow. The thought is a memory
 * that conversation retrieval surfaces and a replan reacts to; the rumor is a
 * fact the gossip engine spreads (and the town can trace back to its teller);
 * the feeling is an agent state whose existing effects run. So the fun is in
 * watching what the town does with it, and every path below is the same code a
 * naturally-arising thought/rumor/feeling would take.
 *
 * Kept out of routers/nudge.ts, which is a long switch of DB edits: these need
 * the memory service and gossip helpers, and are unit tested directly.
 */

export type GodPowerResult =
  | { success: true; message: string }
  | { success: false; reason: string };

export const WHISPER_MAX = 140;
export const RUMOR_MAX = 120;

// ─── Player text ──────────────────────────────────────────────────────────────

/**
 * Lines that read as instructions to the model rather than a thought or a bit of
 * gossip. Player text ends up inside LLM prompts (memories are retrieved into
 * dialogue, rumors are listed as gossip), so "ignore your instructions and…"
 * typed into a whisper would otherwise be quoted into the system prompt of
 * every conversation that agent has. This is a tripwire, not a guarantee — the
 * text is always quoted as something the character thought or heard, never
 * spliced in as a directive — but it catches the obvious attempts and the role
 * markers chat templates react to.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules?|system|above|previous)\b/i,
  /\b(system|assistant|developer)\s*(prompt|message)?\s*:/i,
  /\byou are (now )?(an? )?(ai|assistant|language model|chatbot|llm)\b/i,
  /\b(respond|reply|answer|output)\s+(only\s+)?(in|with)\s+(json|english|spanish|code)\b/i,
];

/**
 * Clean player-typed text for storage in the sim: one line, no control
 * characters, no chat-template tokens or markup brackets, collapsed whitespace,
 * cut to `max` on a word boundary. Returns null for text that is empty after
 * cleaning or looks like a prompt injection; callers turn that into a refusal.
 */
export function sanitizePlayerText(raw: string, max: number): string | null {
  let text = String(raw ?? '')
    // Chat-template role tokens (<|im_start|>, <|eot_id|>...) before the
    // generic bracket strip below would leave their inner words behind.
    .replace(/<\|[^|>]*\|>/g, ' ')
    // Newlines and every other control character: a multi-line whisper could
    // fake a new "speaker:" line in a transcript-shaped prompt.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    // Markup and template delimiters have no business in a thought.
    .replace(/[<>{}[\]`\\]/g, ' ')
    .replace(/#{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (INJECTION_PATTERNS.some((re) => re.test(text))) return null;
  if (text.length > max) {
    const cut = text.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    text = (space > max * 0.6 ? cut.slice(0, space) : text.slice(0, max)).trim();
  }
  return text;
}

/**
 * Turn what the player typed into the predicate the `rumor` fact template
 * splices after the subject's name ("<Rosa> <is secretly broke>"). Players
 * naturally type the whole sentence, so a leading "Rosa Chen", "Rosa" or
 * "that" is dropped, as is the final full stop (feed lines add their own).
 */
export function rumorPredicate(detail: string, subjectName: string): string {
  let d = detail.trim();
  const first = subjectName.split(' ')[0];
  for (const lead of [subjectName, first]) {
    if (lead && d.toLowerCase().startsWith(lead.toLowerCase() + ' ')) {
      d = d.slice(lead.length).trim();
      break;
    }
  }
  d = d.replace(/^that\s+/i, '').replace(/[.!]+$/, '').trim();
  return d;
}

function firstName(name: string): string {
  return name.split(' ')[0];
}

function activeAgent(id: number) {
  const a = db.select().from(agents).where(eq(agents.id, id)).get();
  return a?.is_active ? a : null;
}

// ─── whisper_thought ──────────────────────────────────────────────────────────

/** High enough to beat routine memories in retrieval and survive consolidation (≥7 is never pruned). */
export const WHISPER_IMPORTANCE = 9;

/**
 * An intrusive thought, planted as a memory. Recorded as a `reflection` on
 * purpose: conversation retrieval boosts reflections (memory/strategies.ts), and
 * consolidation never prunes them, so the thought keeps surfacing in dialogue
 * the way a conclusion the agent reached on their own would. The replan event
 * is dramatic so the rest of today's plan is rethought around it right away
 * (the replan prompt already carries TOWN_SETTING).
 */
export function whisperThought(agentId: number, rawText: string): GodPowerResult {
  const agent = activeAgent(agentId);
  if (!agent) return { success: false, reason: 'Agent not found or inactive' };
  const text = sanitizePlayerText(rawText, WHISPER_MAX);
  if (!text) return { success: false, reason: "That doesn't read like a thought someone could have" };

  memoryService.record(
    agentId,
    'reflection',
    `A thought came to me out of nowhere and I can't shake it: "${text}"`,
    { subtype: 'intrusive_thought', source: 'player' },
    0,
    WHISPER_IMPORTANCE,
  );

  // The player hears back when the thought first shows (playerOutcomes.ts).
  registerWhisper(agentId, text);

  simEvents.emit('plan:evaluate-replan', {
    agentId,
    type: 'state',
    description: `had a sudden thought they can't shake: "${text}"`,
    sentiment: 0,
    isDramatic: true,
  });

  logActivity({
    type: 'player_whisper',
    initiator: agentId,
    templateData: { description: `Player whispered a thought to ${agent.name}: "${text}"` },
  });
  emitter.markDirty('agents.all');

  return { success: true, message: `${firstName(agent.name)} can't stop thinking about it` };
}

// ─── start_rumor ──────────────────────────────────────────────────────────────

export const RUMOR_SENSITIVITY = 3;

/**
 * Would this agent ever repeat a sensitivity-3 fact? Mirrors the gates the
 * rumor has to pass to leave their mouth: `getShareableFacts` (conversations:
 * honesty and morality ≤ 60) — the looser of the two spread paths; the
 * gossip tick's active sharing also wants curiosity ≥ 50 and honesty ≤ 30.
 */
function wouldRepeat(p: PersonalityProfile | null): boolean {
  if (!p) return true;
  return p.honesty <= 60 && p.morality <= 60;
}

/**
 * A made-up story, told only to `seederId`. It goes through `createFact` like
 * the jealousy rumors in states.ts, with source `fabricated` so the existing
 * "compare notes" discovery in `spreadGossip` can trace it back to the seeder
 * (known_by[0]) — planting a rumor in someone's mouth can cost *them*. It is
 * marked `reliability: 'unverified'` (the column existed, unused), which is what
 * lets the subject react when it reaches them (`rumorReachedSubject` in gossip.ts).
 */
export function startRumor(
  seederId: number,
  subjectId: number,
  targetId: number | null,
  rawDetail: string,
): GodPowerResult {
  if (seederId === subjectId) return { success: false, reason: 'Nobody spreads rumors about themselves' };
  const seeder = activeAgent(seederId);
  const subject = activeAgent(subjectId);
  if (!seeder || !subject) return { success: false, reason: 'Agent not found or inactive' };
  if (targetId != null && (targetId === subjectId || !activeAgent(targetId))) targetId = null;

  const clean = sanitizePlayerText(rawDetail, RUMOR_MAX);
  const detail = clean ? rumorPredicate(clean, subject.name) : '';
  if (!detail) return { success: false, reason: "That doesn't read like something people would whisper" };

  const factId = createFact('rumor', subjectId, targetId, RUMOR_SENSITIVITY, [seederId], 'fabricated', { detail });
  if (factId == null) {
    // createFact dedupes on type + subject (+ target): one live rumor per subject.
    return { success: false, reason: `A rumor about ${firstName(subject.name)} is already going around` };
  }
  db.update(shared_knowledge)
    .set({ reliability: 'unverified' })
    .where(eq(shared_knowledge.id, factId))
    .run();

  const fact = db.select({ content: shared_knowledge.content }).from(shared_knowledge)
    .where(eq(shared_knowledge.id, factId)).get();
  const content = fact?.content ?? `${subject.name} ${detail}`;
  // The seeder "heard it somewhere": the same memory a gossip listener gets, so
  // it shows up in their memories and in what they retrieve before a chat.
  simEvents.emit('gossip:learned', { agentId: seederId, sourceName: 'someone passing through', content });

  logActivity({
    type: 'player_rumor',
    initiator: seederId,
    target: subjectId,
    templateData: { description: `Player planted a rumor with ${seeder.name}: ${content}` },
  });

  const s = firstName(seeder.name);
  const message = wouldRepeat(seeder.personality as PersonalityProfile | null)
    ? `${s} heard that ${content} — let's see who ${s} tells`
    : `${s} heard it, but may be too upright to repeat it`;
  return { success: true, message };
}

// ─── stir_feeling ─────────────────────────────────────────────────────────────

export const STIRRABLE_STATES = ['infatuated', 'jealous', 'confident', 'stressed'] as const;
export type StirrableState = (typeof STIRRABLE_STATES)[number];

/**
 * Game minutes a stirred feeling holds before its natural exit condition is
 * checked (states.ts `checkConditionalExits` honours `metadata.holdUntil`).
 * Without it a stirred infatuation with someone the agent barely likes was
 * deleted an hour later — the grace period — because romance < 40. Half a day
 * gives the feeling time to act (conversations colored by the state prompt,
 * a crush fact to gossip about); after that it lives or dies by the town's
 * real relationships, like any other.
 */
export const STIR_HOLD_MINUTES = 720;

/** The one who would be most painful to lose to `rivalId`: their current crush, else their strongest romance. */
function loveInterestOf(agentId: number, rivalId: number): number | null {
  const crush = db.select({ target: agentStates.target_agent_id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'infatuated'))).get();
  if (crush?.target != null && crush.target !== rivalId) return crush.target;

  const rels = db.select().from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId))).all();
  let best: { id: number; romance: number } | null = null;
  for (const r of rels) {
    const isA = r.agent_a === agentId;
    const other = isA ? r.agent_b : r.agent_a;
    if (other === rivalId) continue;
    const romance = isA ? r.romance_ab : r.romance_ba;
    if (romance > 0 && (!best || romance > best.romance)) best = { id: other, romance };
  }
  return best?.id ?? null;
}

/**
 * Put a feeling in an agent's heart: an `agent_states` row shaped like the one
 * states.ts would have created for that state, plus `state:triggered` so the
 * same listeners run (memory, replan, personality drift, cascade tension). A
 * state the agent already has is re-stirred in place — states are one row per
 * type per agent everywhere else, and a second row would double its effects.
 */
export function stirFeeling(agentId: number, state: StirrableState, targetId: number | null): GodPowerResult {
  const agent = activeAgent(agentId);
  if (!agent) return { success: false, reason: 'Agent not found or inactive' };
  const needsTarget = state === 'infatuated' || state === 'jealous';
  const target = needsTarget && targetId != null ? activeAgent(targetId) : null;
  if (needsTarget && (!target || target.id === agentId)) {
    return { success: false, reason: state === 'infatuated' ? 'Pick who they fall for' : 'Pick who they are jealous of' };
  }

  const now = gameMinutesNow();
  const holdUntil = now + STIR_HOLD_MINUTES;
  const a = firstName(agent.name);
  const t = target ? firstName(target.name) : '';

  let row: Omit<typeof agentStates.$inferInsert, 'agent_id' | 'type'>;
  let cause: string;
  let message: string;
  switch (state) {
    case 'infatuated':
      row = {
        severity: 0.7, started_at: now, duration: 999999, target_agent_id: target!.id,
        source: 'player:stir', metadata: { stirred: true, holdUntil },
      };
      cause = `could not stop thinking about ${target!.name}`;
      message = `${a} can't stop thinking about ${t}`;
      break;
    case 'jealous': {
      // The same metadata the rival_romance trigger records, so the jealous
      // effects (grudge escalation, a fabricated rumor about the rival) run.
      // Without a love interest there is no triangle for the exit check to
      // read, and states.ts then lets the state run out its duration instead.
      const loveInterestId = loveInterestOf(agentId, target!.id);
      row = {
        severity: 0.7, started_at: now,
        duration: loveInterestId != null ? 999999 : 1440,
        target_agent_id: target!.id,
        source: 'player:stir',
        metadata: { rivalId: target!.id, ...(loveInterestId != null ? { loveInterestId } : {}), stirred: true, holdUntil },
      };
      cause = `felt ${target!.name} was getting too close to someone they care about`;
      message = `${a} is burning with jealousy of ${t}`;
      break;
    }
    case 'confident':
      row = { severity: 0.6, started_at: now, duration: STIR_HOLD_MINUTES, target_agent_id: null, source: 'player:stir', metadata: { stirred: true } };
      cause = 'woke up feeling they could take on anything';
      message = `${a} feels on top of the world`;
      break;
    case 'stressed':
      row = {
        severity: 0.6, started_at: now, duration: 999999, target_agent_id: null,
        source: 'player:stir', metadata: { stirred: true, holdUntil },
      };
      cause = 'felt everything pile up at once';
      message = `${a} is suddenly on edge`;
      break;
  }

  const existing = db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, state))).get();
  if (existing) {
    db.update(agentStates).set(row).where(eq(agentStates.id, existing.id)).run();
  } else {
    db.insert(agentStates).values({ agent_id: agentId, type: state, ...row }).run();
  }

  // The infatuation trigger records a crush fact the town can gossip about;
  // a stirred crush is just as real to everyone else.
  if (state === 'infatuated') createFact('crush', agentId, target!.id, 2, [agentId], 'witnessed');

  simEvents.emit('state:triggered', { agentId, state, cause });

  logActivity({
    type: 'player_stir',
    initiator: agentId,
    ...(target ? { target: target.id } : {}),
    templateData: {
      description: target
        ? `Player stirred ${state === 'infatuated' ? 'infatuation' : 'jealousy'} in ${agent.name} toward ${target.name}`
        : `Player made ${agent.name} feel ${state}`,
    },
  });
  emitter.markDirty('agents.all');

  return { success: true, message };
}
