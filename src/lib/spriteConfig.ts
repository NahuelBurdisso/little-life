export const TILE_SIZE = 32;
export const AGENT_RADIUS = 8;

export function getAgentColor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return hslToHex(hue, 0.6, 0.5);
}

const MOOD_STOPS = [
  { mood: 0,   color: 0x1a1a2e },
  { mood: 25,  color: 0x4a3f5c },
  { mood: 50,  color: 0x7a6f5a },
  { mood: 75,  color: 0xc4a35a },
  { mood: 100, color: 0xe8d5a3 },
];

export function getMoodColor(mood: number): number {
  const clamped = Math.max(0, Math.min(100, mood));
  for (let i = 0; i < MOOD_STOPS.length - 1; i++) {
    const a = MOOD_STOPS[i], b = MOOD_STOPS[i + 1];
    if (clamped <= b.mood) {
      const t = (clamped - a.mood) / (b.mood - a.mood);
      return lerpColor(a.color, b.color, t);
    }
  }
  return MOOD_STOPS[MOOD_STOPS.length - 1].color;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (Math.round(ar + (br - ar) * t) << 16) |
         (Math.round(ag + (bg - ag) * t) << 8) |
         Math.round(ab + (bb - ab) * t);
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color);
  };
  return (f(0) << 16) + (f(8) << 8) + f(4);
}
