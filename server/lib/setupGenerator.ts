import { SECRETS_POOL } from '../data/secretsPool';
import { ROMANCE_POOL } from '../data/romancePool';

// ─── Inline types (no cross-boundary imports from src/) ───────────────────────

export interface GeneratorAgent {
  name: string;
  age: number;
  personality: Record<string, number>;
  salary?: number;
  job?: string;
}

export interface SliderConfig {
  drama: number;   // 0-10
  romance: number; // 0-10
  crime: number;   // 0-10
  trust: number;   // 0-10
}

export interface GeneratedSecret {
  template_id: string;
  content: string;
  type: string;
  sensitivity: number;
  subject_index: number;
  target_index: number | null;
  known_by_indices: number[];
}

export interface RomanceThread {
  template_id: string;
  agent_indices: number[];
  romance_values: Array<{ from: number; to: number; value: number }>;
  friendship_deltas: Array<{ from: number; to: number; delta: number }>;
  trust_deltas: Array<{ from: number; to: number; delta: number }>;
  secret?: GeneratedSecret;
}

export interface GenerationResult {
  secrets: GeneratedSecret[];
  romanceThreads: RomanceThread[];
  /** agent index → adjusted starting money */
  economyAdjustments: Record<number, number>;
  /** agent index → { mood, stress } */
  moodAdjustments: Record<number, { mood: number; stress: number }>;
  /** placeholder for relationship data (future use) */
  relationships: Record<string, unknown>;
  /** trust delta applied to all baseline relationships */
  trustDelta: number;
  /** pairs of agent indices that become rivals */
  rivalPairs: Array<[number, number]>;
}

// ─── Configuration ─────────────────────────────────────────────────────────────
const DRAMA_SECRET_MULTIPLIER = 1.2;
const ROMANCE_THREAD_MULTIPLIER = 0.4;
const SENSITIVITY_BREAKPOINTS = { low: 3, medium: 6 } as const;
const ECONOMY_PERCENTILES = { rich: 0.25, poor: 0.75 } as const;
const TRUST_DELTA_MULTIPLIER = 6;
const RIVAL_PAIR_MULTIPLIER = 0.8;
const MOOD_LOW_AGENT_RATIO = 0.4;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Uniform float in [0,1). Injected so a world can regenerate its own scenario. */
export type RandomFn = () => number;

function shuffle<T>(arr: T[], rand: RandomFn): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function checkPersonalityConstraint(
  agent: GeneratorAgent,
  constraints: Record<string, number>,
  flexibility: number,
): boolean {
  for (const [axis, threshold] of Object.entries(constraints)) {
    const value = agent.personality[axis] ?? 50;
    if (threshold < 0) {
      // Negative threshold means "morality BELOW absolute value"
      if (value > Math.abs(threshold) + flexibility) return false;
    } else {
      if (value < threshold - flexibility) return false;
    }
  }
  return true;
}

// ─── Generator ────────────────────────────────────────────────────────────────

/**
 * Pure function — no DB access, no side effects.
 * Takes agent data and slider values, returns a GenerationResult.
 *
 * `rand` defaults to `Math.random`, but callers that need the same town twice —
 * the wizard preview and the `setup.initialize` that follows it, or a `restart`
 * of a saved world — must pass a seeded source or the preview describes a
 * scenario the player never gets.
 */
