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
