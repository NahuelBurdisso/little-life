export interface PersonalityAxes {
  honesty: number;
  aggression: number;
  warmth: number;
  impulsiveness: number;
  vanity: number;
  curiosity: number;
  loyalty: number;
  morality: number;
  sensuality: number;
  neuroticism: number;
}

const AXIS_VOICE_MAP: Record<string, { high: string; low: string }> = {
  honesty:       { high: 'You say exactly what you think, even if it hurts. You never sugarcoat.', low: 'You dodge, deflect, and bend the truth when convenient. You tell people what they want to hear.' },
  aggression:    { high: "You're blunt and confrontational. You don't back down. Your words have edges.", low: "You're soft-spoken and avoid conflict. You go along to get along." },
  warmth:        { high: 'You ask how people are doing. You use their name. You remember small things about them.', low: "You keep it transactional. No chitchat. You don't pretend to care." },
  impulsiveness: { high: 'You blurt things out. You change topics mid-sentence. You act before thinking.', low: 'You pause before speaking. You choose words carefully. You never say more than necessary.' },
  vanity:        { high: 'You steer conversations toward yourself. You mention your achievements. You fish for compliments.', low: "You deflect attention. You don't talk about yourself unless pressed." },
  curiosity:     { high: 'You ask a lot of questions. You pry into details. You want to know everything.', low: "You don't ask unless it matters. You let people keep their business." },
  loyalty:       { high: "You defend your people fiercely, even when they're wrong. Betrayal is unforgivable.", low: 'You look out for yourself first. Alliances shift.' },
  morality:      { high: "You judge. You can't let bad behavior slide. You bring up what's right.", low: "You don't moralize. Rules are for other people. You see angles, not ethics." },
  sensuality:    { high: 'You flirt easily. You compliment appearance. You lean in when talking.', low: "You keep physical distance. Romance makes you awkward." },
  neuroticism:   { high: 'You overthink. You circle back to worries. You catastrophize small things.', low: "You're steady. Nothing rattles you. You shrug off problems." },
};

// Personality combo voices — when two axes are both extreme, use richer description
const COMBO_VOICES: Array<{ axisA: string; dirA: 'high' | 'low'; axisB: string; dirB: 'high' | 'low'; voice: string }> = [
  { axisA: 'honesty', dirA: 'high', axisB: 'aggression', dirB: 'high', voice: "You're brutally frank. You say exactly what others are afraid to say, and you don't care if it stings." },
  { axisA: 'warmth', dirA: 'high', axisB: 'curiosity', dirB: 'high', voice: "You're genuinely fascinated by people. You ask deep questions because you truly care about the answers." },
  { axisA: 'vanity', dirA: 'high', axisB: 'sensuality', dirB: 'high', voice: "You're a flirtatious show-off. Every conversation is a stage and everyone is your audience." },
  { axisA: 'warmth', dirA: 'high', axisB: 'aggression', dirB: 'high', voice: "Tough love is your style. You care deeply but express it through bluntness, not softness." },
  { axisA: 'neuroticism', dirA: 'high', axisB: 'warmth', dirB: 'high', voice: "You worry about everyone. You can't relax until you know the people you love are okay." },
  { axisA: 'morality', dirA: 'high', axisB: 'aggression', dirB: 'high', voice: "You're a righteous crusader. You will publicly call out anyone doing wrong and won't back down." },
  { axisA: 'impulsiveness', dirA: 'high', axisB: 'sensuality', dirB: 'high', voice: "You live in the moment. You flirt on impulse, say yes to everything, and regret nothing." },
  { axisA: 'loyalty', dirA: 'high', axisB: 'aggression', dirB: 'high', voice: "Cross someone you love and you'll make their life hell. Your loyalty is fierce and your grudges eternal." },
  { axisA: 'honesty', dirA: 'low', axisB: 'curiosity', dirB: 'high', voice: "You're a social spy. You ask lots of questions but reveal nothing about yourself." },
  { axisA: 'morality', dirA: 'low', axisB: 'vanity', dirB: 'high', voice: "You're a charming schemer. You use compliments and flattery to get what you want." },
];

// Speech pattern hints based on personality
function buildSpeechPattern(personality: PersonalityAxes): string {
  const patterns: string[] = [];
  if (personality.impulsiveness > 65) patterns.push('short sentences, exclamation marks');
  if (personality.neuroticism > 65) patterns.push('"maybe", "I think", hedging language');
  if (personality.vanity > 65) patterns.push('"Well, I...", self-references');
  if (personality.warmth < 35) patterns.push('curt responses, few questions');
  if (personality.aggression > 65) patterns.push('swearing, confrontational tone');
  if (personality.sensuality > 65) patterns.push('suggestive language, playful teasing');
  if (patterns.length === 0) return '';
  return `Speech style: ${patterns.join(', ')}.`;
}

const HIGH_THRESHOLD = 65;
const LOW_THRESHOLD = 35;
const MAX_AXES = 3;

const cache = new Map<number, { directive: string; hash: string }>();

function computeHash(personality: PersonalityAxes): string {
  return JSON.stringify(personality);
}

export function generateVoiceDirective(agentId: number, personality: PersonalityAxes): string {
  const hash = computeHash(personality);
  const cached = cache.get(agentId);
  if (cached && cached.hash === hash) return cached.directive;

  const phrases: string[] = [];

  // Check for personality combos first (richer than individual axes)
  const usedAxes = new Set<string>();
  for (const combo of COMBO_VOICES) {
    const valA = (personality as any)[combo.axisA] as number;
    const valB = (personality as any)[combo.axisB] as number;
    const matchA = combo.dirA === 'high' ? valA >= HIGH_THRESHOLD : valA <= LOW_THRESHOLD;
    const matchB = combo.dirB === 'high' ? valB >= HIGH_THRESHOLD : valB <= LOW_THRESHOLD;
    if (matchA && matchB && !usedAxes.has(combo.axisA) && !usedAxes.has(combo.axisB)) {
      phrases.push(combo.voice);
      usedAxes.add(combo.axisA);
      usedAxes.add(combo.axisB);
      if (phrases.length >= 2) break; // max 2 combos
    }
  }

  // Fill remaining slots with individual axis voices
  const scored: Array<{ axis: string; distance: number; value: number }> = [];
  for (const [axis, value] of Object.entries(personality)) {
    if (!(axis in AXIS_VOICE_MAP)) continue;
    if (usedAxes.has(axis)) continue; // skip axes already used in combos
    const distance = Math.abs(value - 50);
    if (value >= HIGH_THRESHOLD || value <= LOW_THRESHOLD) {
      scored.push({ axis, distance, value });
    }
  }
  scored.sort((a, b) => b.distance - a.distance);
  const remaining = MAX_AXES - phrases.length;
  for (const { axis, value } of scored.slice(0, remaining)) {
    const mapping = AXIS_VOICE_MAP[axis];
    phrases.push(value >= HIGH_THRESHOLD ? mapping.high : mapping.low);
  }

  // Add speech pattern hints
  const speechPattern = buildSpeechPattern(personality);
  if (speechPattern) phrases.push(speechPattern);

  const directive = phrases.join(' ');
  cache.set(agentId, { directive, hash });
  return directive;
}

export function clearVoiceDirectiveCache(): void {
  cache.clear();
}
