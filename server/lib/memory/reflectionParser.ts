const PREAMBLE_PREFIXES = [
  'here are',
  'based on',
  'from the',
  'given',
  'considering',
  'looking at',
  'reflecting on',
  'my questions',
  'my insights',
  'the following',
  'these are',
];

function isPreamble(line: string): boolean {
  const lower = line.toLowerCase();
  return PREAMBLE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function stripPrefix(line: string): string {
  // Strip numbered prefixes: "1." or "1)"
  let stripped = line.replace(/^\d+[.)]\s*/, '');
  // Strip bullet prefixes: "- ", "• ", "* "
  stripped = stripped.replace(/^[-•*]\s*/, '');
  return stripped.trim();
}

function splitAndClean(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !isPreamble(l))
    .map(stripPrefix)
    .filter((l) => l.length > 0);
}

/** The object of a structured-output reply, or null for the older line format. */
function jsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Markdown the model adds for emphasis; the text is stored as a thought. */
function plain(text: string): string {
  return text.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
}

export function parseQuestions(raw: string): string[] {
  if (!raw.trim()) return [];
  const json = jsonObject(raw);
  if (json && Array.isArray(json.questions)) {
    return json.questions
      .filter((q): q is string => typeof q === 'string')
      .map(plain)
      .filter((q) => q.length > 0)
      .slice(0, 3);
  }
  const lines = splitAndClean(raw);
  return lines.slice(0, 3);
}

// Citation patterns tried in order; first match wins.
// Each returns { text, citations } or null.
type CitationMatch = { text: string; citations: number[] } | null;

function matchBecauseOf(line: string): CitationMatch {
  // (because of 1, 5, 12) — can appear anywhere in the line, not just at end
  const re = /\s*\(because of\s+([\d,\s]+)\)/i;
  const m = line.match(re);
  if (!m) return null;
  const citations = m[1].split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
  const text = line.replace(re, '').trim();
  return { text, citations };
}

function matchParenNumbers(line: string): CitationMatch {
  // (1, 5, 12) anywhere — but NOT "(because of ...)" which is handled above
  if (/\(because of/i.test(line)) return null;
  const re = /\s*\(([\d,\s]+)\)/;
  const m = line.match(re);
  if (!m) return null;
  const citations = m[1].split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
  if (citations.length === 0) return null;
  const text = line.replace(re, '').trim();
  return { text, citations };
}

function matchBracketNumbers(line: string): CitationMatch {
  // [1, 5, 12] anywhere
  const re = /\s*\[([\d,\s]+)\]/;
  const m = line.match(re);
  if (!m) return null;
  const citations = m[1].split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
  if (citations.length === 0) return null;
  const text = line.replace(re, '').trim();
  return { text, citations };
}

function matchBasedOnMemories(line: string): CitationMatch {
  // based on memories 1, 5, 12
  const re = /\s+based on memories\s+([\d,\s]+)\s*$/i;
  const m = line.match(re);
  if (!m) return null;
  const citations = m[1].split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n));
  const text = line.replace(re, '').trim();
  return { text, citations };
}

function extractCitations(line: string): { text: string; citations: number[] } {
  const result =
    matchBecauseOf(line) ??
    matchParenNumbers(line) ??
    matchBracketNumbers(line) ??
    matchBasedOnMemories(line);

  if (result) return result;
  return { text: line.trim(), citations: [] };
}

export function parseInsights(raw: string): Array<{ text: string; citations: number[] }> {
  if (!raw.trim()) return [];

  const json = jsonObject(raw);
  if (json && Array.isArray(json.insights)) {
    return (json.insights as Array<Record<string, unknown>>)
      .map((i) => ({
        // The model sometimes repeats its citations inside the sentence
        // ("…lost in my own head (15).") — they are in `because` already.
        text: typeof i?.insight === 'string'
          ? plain(i.insight).replace(/\s*\(\d+(?:\s*,\s*\d+)*\)(?=[.!?]?$)/, '')
          : '',
        citations: Array.isArray(i?.because)
          ? [...new Set(i.because.filter((n): n is number => Number.isInteger(n)))]
          : [],
      }))
      .filter((entry) => entry.text.length >= 5);
  }

  const lines = splitAndClean(raw);

  return lines
    .map((line) => extractCitations(line))
    .filter((entry) => entry.text.length >= 5);
}
