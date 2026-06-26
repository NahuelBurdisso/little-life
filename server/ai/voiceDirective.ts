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
