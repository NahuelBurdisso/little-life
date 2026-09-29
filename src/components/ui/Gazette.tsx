import { useState } from "react";
import { trpc } from "../../lib/trpc";

const PAPER = "#f3e9d2";
const INK = "#2b2118";
const RULE = "#8a7454";

/**
 * The Journal's Paper tab: The Town Crier (server/lib/gazette.ts), one
 * LLM-written edition per game day. Shows the latest by default, steps back
 * through the archive, and can ask the press for an edition covering
 * everything since the last one.
 *
 * Mounted only while the tab shows, so the archive query runs only then and
 * the reader lands on the newest edition each time the tab is opened. Kept
 * fresh by useGazette's `onNewIssue` subscription (App, always mounted).
 */
export function GazetteView() {
  const utils = trpc.useUtils();
  const { data: issues } = trpc.gazette.list.useQuery({ limit: 60 });
  // null = follow the newest edition; an id once the reader steps into the archive.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const currentId = selectedId ?? issues?.[0]?.id;
  const { data: issue } = trpc.gazette.get.useQuery(
    currentId != null ? { id: currentId } : undefined,
    { enabled: currentId != null },
  );

  const print = trpc.gazette.printNow.useMutation({
    onMutate: () => setNotice("The presses are rolling…"),
    onSuccess: ({ id }) => {
      setNotice(id == null ? "Nothing newsworthy since the last edition." : null);
      if (id != null) {
        setSelectedId(null);
        void utils.gazette.list.invalidate();
      }
    },
    onError: () => setNotice("The press jammed — is the model running?"),
  });

  const index = issues?.findIndex((i) => i.id === currentId) ?? -1;
  const older = index >= 0 ? issues?.[index + 1] : undefined;
  const newer = index > 0 ? issues?.[index - 1] : undefined;

  return (
    <div
      className="min-h-full"
      style={{ background: PAPER, color: INK, fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
      {/* Masthead */}
      <div className="px-4 sm:px-8 pt-5 pb-2 text-center">
        <div className="text-[11px] tracking-[0.3em] uppercase opacity-70">Established in the old days · One penny</div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-wide mt-1" style={{ fontVariant: "small-caps" }}>
          The Town Crier
        </h1>
        <div
          className="mt-2 py-1 text-xs uppercase tracking-widest flex justify-between"
          style={{ borderTop: `2px solid ${RULE}`, borderBottom: `1px solid ${RULE}` }}
        >
          <span>{issue ? `Day ${issue.day}` : "—"}</span>
          <span>{issue ? `${issue.season} edition` : ""}</span>
          <span>{issue && issues && index >= 0 ? `No. ${issues.length - index}` : ""}</span>
        </div>
      </div>

      <div className="px-4 sm:px-8 pb-6">
        {!issue ? (
          <div className="py-16 text-center italic opacity-70">
            {issues && issues.length === 0
              ? "No edition has been printed yet. The first one goes out at the end of the day — or print one now."
              : "Fetching the paper…"}
          </div>
        ) : (
          <>
            <h2 className="text-2xl sm:text-3xl font-bold text-center leading-tight my-4 uppercase">{issue.headline}</h2>
            <div className="columns-1 sm:columns-2 gap-8" style={{ columnRule: `1px solid ${RULE}` }}>
              {issue.articles.map((a, i) => (
                <article key={i} className="break-inside-avoid mb-5">
                  <h3 className="text-lg font-bold leading-snug mb-1">{a.headline}</h3>
                  <p className="text-[15px] leading-relaxed text-justify">{a.body}</p>
                </article>
              ))}
            </div>
            {issue.gossip && (
              <div className="mt-2 p-4" style={{ border: `1px double ${RULE}`, borderWidth: 3 }}>
                <div className="text-center text-sm font-bold uppercase tracking-widest mb-2">Heard in the Square</div>
                <p className="text-[15px] italic leading-relaxed">{issue.gossip}</p>
              </div>
            )}
          </>
        )}

        {/* Archive + press */}
        <div className="mt-5 pt-3 flex items-center justify-between gap-2 text-sm" style={{ borderTop: `1px solid ${RULE}` }}>
          <button
            disabled={!older}
            onClick={() => older && setSelectedId(older.id)}
            className="px-2 py-1 disabled:opacity-30 hover:underline"
          >
            ← Older
          </button>
          <div className="flex items-center gap-3">
            {notice && <span className="italic opacity-70">{notice}</span>}
            <button
              disabled={print.isPending}
              onClick={() => print.mutate()}
              className="px-3 py-1 rounded-sm disabled:opacity-50"
              style={{ background: INK, color: PAPER }}
              title="Write an edition covering everything since the last one"
            >
              {print.isPending ? "Printing…" : "Print today's edition"}
            </button>
          </div>
          <button
            disabled={!newer}
            onClick={() => newer && setSelectedId(newer.id)}
            className="px-2 py-1 disabled:opacity-30 hover:underline"
          >
            Newer →
          </button>
        </div>
      </div>
    </div>
  );
}
