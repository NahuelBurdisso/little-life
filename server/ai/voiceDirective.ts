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
  honesty:       { high: 'You say exactly what you think, even if it hurts.', low: 'You dodge, deflect, and lie when convenient.' },
  aggression:    { high: "You're blunt and confrontational.", low: "You're soft-spoken and avoid conflict." },
  warmth:        { high: 'You ask how people are doing. You touch their arm when you talk.', low: 'You keep it transactional. No chitchat.' },
  impulsiveness: { high: 'You blurt things out. You interrupt.', low: 'You pause before speaking. You choose words carefully.' },
  vanity:        { high: 'You steer conversations toward yourself.', low: "You deflect compliments. You don't talk about yourself." },
  curiosity:     { high: 'You ask a lot of questions. You pry.', low: "You don't ask. You wait for people to volunteer." },
  loyalty:       { high: "You defend your people even when they're wrong.", low: 'You look out for yourself first.' },
  morality:      { high: "You judge. You can't let bad behavior slide.", low: "You don't moralize. Rules are suggestions." },
  sensuality:    { high: 'You flirt easily. You use innuendo.', low: "You're awkward about anything intimate." },
  neuroticism:   { high: 'You overthink. You circle back to worries.', low: "You're steady. Things roll off you." },
};

const HIGH_THRESHOLD = 70;
const LOW_THRESHOLD = 30;
const MAX_AXES = 3;

const cache = new Map<number, { directive: string; hash: string }>();

function computeHash(personality: PersonalityAxes): string {
  return JSON.stringify(personality);
}

export function generateVoiceDirective(agentId: number, personality: PersonalityAxes): string {
  const hash = computeHash(personality);
  const cached = cache.get(agentId);
  if (cached && cached.hash === hash) return cached.directive;

  const scored: Array<{ axis: string; distance: number; value: number }> = [];
  for (const [axis, value] of Object.entries(personality)) {
    if (!(axis in AXIS_VOICE_MAP)) continue;
    const distance = Math.abs(value - 50);
    if (value >= HIGH_THRESHOLD || value <= LOW_THRESHOLD) {
      scored.push({ axis, distance, value });
    }
  }

  scored.sort((a, b) => b.distance - a.distance);
  const top = scored.slice(0, MAX_AXES);

  const phrases = top.map(({ axis, value }) => {
    const mapping = AXIS_VOICE_MAP[axis];
    return value >= HIGH_THRESHOLD ? mapping.high : mapping.low;
  });

  const directive = phrases.join(' ');
  cache.set(agentId, { directive, hash });
  return directive;
}

export function clearVoiceDirectiveCache(): void {
  cache.clear();
}
