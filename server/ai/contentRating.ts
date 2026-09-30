/**
 * The maturity line every prompt that imagines town life carries, right after
 * TOWN_SETTING (dialogue header, conversation summary, the three plan prompts).
 *
 * The `adultContent` rule (lib/worldRules.ts `isAdultContent`) decides which text
 * the model reads, so the tone of the whole town changes with one switch and no
 * prompt has to know about the feature:
 * - on: desire, jealousy and temptation are allowed to be spoken, in the period's
 *   own manner. The two hard lines are stated in the same breath, because the
 *   model follows the directive it just read, not the code around it: physical
 *   intimacy happens off-stage (the sim itself only ever writes "spent the night
 *   together"), and nothing romantic or sexual ever involves anyone under 18.
 * - off: romance stays chaste. Without this line the model drifts frank on its
 *   own once two characters are flirting.
 *
 * Takes the boolean instead of reading the rule so callers read it once per prompt
 * build and this stays a pure string switch the tests can walk.
 */
const ADULT_TONE =
  'This is a story for adults. People here feel desire, jealousy and temptation and may talk about them as folk of 1900 would — ' +
  'veiled, teasing or blunt, as fits the speaker. Physical intimacy always happens off-stage: never describe it. ' +
  'Nothing romantic or sexual ever involves anyone under 18.';

const CHASTE_TONE = 'Romance stays chaste: glances, courting, holding hands, a kiss at most.';

export function maturityDirective(adult: boolean): string {
  return adult ? ADULT_TONE : CHASTE_TONE;
}
