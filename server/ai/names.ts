/**
 * Name helpers shared by the dialogue prompt, the sanitiser and the memory gist.
 *
 * Townsfolk can carry a title ("Dr. Sofia Petrov"). Taking the first word as the
 * first name gave "Dr.": the prompt labelled her lines "Dr.: …", a "[Your Name]"
 * placeholder became "Dr.", and a wrong vocative "Sofia," was never recognised
 * as her name. Pure, no I/O.
 */

const HONORIFIC = /^(?:dr|mr|mrs|ms|miss|prof|rev|sir)\.?$/i;

/** "Dr. Sofia Petrov" → "Sofia Petrov". A bare title is kept as-is. */
export function withoutHonorific(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && HONORIFIC.test(parts[0])) parts.shift();
  return parts.join(' ');
}

/** "Dr. Sofia Petrov" → "Sofia"; "Omar Haddad" → "Omar". */
export function firstName(fullName: string): string {
  return withoutHonorific(fullName).split(' ')[0] ?? '';
}

/**
 * Every way a speaker's own name can open a line or a dialogue tag, longest
 * first: "Dr. Sofia Petrov", "Sofia Petrov", "Sofia".
 */
export function nameVariants(fullName: string): string[] {
  const full = fullName.trim();
  return [...new Set([full, withoutHonorific(full), firstName(full)])].filter(Boolean);
}

/**
 * What the town calls someone to their face: the first name, or title +
 * surname for a titled resident ("Dr. Sofia Petrov" → "Dr. Petrov"; a knight
 * is "Sir John"). The dialogue prompt names the listener this way, and the
 * sanitiser rewrites a full-name vocative to it — the model echoes whatever
 * form the prompt uses ("Good morning, Priya Sharma").
 */
export function addressName(fullName: string): string {
  const full = fullName.trim();
  const bare = withoutHonorific(full);
  const parts = bare.split(/\s+/);
  if (parts.length < 2) return bare;
  const rawTitle = bare !== full ? full.split(/\s+/)[0].replace(/\.$/, '') : '';
  // "Dr. Petrov", "Mrs. Chen" — but "Miss Doe" has no period, and a knight
  // is "Sir John", not "Sir Smith".
  if (!rawTitle) return parts[0];
  if (/^sir$/i.test(rawTitle)) return `${rawTitle} ${parts[0]}`;
  return `${rawTitle}${/^(dr|mr|mrs|ms|prof|rev)$/i.test(rawTitle) ? '.' : ''} ${parts[parts.length - 1]}`;
}

// People-shaped phrases around a capitalised word: "the Miller boy", "Old
// Hobbs", "Widow Grange", "Jenkins's daughter". Generic references ("a
// traveler", "the stranger", "the children") are lowercase and never match.
const PERSON_PATTERNS: RegExp[] = [
  /\bthe ([A-Z][a-z]+) (?:boy|boys|girl|girls|lad|lass|kid|kids|child|children|family|widow|widower|woman|man|twins|brothers|sisters|baby)\b/g,
  /\b(?:Mr|Mrs|Miss|Ms|Dr|Old|Widow|Young|Granny|Grandpa|Uncle|Aunt|Auntie|Master|Mistress)\.? ([A-Z][a-z]+)\b/g,
  /\b([A-Z][a-z]+)'s (?:son|daughter|wife|husband|boy|girl|mother|father|widow|baby|kids|children|brother|sister)\b/g,
];
// Capitalised words those patterns can catch that are not names ("Old Man Hobbs").
const NOT_NAMES = new Set(['man', 'woman', 'lady', 'gentleman', 'town', 'mill', 'farm', 'church', 'square']);

/**
 * Named people in `text` who are not in `known` (lowercase name words of every
 * resident, past and present, their children, and place names). Playtest #4:
 * the model made up "the Miller boy" in one conversation and he went on to a
 * memory, a goal, a daily plan and a reflection — each feeding the next
 * prompt. Callers drop the text that names one. Pure.
 */
export function inventedPeople(text: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const pattern of PERSON_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const word = m[1].toLowerCase();
      if (!known.has(word) && !NOT_NAMES.has(word)) out.add(m[1]);
    }
  }
  return [...out];
}

/** Lowercase words of these names ("Dr. Sofia Petrov" → dr, sofia, petrov) for inventedPeople. Pure. */
export function nameWords(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const w of n.toLowerCase().match(/[a-z']+/g) ?? []) out.add(w.replace(/'s$/, ''));
  return out;
}
