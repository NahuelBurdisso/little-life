/**
 * What each life-ambition category means, in the resident's own words.
 *
 * The wizard seeds an aspiration as a bare category, so the morning review read
 * `Your life ambition: "legacy" (legacy)` and had nothing to weigh events
 * against (playtest #4: no ambition moved in 27 days). A generated ambition
 * still replaces this with its own sentence. Pure data (the client imports
 * server/data).
 */
export const AMBITION_TEXT: Record<string, string> = {
  wealth: 'to never again count coins at the end of the month',
  love: 'to love someone and be loved back',
  power: 'to be the one this town listens to',
  freedom: 'to live on my own terms, answerable to no one',
  justice: 'to see wrongs in this town put right',
  knowledge: 'to understand how things and people really work',
  legacy: 'to leave something in this town that outlasts me',
  pleasure: 'to enjoy every good thing life has to offer',
};

export function ambitionText(type: string): string {
  return AMBITION_TEXT[type] ?? type;
}
