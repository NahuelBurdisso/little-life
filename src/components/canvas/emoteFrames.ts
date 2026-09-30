/**
 * Cell layout of `/sprites/fx/emotes.png` (scripts/aseprite/emotes.lua) and the timing of
 * each emote's little animation. Pure — no PixiJS — so it can be unit tested.
 *
 * The table below is the single source of truth on the client; the `-- ORDER:` line in the Lua
 * header must list the same names with the same frame counts (a test parses it). Cells are
 * packed back to back in this order, so a name's frames are a contiguous run.
 */

/** name, frame count, playback fps. Order = order in the strip. */
const SPEC = [
  ['heart', 3, 5],
  ['anger', 3, 6],
  ['laugh', 2, 6],
  ['wave', 2, 5],
  ['question', 2, 4],
  ['exclaim', 2, 6],
  ['zzz', 4, 4],
  ['cry', 3, 5],
  ['sparkle', 3, 6],
  ['fish', 2, 4],
  ['flower', 2, 3],
  ['music', 3, 5],
  ['sweat', 3, 5],
  ['money', 2, 4],
  ['skull', 2, 3],
  ['fire', 3, 7],
  ['star', 3, 5],
  ['drink', 2, 4],
  ['sick', 2, 4],
  ['think', 3, 3],
  ['work', 3, 6],
  // Added for the story-beat / tool / event systems.
  ['gift', 2, 4],
  ['handcuffs', 2, 5],
  ['whisper', 3, 4],
  ['levelup', 4, 7],
  ['candle', 3, 6],
  ['cake', 2, 4],
  ['broken_heart', 3, 4],
  ['dizzy', 3, 6],
  // Suggestive-only romance emotes (adult-content layer, Phase 4): flushed cheeks, lips, an eye.
  ['blush', 3, 4],
  ['kiss', 3, 5],
  ['wink', 3, 4],
] as const;

export type EmoteName = (typeof SPEC)[number][0];

/** Every emote the atlas can draw — reference these instead of retyping strings. */
export const EMOTE_NAMES: readonly EmoteName[] = SPEC.map(s => s[0]);

export interface EmoteAnim {
  /** Cell indices into the strip, in playback order. */
  frames: number[];
  fps: number;
}

export const EMOTE_FRAMES = ((): Record<EmoteName, EmoteAnim> => {
  const out = {} as Record<EmoteName, EmoteAnim>;
  let next = 0;
  for (const [name, count, fps] of SPEC) {
    out[name] = { frames: Array.from({ length: count }, (_, i) => next + i), fps };
    next += count;
  }
  return out;
})();

export const EMOTE_FRAME_COUNT = SPEC.reduce((n, s) => n + s[1], 0);
export const EMOTE_CELL = 16;
export const EMOTES_URL = '/sprites/fx/emotes.png';

export function isEmoteName(name: string): name is EmoteName {
  return Object.prototype.hasOwnProperty.call(EMOTE_FRAMES, name);
}

/**
 * Cell to show `elapsedMs` after the emote started, looping. Null for names the atlas does
 * not know, so callers can fall back to the emoji glyph.
 */
export function emoteFrameAt(name: string, elapsedMs: number): number | null {
  if (!isEmoteName(name)) return null;
  const { frames, fps } = EMOTE_FRAMES[name];
  if (!(elapsedMs > 0)) return frames[0]; // negative and NaN both start at the top
  return frames[Math.floor((elapsedMs * fps) / 1000) % frames.length];
}

/**
 * OS-emoji stand-ins for the emotes that existed before the atlas. Drawn as `PIXI.Text` only
 * while the atlas is loading or if it failed to load; names outside this map render "?".
 */
export const EMOTE_EMOJI_FALLBACK: Record<string, string> = {
  heart: '❤️',
  anger: '😡',
  laugh: '😂',
  wave: '👋',
  question: '❓',
  exclaim: '❗',
  zzz: '💤',
  cry: '😢',
  sparkle: '✨',
  fish: '🐟',
  flower: '🌸',
  music: '🎵',
  sweat: '💧',
  money: '💰',
  skull: '💀',
  fire: '🔥',
  star: '⭐',
  drink: '🍺',
  sick: '🤢',
  think: '💭',
  work: '🔨',
  gift: '🎁',
  handcuffs: '⛓️',
  whisper: '🤫',
  levelup: '🆙',
  candle: '🕯️',
  cake: '🎂',
  broken_heart: '💔',
  dizzy: '😵',
  blush: '😊',
  kiss: '💋',
  wink: '😉',
};
