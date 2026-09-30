import { clamp } from './utils';

export interface PersonalityProfile {
  honesty: number;       // 0-100
  aggression: number;    // 0-100
  warmth: number;        // 0-100
  impulsiveness: number; // 0-100
  vanity: number;        // 0-100
  curiosity: number;     // 0-100
  loyalty: number;       // 0-100
  morality: number;      // 0-100
  sensuality: number;    // 0-100
  neuroticism: number;   // 0-100
}

export const AXIS_DESCRIPTIONS: Record<keyof PersonalityProfile, { low: string; high: string }> = {
  honesty: {
    low: "You lie easily and naturally. You hide your real motives. You gossip and spread rumors when it serves you.",
    high: "You're blunt to a fault. You can't keep secrets. You say what you think even when it hurts.",
  },
  aggression: {
    low: "You avoid conflict at all costs. You apologize even when you're right. You'd rather suffer in silence.",
    high: "You have a short temper. You pick fights when irritated. You hold grudges for a long time.",
  },
  warmth: {
    low: "You're emotionally distant. You don't comfort people. Physical affection makes you uncomfortable.",
    high: "You're openly affectionate. You comfort people naturally. You express care through touch and words.",
  },
  impulsiveness: {
    low: "You stick to routine. You plan ahead. You rarely do anything spontaneous.",
    high: "You act on impulse. You break your own schedule. You spend money you shouldn't. You say things you regret.",
  },
  vanity: {
    low: "You don't care what others think of you. You're self-deprecating. Status means nothing to you.",
    high: "You care deeply about how others see you. Compliments fuel you. Insults devastate you. You show off.",
  },
  curiosity: {
    low: "You mind your own business. You don't ask personal questions. You stick to what you know.",
    high: "You're nosy. You ask personal questions. You dig into other people's lives. You love discovering secrets.",
  },
  loyalty: {
    low: "You're out for yourself. You switch allegiances easily. You don't feel guilt about betrayal.",
    high: "You're fiercely loyal to your friends. You forgive allies easily. You defend them even when they're wrong.",
  },
  morality: {
    low: "You don't have a strong moral code. You cheat when convenient. You exploit situations for personal gain.",
    high: "You have strong principles. You judge others who behave badly. You sacrifice your own interests to do what's right.",
  },
  sensuality: {
    low: "You're reserved about attraction. You don't flirt. Romance makes you uncomfortable.",
    high: "You're openly flirtatious. You express attraction directly. You seek pleasure and physical closeness.",
  },
  neuroticism: {
    low: "You're emotionally stable. Stress doesn't faze you. You recover from setbacks quickly.",
    high: "You overthink everything. Your mood swings are intense. You catastrophize small problems. You ruminate on past hurts.",
  },
};

interface AxisCombo {
  axisA: keyof PersonalityProfile;
  conditionA: 'high' | 'low';
  axisB: keyof PersonalityProfile;
  conditionB: 'high' | 'low';
  description: string;
}

export const AXIS_COMBOS: AxisCombo[] = [
  {
    axisA: 'aggression', conditionA: 'high',
    axisB: 'honesty', conditionB: 'low',
    description: "You're passive-aggressive — you smile while twisting the knife. You undermine people indirectly.",
  },
  {
    axisA: 'warmth', conditionA: 'high',
    axisB: 'sensuality', conditionB: 'high',
    description: "You're openly romantic and physically affectionate. You flirt naturally and pursue attraction directly.",
  },
  {
    axisA: 'curiosity', conditionA: 'high',
    axisB: 'morality', conditionB: 'low',
    description: "You're a manipulative gossip. You dig for secrets and use them. You exploit what you learn about people.",
  },
  {
    axisA: 'neuroticism', conditionA: 'high',
    axisB: 'vanity', conditionB: 'high',
    description: "Your ego is fragile. Insults send you spiraling. You obsess over perceived slights for days.",
  },
  {
    axisA: 'loyalty', conditionA: 'high',
    axisB: 'aggression', conditionB: 'high',
    description: "You're protective. You fight for the people you care about. Cross your friends and you make an enemy for life.",
  },
  {
    axisA: 'impulsiveness', conditionA: 'low',
    axisB: 'morality', conditionB: 'high',
    description: "You're the town's moral compass. Predictable, principled, and quick to judge those who aren't.",
  },
  {
    axisA: 'impulsiveness', conditionA: 'high',
    axisB: 'sensuality', conditionB: 'high',
    description: "You're a reckless romantic. You fall hard and fast. You chase pleasure without thinking about consequences.",
  },
  {
    axisA: 'warmth', conditionA: 'high',
    axisB: 'neuroticism', conditionB: 'high',
    description: "You care deeply but worry constantly. You smother people with concern. You take rejection very hard.",
  },
  {
    axisA: 'warmth', conditionA: 'low',
    axisB: 'aggression', conditionB: 'high',
    description: "You're intimidating. Cold and confrontational. People avoid provoking you.",
  },
  {
    axisA: 'honesty', conditionA: 'high',
    axisB: 'aggression', conditionB: 'high',
    description: "You're brutally honest. You don't sugarcoat anything. People respect you but you make enemies easily.",
  },
];