export function generateFromSliders(
  sliders: SliderConfig,
  agents: GeneratorAgent[],
  rand: RandomFn = Math.random,
): GenerationResult {
  const { drama, romance, crime, trust } = sliders;

  // ── 1. Secrets ──────────────────────────────────────────────────────────────
  const targetSecrets = Math.round(drama * DRAMA_SECRET_MULTIPLIER);
  const secrets: GeneratedSecret[] = [];

  if (targetSecrets > 0) {
    // The real secretsPool uses {subject}/{target} placeholders (no min_drama_level field).
    // We map sensitivity as a proxy for drama intensity: at low drama only sensitivity=1,
    // at higher drama include sensitivity=2 and 3.
    const maxSensitivity = drama <= SENSITIVITY_BREAKPOINTS.low ? 1 : drama <= SENSITIVITY_BREAKPOINTS.medium ? 2 : 3;
    const eligiblePool = SECRETS_POOL.filter(t => t.sensitivity <= maxSensitivity);
    const shuffledPool = shuffle(eligiblePool, rand);

    for (const template of shuffledPool) {
      if (secrets.length >= targetSecrets) break;

      const usedInThis = new Set<number>();

      // Pick subject (agent_a)
      const validSubjects = agents
        .map((_, i) => i)
        .filter(i => !usedInThis.has(i));
      if (validSubjects.length === 0) continue;
      const subjectIdx = validSubjects[Math.floor(rand() * validSubjects.length)];
      usedInThis.add(subjectIdx);

      // Pick target if template uses {target}
      let targetIdx: number | null = null;
      if (template.template.includes('{target}')) {
        const validTargets = agents
          .map((_, i) => i)
          .filter(i => !usedInThis.has(i));
        if (validTargets.length === 0) continue;
        targetIdx = validTargets[Math.floor(rand() * validTargets.length)];
        usedInThis.add(targetIdx);
      }

      const content = template.template
        .replace('{subject}', agents[subjectIdx].name)
        .replace('{target}', targetIdx !== null ? agents[targetIdx].name : '');

      // In the pool, {subject} is always the person whose line it is. For
      // "witness" secrets ("{subject} saw {target} sneaking out…") that is the
      // onlooker, but the scandal is about {target}: the fact must be about
      // them, known only to the witness. Stored the other way round, the
      // own-secret gossip filter silenced the one person who could tell it,
      // and the person seen was told they had been seen.
      const isSighting = template.category === 'witness' && targetIdx !== null;
      const factSubject = isSighting ? targetIdx! : subjectIdx;
      const factTarget = isSighting ? subjectIdx : targetIdx;
      const knownBy = isSighting ? [subjectIdx] : [subjectIdx, ...(targetIdx !== null ? [targetIdx] : [])];

      secrets.push({
        template_id: template.id,
        content,
        type: template.category,
        sensitivity: template.sensitivity,
        subject_index: factSubject,
        target_index: factTarget,
        known_by_indices: knownBy,
      });
    }
  }

  // ── 2. Romance threads ───────────────────────────────────────────────────────
  const targetRomance = Math.round(romance * ROMANCE_THREAD_MULTIPLIER);
  const romanceThreads: RomanceThread[] = [];
  const shuffledRomance = shuffle(ROMANCE_POOL, rand);
  const usedRomanceAgents = new Set<number>();

  for (const template of shuffledRomance) {
    if (romanceThreads.length >= targetRomance) break;

    const available = agents
      .map((a, i) => ({ agent: a, index: i }))
      .filter(({ index }) => !usedRomanceAgents.has(index));

    if (available.length < template.agent_count) continue;

    const candidates = shuffle(available, rand);
    const selected: number[] = [];

    for (const { agent, index } of candidates) {
      if (selected.length >= template.agent_count) break;
      const slotIdx = selected.length;

      // Personality check for this slot
      if (template.constraints?.[slotIdx]) {
        if (!checkPersonalityConstraint(agent, template.constraints[slotIdx], 10)) continue;
      }

      // Age gap check against first agent
      if (template.max_age_gap !== undefined && selected.length > 0) {
        const firstAge = agents[selected[0]].age;
        if (Math.abs(agent.age - firstAge) > template.max_age_gap) continue;
      }

      selected.push(index);
    }

    if (selected.length < template.agent_count) continue;

    const thread: RomanceThread = {
      template_id: template.id,
      agent_indices: selected,
      romance_values: template.romance_values.map(v => ({
        from: selected[v.from],
        to: selected[v.to],
        value: v.value,
      })),
      friendship_deltas: (template.friendship_adjustments ?? []).map(v => ({
        from: selected[v.from],
        to: selected[v.to],
        delta: v.delta,
      })),
      trust_deltas: (template.trust_adjustments ?? []).map(v => ({
        from: selected[v.from],
        to: selected[v.to],
        delta: v.delta,
      })),
    };

    // Create romance secret if template specifies one
    if (template.creates_secret && template.secret_template) {
      let secretContent = template.secret_template;
      selected.forEach((agentIdx, slotI) => {
        secretContent = secretContent.replace(`{agent_${slotI}}`, agents[agentIdx].name);
      });

      const knownBy = (template.known_by ?? []).map(k => {
        if (typeof k === 'number') return selected[k];
        // 'friend' — pick a random agent not in the thread
        const friends = agents.map((_, i) => i).filter(i => !selected.includes(i));
        return friends.length > 0
          ? friends[Math.floor(rand() * friends.length)]
          : selected[0];
      });

      thread.secret = {
        template_id: template.id,
        content: secretContent,
        type: 'romantic',
        sensitivity: template.secret_sensitivity ?? 1,
        subject_index: selected[0],
        target_index: selected.length > 1 ? selected[1] : null,
        known_by_indices: knownBy,
      };
    }

    romanceThreads.push(thread);
    selected.forEach(i => usedRomanceAgents.add(i));
  }

  // ── 3. Economy scaling ───────────────────────────────────────────────────────
  const economyAdjustments: Record<number, number> = {};
  // Use salary * 2.5 as base money (no startingMoney field on agents)
  const baseMoney = agents.map((a, i) => ({ index: i, money: (a.salary ?? 20) * 2.5 }));
  baseMoney.sort((a, b) => b.money - a.money);

  for (let i = 0; i < baseMoney.length; i++) {
    const { index } = baseMoney[i];
    if (crime <= 3) {
      // Flatten toward 60-80 — low inequality
      economyAdjustments[index] = 60 + Math.round(rand() * 20);
    } else if (crime >= 7) {
      // Amplify gaps — strong inequality
      const rank = i / baseMoney.length;
      if (rank < ECONOMY_PERCENTILES.rich) {
        economyAdjustments[index] = 100 + Math.round(rand() * 50);
      } else if (rank > ECONOMY_PERCENTILES.poor) {
        economyAdjustments[index] = 10 + Math.round(rand() * 15);
      } else {
        economyAdjustments[index] = 40 + Math.round(rand() * 30);
      }
    } else {
      // Moderate scaling
      const factor = crime / 5;
      const baseMoneyCurrent = baseMoney[i].money;
      const deviation = (baseMoneyCurrent - 60) * factor;
      economyAdjustments[index] = Math.round(60 + deviation);
    }
  }

  // ── 4. Trust calibration ──────────────────────────────────────────────────────
  const trustDelta = (trust - 5) * TRUST_DELTA_MULTIPLIER; // trust=0 → -30, trust=5 → 0, trust=10 → +30
  const rivalPairs: Array<[number, number]> = [];

  if (trust <= 3) {
    const numRivals = Math.round((4 - trust) * RIVAL_PAIR_MULTIPLIER);
    const agentIndices = shuffle(agents.map((_, i) => i), rand);
    for (let i = 0; i < numRivals * 2 && i + 1 < agentIndices.length; i += 2) {
      rivalPairs.push([agentIndices[i], agentIndices[i + 1]]);
    }
  }

  // ── 5. Mood adjustments ───────────────────────────────────────────────────────
  const moodAdjustments: Record<number, { mood: number; stress: number }> = {};
  const numLowMood = Math.round(drama * MOOD_LOW_AGENT_RATIO);
  const moodTargets = new Set(shuffle(agents.map((_, i) => i), rand).slice(0, numLowMood));

  for (let i = 0; i < agents.length; i++) {
    if (moodTargets.has(i)) {
      moodAdjustments[i] = {
        mood: 30 + Math.round(rand() * 15),
        stress: 40 + Math.round(rand() * 20),
      };
    } else {
      const baseMoodVal = 55 + Math.round((10 - drama) * 2);
      moodAdjustments[i] = {
        mood: Math.min(80, baseMoodVal + Math.round(rand() * 10)),
        stress: 10 + Math.round(rand() * 15),
      };
    }
  }

  return {
    secrets,
    romanceThreads,
    economyAdjustments,
    moodAdjustments,
    relationships: {},
    trustDelta,
    rivalPairs,
  };
}
