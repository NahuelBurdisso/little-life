import { useEffect } from "react";
import { trpc } from "../../lib/trpc";
import { describeSpan } from "../../lib/lastSeen";
import { formatGameMinute } from "../../lib/formatters";
import type { RecapRequest } from "../../hooks/useRecap";
import type { RecapBullet } from "../../../server/lib/recap";

interface RecapCardProps {
  /** What to recap (useRecap); null renders nothing. */
  request: RecapRequest | null;
  /** Residents that can still be focused (the living): a line about anyone else is plain text. */
  agents: ReadonlyArray<{ id: number | string; name: string }>;
  onFocusAgent: (agentId: string) => void;
  /** "Everything that happened" opens the Journal's Timeline. */
  onOpenJournal: () => void;
  onDismiss: () => void;
}

/**
 * "Previously on…": a handful of lines about what the town got up to while the
 * player was away, or overnight during a skip (server/lib/recap.ts picks them).
 * Non-blocking, bottom-left of the map; Escape or × dismisses it (App's chain);
 * a line with a resident in it focuses them.
 *
 * The recap is a snapshot of the moment it opened, so the query never refetches.
 * An empty span dismisses the card instead of showing "nothing happened".
 */
export function RecapCard({ request, agents, onFocusAgent, onOpenJournal, onDismiss }: RecapCardProps) {
  const { data } = trpc.chronicle.getRecap.useQuery(
    { sinceMinute: request?.sinceMinute ?? 0 },
    { enabled: request != null, staleTime: Infinity, gcTime: 0 },
  );

  const empty = data != null && data.bullets.length === 0;
  useEffect(() => {
    if (request && empty) onDismiss();
  }, [request, empty, onDismiss]);

  if (!request || !data || empty) return null;

  const living = new Map(agents.map((a) => [String(a.id), a.name.split(" ")[0]]));
  const focusable = (b: RecapBullet) => b.agentIds.map(String).find((id) => living.has(id));
  const overnight = request.kind === "overnight";

  return (
    <section
      aria-label={overnight ? "Overnight recap" : "Previously on"}
      className="absolute bottom-3 left-3 z-30 w-[340px] max-w-[calc(100%-4.5rem)] bg-ui-panel/95 border border-ui-line-accent shadow-2xl toast-in"
    >
      <header className="flex items-start gap-2 px-3 pt-2.5 pb-1.5 border-b border-ui-line bg-ui-raised">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-bold text-ui-gold tracking-wide italic">
            {overnight ? "Overnight…" : "Previously on Little Life…"}
          </h2>
          <p
            className="text-[10px] text-ui-muted"
            title={`${formatGameMinute(data.sinceMinute)} → ${formatGameMinute(data.untilMinute)}`}
          >
            {overnight ? "While the town slept" : "While you were away"} · {describeSpan(data.sinceMinute, data.untilMinute)} of town time
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-ui-dim hover:text-ui-text text-lg leading-none px-1"
          aria-label="Dismiss the recap"
          title="Dismiss (Esc)"
        >
          &times;
        </button>
      </header>

      <ul className="py-1 max-h-[40vh] overflow-y-auto">
        {data.bullets.map((b) => {
          const target = focusable(b);
          const body = (
            <>
              <span aria-hidden="true" className="shrink-0 w-4 text-center">{b.icon}</span>
              <span className={b.kind === "paper" ? "italic text-ui-dim" : b.kind === "player" ? "text-ui-gold" : "text-ui-text"}>
                {b.text}
              </span>
            </>
          );
          const rowClass = "w-full text-left flex gap-2 px-3 py-1 text-xs leading-snug";
          return (
            <li key={b.key}>
              {target != null ? (
                <button
                  type="button"
                  onClick={() => onFocusAgent(target)}
                  className={`${rowClass} hover:bg-ui-hover focus-visible:bg-ui-hover transition-colors`}
                  title={`Go to ${living.get(target)}`}
                >
                  {body}
                </button>
              ) : (
                <div className={rowClass}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>

      <footer className="flex justify-end px-3 py-1.5 border-t border-ui-line">
        <button
          type="button"
          onClick={onOpenJournal}
          className="text-[11px] text-ui-dim hover:text-ui-gold underline underline-offset-2"
        >
          Everything that happened → Journal
        </button>
      </footer>
    </section>
  );
}
