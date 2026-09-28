export type SelectedAgentStatus = 'none' | 'loading' | 'ready' | 'notFound' | 'error';

/**
 * What the agent panel should show for the current `getAgentSummary` query.
 *
 * The server answers `null` for an id with no agent row — removed, or left over
 * from a replaced world. The hook used to fold that into `undefined`
 * (`data ?? undefined`) and derive `isLoading` from `data === undefined`, so
 * "not found" read exactly like "still loading" and the panel spun forever; a
 * failed fetch did the same. A dead agent is NOT "not found": the row survives
 * with `is_active: false` and the panel renders it as the deceased view.
 *
 * `data` wins over `isError`: a failed background refetch keeps the last good
 * summary, and showing it beats swapping the panel for an error.
 */
export function selectedAgentStatus(
  agentId: string | null,
  query: { data: unknown; isPending: boolean; isError: boolean },
): SelectedAgentStatus {
  if (agentId === null) return 'none';
  const id = Number(agentId);
  // Not a usable id: the query is disabled and would otherwise sit in
  // `isPending` forever, which is the same endless spinner by another road.
  if (!Number.isInteger(id) || id <= 0) return 'notFound';
  if (query.data != null) return 'ready';
  if (query.data === null) return 'notFound';
  if (query.isError) return 'error';
  return 'loading';
}
