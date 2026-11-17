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
  | 'confession' | 'gossip' | 'misdeed'         // → secret
  | 'breakup' | 'estrangement'                  // → heartbreak
  | 'arrest' | 'death' | 'birthday'
  | 'theft'                                     // tagged so it is not mistaken for a beat; no canvas FX
  | 'arrival' | 'departure'                     // the town's population changing (lib/populationFlow.ts); no canvas FX yet
  | 'new_job' | 'help_wanted' | 'inheritance'   // a trade changing hands (lib/careers.ts, vacancies.ts, the estate); no canvas FX yet
  | 'birth' | 'paternity'                      // family life (lib/family.ts): a baby born, a father learning it isn't his
  | 'contest_win'                               // a festival contest decided (lib/townCalendar.ts)
  | 'kiss' | 'kiss_rebuffed'                    // → kiss / heartbreak (lib/intimacy/kiss.ts)
  | 'tryst' | 'caught' | 'scandal'              // → romance / secret / secret (the adult layer, lib/intimacy/)
  | 'illness'                                   // an untreated illness turning for the worse (lib/sickness.ts); no canvas FX
  | 'release' | 'drunk' | 'outburst' | 'blackmail' | 'lonely'; // small rows that were untagged; no canvas FX (see the table)

export type DramaBeatKind = 'fight' | 'romance' | 'secret' | 'heartbreak' | 'arrest' | 'death' | 'birthday' | 'kiss';

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
  // Someone noticed a small misdeed (lib/smallMisdeeds.ts): a secret being born.
  misdeed: 'secret',
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
  // A birth is the town's happiest scene after a wedding: the birthday's
  // confetti over the new mother (the row's initiator) says it without a new
  // effect. The sound is its own (a soft lullaby chime, soundscape.ts).
  birth: 'birthday',
  // The believed father's heart, not a fight: the confrontation with the lover
  // is its own conversation later, with its own beat if it turns to blows.
  paternity: 'heartbreak',
  // The winner's moment in front of the crowd: the birthday family's burst of
  // cheer is the right picture (and sound) for it.
  contest_win: 'birthday',
  // Intimacy (lib/intimacy/). A kiss is its own picture (two figures leaning in),
  // a refused one is a broken heart, and the adult layer's rows stay suggestive:
  // hearts for the night together, a whisper for being seen at dawn or the
  // town's scandal.
  kiss: 'kiss',
  kiss_rebuffed: 'heartbreak',
  tryst: 'romance',
  caught: 'secret',
  scandal: 'secret',
  // Rows that logged `drama` with no tag and so were invisible to the story-health tally
  // (which counts `metadata.beat`), which is how gossip came to read as ~90% of all beats.
  // Tagged now so the tally, the recap and the gazette can tell them apart, but none gets a
  // canvas picture or a sound: they never had one (their wording matched nothing in
  // beatDetect), and a tavern night or a lonely week should not start playing a puff.
  // release: a sentence served (states.ts); drunk: the tavern's excess, tipsy through gambling
  // (tavernEngine, states.ts); outburst: a public flare-up, a drunken scene or a stab of jealousy;
  // blackmail: leverage exposed or reported; lonely: withdrawal, and the neighbour who visits.
  // The patient walking to the clinic, or lying at home, is the picture.
  illness: null,
  release: null,
  drunk: null,
  outburst: null,
  blackmail: null,
  lonely: null,
};

export function isDramaBeat(v: unknown): v is DramaBeat {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DRAMA_BEAT_KIND, v);
}
