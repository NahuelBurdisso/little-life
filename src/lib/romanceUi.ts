/**
 * Small pure decisions the romance UI (PairDossier, RomanceLedger) makes about the adult-content
 * rule, kept out of the components so they can be tested without React.
 */

/**
 * The dossier's "Arrange a quiet evening" button: absent unless the rule is on. While it is off
 * the server still answers `arrange` (with the reason), but a disabled button that hints at the
 * adult layer is the wrong thing to show in a town that opted out of it.
 */
export function arrangeButtonFor(
  intimacy: { adultContent: boolean; arrange: { available: boolean; reason: string | null } } | null | undefined,
): { available: boolean; reason: string | null } | null {
  if (!intimacy?.adultContent) return null;
  return intimacy.arrange;
}

/**
 * Whether a Hearts ledger already in hand was built under a different `adultContent` rule than
 * the one the town has now. Such a ledger still carries (or lacks) the adult sections, so it must
 * not be drawn: after the rule goes off, the lovers and longing chapters would otherwise linger
 * until the refetch lands, or for good when nothing refetches. Unknown rule = not stale.
 */
export function ledgerIsStale(
  ledger: { adultContent: boolean } | null | undefined,
  rules: { adultContent?: boolean } | null | undefined,
): boolean {
  if (!ledger || rules?.adultContent == null) return false;
  return ledger.adultContent !== rules.adultContent;
}
