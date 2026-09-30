/**
 * The story-beat subtype a `drama` activity row can carry in `metadata.beat`.
 *
 * Why this exists: the canvas dramatises fights, dates, arrests... and used to decide which
 * by regex-matching the English description of the row, so rewording a server template
 * silently killed its animation (and a gossip line that merely MENTIONED a fight had to be
 * fenced off by hand). The emit site knows what happened; it now says so explicitly. The
 * client still falls back to the wording for rows logged before this field existed.
 *
 * Pure data, no Node/DB imports: the client imports it (src/components/canvas/systems/beats).
 */

/** What a drama row was about, as the emit site knows it. */
export type DramaBeat =
  | 'fight' | 'insult' | 'snap'                 // → fight
  | 'date' | 'flirt' | 'reconciliation'         // → romance
  | 'confession' | 'gossip'                     // → secret
  | 'breakup' | 'estrangement'                  // → heartbreak
  | 'arrest' | 'death' | 'birthday'
  | 'theft'                                     // tagged so it is not mistaken for a beat; no canvas FX
  | 'arrival' | 'departure'                     // the town's population changing (lib/populationFlow.ts); no canvas FX yet
  | 'new_job' | 'help_wanted' | 'inheritance'   // a trade changing hands (lib/careers.ts, vacancies.ts, the estate); no canvas FX yet
  | 'contest_win';                              // a festival contest decided (lib/townCalendar.ts)

export type DramaBeatKind = 'fight' | 'romance' | 'secret' | 'heartbreak' | 'arrest' | 'death' | 'birthday';

/** The canvas animation family each subtype plays; `null` = tagged but nothing to draw. */
export const DRAMA_BEAT_KIND: Record<DramaBeat, DramaBeatKind | null> = {
  fight: 'fight',
  insult: 'fight',
  snap: 'fight',
  date: 'romance',
  flirt: 'romance',
  reconciliation: 'romance',
  confession: 'secret',
  gossip: 'secret',
  breakup: 'heartbreak',
  estrangement: 'heartbreak',
  arrest: 'arrest',
  death: 'death',
  birthday: 'birthday',
  theft: null,
  // The newcomer walking in and the leaver walking out ARE the picture; the
  // tags let the director, sound and gazette tell these rows apart.
  arrival: null,
  departure: null,
  // Tagged so the director, sound and gazette can tell a town's trades
  // changing hands from gossip about them.
  new_job: null,
  help_wanted: null,
  inheritance: null,
  // The winner's moment in front of the crowd: the birthday family's burst of
  // cheer is the right picture (and sound) for it.
  contest_win: 'birthday',
};

export function isDramaBeat(v: unknown): v is DramaBeat {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DRAMA_BEAT_KIND, v);
}
