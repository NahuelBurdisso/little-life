import { useCallback, useEffect, useMemo, useRef } from "react";
import { trpc } from "../lib/trpc";
import { mergeTimelinePages } from "../lib/timeline";

export interface TimelineOptions {
  /** Only this resident's story (everything they did or that happened to them). */
  agentId?: number;
  minImportance: number;
  categories?: string[];
  order?: "time" | "importance";
  limit?: number;
}

/**
 * How long a burst of activity waits before the loaded pages are refetched.
 * The channel fires on EVERY logged row and an infinite query refetches every
 * page it holds, so refreshing per row would re-run the whole scroll-back each
 * tick; a few seconds is imperceptible for a history view.
 */
const REFRESH_MS = 4000;

/**
 * The activity log by game day, paged back with the server's cursor.
 *
 * Mount it only while the view is visible (Timeline's inner body, the Story
 * tab): the subscription below is what keeps the query fresh (CLAUDE.md
 * "Client data freshness" — `refetchOnWindowFocus` is off), and a hidden view
 * shouldn't pay for it.
 */
export function useTimeline(opts: TimelineOptions) {
  const utils = trpc.useUtils();
  const query = trpc.activity.getTimeline.useInfiniteQuery(
    {
      agentId: opts.agentId,
      minImportance: opts.minImportance,
      categories: opts.categories?.length ? opts.categories : undefined,
      order: opts.order,
      limit: opts.limit ?? 60,
    },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void utils.activity.getTimeline.invalidate();
      }, REFRESH_MS);
    },
  });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const days = useMemo(() => mergeTimelinePages(query.data?.pages ?? []), [query.data]);

  // Stable identity: TimelineList's scroll observer depends on it.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const fetchMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    days,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: Boolean(hasNextPage),
    isFetchingMore: isFetchingNextPage,
    fetchMore,
  };
}