export function buildPersonalityDescription(personality: PersonalityProfile, traits: string[]): string {
  const parts: string[] = [];

  // Individual axis descriptions
  for (const [axis, value] of Object.entries(personality) as [keyof PersonalityProfile, number][]) {
    if (value > 70) parts.push(AXIS_DESCRIPTIONS[axis].high);
    else if (value < 30) parts.push(AXIS_DESCRIPTIONS[axis].low);
  }

  // Combination descriptions
  for (const combo of AXIS_COMBOS) {
    const valA = personality[combo.axisA];
    const valB = personality[combo.axisB];
    const matchA = combo.conditionA === 'high' ? valA > 70 : valA < 30;
    const matchB = combo.conditionB === 'high' ? valB > 70 : valB < 30;
    if (matchA && matchB) parts.push(combo.description);
  }

  // Freeform traits
  if (traits.length > 0) {
    const last = traits[traits.length - 1];
    const rest = traits.slice(0, -1);
    parts.push(`People describe you as ${rest.length > 0 ? rest.join(', ') + ', and ' : ''}${last}.`);
  }

  return parts.join(' ');
}

export function calculateCompatibility(a: PersonalityProfile, b: PersonalityProfile): number {
  let score = 1.0;

  const honestyGap = Math.abs(a.honesty - b.honesty);
  score += (100 - honestyGap) / 200;

  const warmthGap = Math.abs(a.warmth - b.warmth);
  score -= warmthGap / 400;

  if (a.aggression > 70 && b.aggression < 30) score -= 0.3;
  if (b.aggression > 70 && a.aggression < 30) score -= 0.3;

  if (a.sensuality > 60 && b.sensuality > 60) score += 0.3;

  const moralityGap = Math.abs(a.morality - b.morality);
  if (moralityGap > 50) score -= 0.2;

  if (a.curiosity > 60 && b.curiosity > 60) score += 0.15;

  return clamp(score, 0.5, 2.0);
}

// Decision system scoring modifier helpers

export function loyaltyBonus(loyalty: number, targetFriendship: number): number {
  if (loyalty < 50 || targetFriendship < 50) return 0;
  return (loyalty / 100) * (targetFriendship / 100) * 30; // up to +30
}

export function sensualityBonus(sensuality: number, targetRomance: number): number {
  if (sensuality < 40 || targetRomance < 20) return 0;
  return (sensuality / 100) * (targetRomance / 100) * 25; // up to +25
}

export function curiosityNoveltyBonus(curiosity: number, interactionCount: number): number {
  if (curiosity < 50) return 0;
  const novelty = Math.max(0, 20 - interactionCount); // higher for strangers
  return (curiosity / 100) * novelty; // up to +20
}

// ─── Situational Prompt Types ────────────────────────────────────────────────

export interface SituationalContext {
  type: 'blackmail' | 'jealousy_confrontation' | 'affair_discovery' |
        'begging' | 'confession' | 'theft_confrontation' |
        'price_gouging' | 'drunk_confrontation' | 'reconciliation' | 'suspicion_confrontation' | null;
  targetName?: string;
  rivalName?: string;
  loveInterestName?: string;
  factContent?: string;
  sinDescription?: string;
  itemName?: string;
  shopOwnerName?: string;
  incidentDescription?: string;
}

