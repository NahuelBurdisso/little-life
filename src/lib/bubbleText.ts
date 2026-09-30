/**
 * What fits in a speech bubble over an agent's head.
 *
 * Bubbles cut every line at 60 characters, mid-word ("That blue sweater makes
 * your eyes lo…"). With Gemma 4 26B a typical line is 1-2 sentences, ~130
 * characters, so almost every bubble was a broken fragment. Now: whole
 * sentences while they fit, otherwise the first sentence cut at a word
 * boundary. The full line is still in the conversation panel.
 */
export function bubbleText(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;

  // Whole sentences, as many as fit.
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)\s*/g) ?? [clean];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > maxChars) break;
    out += s;
  }
  if (out.trim()) return out.trim();

  // First sentence alone is too long: cut at the last word that fits.
  const room = clean.slice(0, maxChars - 1);
  const lastSpace = room.lastIndexOf(' ');
  const cut = (lastSpace > maxChars * 0.5 ? room.slice(0, lastSpace) : room).replace(/[\s,;:—–-]+$/, '');
  return `${cut}…`;
}

/** Horizontal gap (px) between neighbouring speakers' bubbles in one conversation. */
const BUBBLE_SLOT_PX = 24;

/**
 * Sideways shift of speaker `i`'s bubble among `n` talkers, centred on 0. It used to be a flat
 * +-20 for participant 0 vs everyone else, so a third speaker's bubble landed exactly on the
 * second's. A lone speaker (or an unknown index) stays centred.
 */
export function bubbleOffsetX(i: number, n: number): number {
  if (n <= 1 || i < 0 || i >= n) return 0;
  return (i - (n - 1) / 2) * BUBBLE_SLOT_PX;
}

/**
 * Tone of the bubble for `speakerId`'s newest line: that message's own sentiment, falling back
 * to the conversation's. `convo.sentiment` is inserted as 0 and only averaged when the chat ends,
 * so on its own every live bubble looked neutral.
 */
export function speakerSentiment(
  messages: ReadonlyArray<{ speakerId?: number; sentiment?: number | null }> | undefined,
  speakerId: number,
  fallback: number | null | undefined,
): number {
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.speakerId === speakerId && typeof m.sentiment === "number" && Number.isFinite(m.sentiment)) return m.sentiment;
    }
  }
  return fallback ?? 0;
}

/** Bounds and pace of a speech bubble's lifetime (see `bubbleDurationMs`). */
const BUBBLE_BASE_MS = 1500;
const BUBBLE_MS_PER_CHAR = 55;
const BUBBLE_MIN_MS = 3500;
const BUBBLE_MAX_MS = 7000;

/**
 * How long a bubble stays up for `chars` characters of text. It was a fixed 4 s,
 * which cut a four-line line off mid-read while a two-word "Hi, Ana!" lingered as
 * long. 55 ms a character is a slow-ish reading pace for a glance at a busy map;
 * the floor keeps a short line visible long enough to notice, the cap stops a
 * long one from parking over a head once the next speaker is due.
 */
export function bubbleDurationMs(chars: number): number {
  const n = Number.isFinite(chars) ? Math.max(0, chars) : 0;
  return Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, BUBBLE_BASE_MS + BUBBLE_MS_PER_CHAR * n));
}
