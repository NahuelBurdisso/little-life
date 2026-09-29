interface SkeletonProps {
  className?: string;
}

/** One shimmering placeholder block. Size it with Tailwind (`h-3 w-24`). */
export function Skeleton({ className = "" }: SkeletonProps) {
  return <div aria-hidden="true" className={`ui-skeleton rounded-sm ${className}`} />;
}

/**
 * Stand-in for a section that is still fetching: a header bar plus `rows`
 * lines of decreasing width, so the layout doesn't jump when the data lands.
 */
export function SkeletonSection({ rows = 3, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div className="px-3 py-2 border-b border-ui-line space-y-2" role="status" aria-label="Loading">
      {title && <Skeleton className="h-2.5 w-24" />}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ width: `${100 - (i % 3) * 15}%` }}>
          <Skeleton className="h-3" />
        </div>
      ))}
    </div>
  );
}