export function generateSituationalPrompt(ctx: SituationalContext): string | null {
  switch (ctx.type) {
    case 'blackmail':
      return `You know ${ctx.targetName}'s secret: ${ctx.factContent}. You want money to keep quiet.`;
    case 'jealousy_confrontation':
      return `You're jealous because ${ctx.loveInterestName} is close to ${ctx.rivalName}. You want to confront them.`;
    case 'affair_discovery':
      return `You just discovered your partner ${ctx.targetName} has been seeing ${ctx.rivalName}. You're devastated and furious.`;
    case 'begging':
      return `You're broke and desperate. You need to ask ${ctx.targetName} for help. You hate having to do this.`;
    case 'confession':
      return `You can't keep this secret anymore. You need to tell ${ctx.targetName} about ${ctx.sinDescription}. The guilt is eating you.`;
    case 'theft_confrontation':
      return `You saw ${ctx.targetName} steal from ${ctx.shopOwnerName}. Decide whether to say something.`;
    case 'price_gouging':
      return `${ctx.shopOwnerName} is charging double for ${ctx.itemName}. You think it's unfair.`;
    case 'drunk_confrontation':
      return `You're drunk and angry at ${ctx.targetName}. Old resentments are surfacing.`;
    case 'suspicion_confrontation':
      return `You suspect ${ctx.targetName} is hiding something about where they spend their nights. You want a straight answer, and you will know if it is not one.`;
    case 'reconciliation':
      return `You used to be close with ${ctx.targetName} before ${ctx.incidentDescription}. They seem to have changed. Consider whether to forgive them.`;
    default:
      return null;
  }
}

export function selectPersonalityTopic(
  personality: PersonalityProfile,
  mood: number,
  targetFriendship: number,
  targetRomance: number,
  agents: Array<{ name: string }>,
  recentDrama?: string | null,
): string | null {
  // Priority 0: Recent drama overrides everything (if provided)
  if (recentDrama && Math.random() < 0.6) return recentDrama;

  // Priority 1: Dramatic personality-driven topics (these trigger LLM)
  if (personality.sensuality > 60 && targetRomance > 30) return 'flirting';
  if (personality.aggression > 60 && targetFriendship < -20) return 'confrontation';
  if (personality.neuroticism > 60 && mood < 30) return 'venting worries';
  if (personality.honesty < 30 && personality.curiosity > 60 && agents.length > 0) {
    const randomAgent = agents[Math.floor(Math.random() * agents.length)];
    return `gossip about ${randomAgent.name}`;
  }

  // Priority 2: Emotional state topics
  if (mood < 25) return 'seeking comfort';
  if (mood > 85) return 'celebrating';

  // Priority 3: Relationship-based topics
  if (targetFriendship > 70) {
    const closeFriendTopics = ['reminiscing', 'sharing secrets', 'making plans', 'deep conversation'];
    return closeFriendTopics[Math.floor(Math.random() * closeFriendTopics.length)];
  }
  if (targetRomance > 15) return 'flirting';
  if (targetFriendship < 0) return 'tension';

  // Priority 4: Personality-flavored general topics (randomized)
  const pool: string[] = [];
  if (personality.curiosity > 50) pool.push('town news', 'asking questions', 'local rumors');
  if (personality.warmth > 50) pool.push('checking in', 'offering help', 'complimenting');
  if (personality.vanity > 50) pool.push('bragging', 'seeking validation', 'comparing lives');
  if (personality.morality > 60) pool.push('community values', 'right and wrong');
  if (personality.impulsiveness > 50) pool.push('spontaneous idea', 'wild story', 'dare');
  if (personality.loyalty > 60 && targetFriendship > 30) pool.push('catching up', 'inside joke');

  if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

  // Final fallback
  const fallbacks = ['weather', 'daily life', 'food', 'work', 'weekend plans', 'memories', 'the farm'];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}
