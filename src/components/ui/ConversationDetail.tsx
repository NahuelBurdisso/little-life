import { trpc } from "../../lib/trpc";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

interface ConversationDetailProps {
  conversationId: number | null;
  onClose: () => void;
  /** Names in the header/dialogue become buttons that select + focus that resident. */
  onSelectAgent?: (agentId: string) => void;
}

function deltaColor(value: number): string {
  if (value > 0) return 'text-ui-good';
  if (value < 0) return 'text-ui-bad';
  return 'text-ui-dim';
}

function deltaSign(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

const OVERLAY = "fixed inset-0 z-40 flex items-center justify-center bg-black/50";

export function ConversationDetail({ conversationId, onClose, onSelectAgent }: ConversationDetailProps) {
  const { data: impact } = trpc.conversations.getImpact.useQuery(
    { conversationId: conversationId! },
    { enabled: conversationId != null }
  );

  if (!conversationId) return null;
  // ConversationHistory renders this inside its own click-to-close backdrop; without
  // stopping the event, dismissing the detail also closed the whole history list.
  const dismiss = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onClose();
  };
  if (!impact) return (
    <div className={OVERLAY} onClick={dismiss}>
      <div
        className="bg-ui-panel border border-ui-line shadow-2xl w-[550px] max-w-[95vw] p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
        role="status"
        aria-label="Loading conversation"
      >
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );

  const { conversation: convo, names, relationshipEvents, createdFacts, totals } = impact;
  const participantIds = convo.participants as number[];
  const messages = (convo.messages as Array<{ speakerId: number; text: string; sentiment?: number; fallback?: boolean }>) ?? [];

  const selectAgent = (id: number) => {
    onSelectAgent?.(String(id));
    onClose();
  };
  /** A name that jumps to that resident when the caller supplied a handler. */
  const nameLink = (id: number, label: string, className: string) =>
    onSelectAgent && names[id] ? (
      <button
        type="button"
        onClick={() => selectAgent(id)}
        title={`Go to ${label}`}
        className={`${className} cursor-pointer hover:text-ui-gold hover:underline underline-offset-2 focus-visible:text-ui-gold focus-visible:underline transition-colors`}
      >
        {label}
      </button>
    ) : (
      <span className={className}>{label}</span>
    );

  return (
    <div className={OVERLAY} onClick={dismiss}>
      <div
        className="bg-ui-panel border border-ui-line shadow-2xl w-[550px] max-w-[95vw] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-ui-line">
          <div>
            <h2 className="text-sm font-bold text-ui-text">
              {participantIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && <span className="text-ui-muted"> &amp; </span>}
                  {nameLink(id, names[id] ?? `Agent ${id}`, "")}
                </span>
              ))}
            </h2>
            {convo.topic && (
              <div className="text-[10px] text-ui-dim italic">{convo.topic}</div>
            )}
          </div>
          <button onClick={onClose} className="text-ui-dim hover:text-ui-text text-lg leading-none" aria-label="Close">
            &times;
          </button>
        </div>

        {/* Impact Summary */}
        <div className="px-5 py-3 border-b border-ui-line">
          <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">Impact</div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className={`text-lg font-bold ${deltaColor(totals.friendship)}`}>
                {deltaSign(totals.friendship)}
              </div>
              <div className="text-[9px] text-ui-muted">Friendship</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${deltaColor(totals.romance)}`}>
                {deltaSign(totals.romance)}
              </div>
              <div className="text-[9px] text-ui-muted">Romance</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${deltaColor(totals.trust)}`}>
                {deltaSign(totals.trust)}
              </div>
              <div className="text-[9px] text-ui-muted">Trust</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${
                totals.sentiment > 0.2 ? 'text-ui-good' : totals.sentiment < -0.2 ? 'text-ui-bad' : 'text-ui-dim'
              }`}>
                {totals.sentiment > 0 ? '+' : ''}{totals.sentiment.toFixed(1)}
              </div>
              <div className="text-[9px] text-ui-muted">Sentiment</div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="px-5 py-3 border-b border-ui-line">
          <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
            Dialogue ({totals.turns} turn{totals.turns !== 1 ? 's' : ''})
          </div>
          {messages.length === 0 ? (
            <EmptyState compact icon="🤐" title="Nothing was said." hint="No lines were recorded for this conversation." />
          ) : (
            <div className="space-y-2">
              {messages.map((msg, i) => {
                const speakerName = names[msg.speakerId] ?? 'Unknown';
                // A canned fallback is narration that already names the actor —
                // "Omar: Omar smiled and nodded." read as a spoken line.
                if (msg.fallback) {
                  return (
                    <div key={i} className="text-xs italic text-ui-muted">{msg.text}</div>
                  );
                }
                return (
                  <div key={i} className="text-xs">
                    <span className="font-semibold text-ui-text">
                      {nameLink(msg.speakerId, speakerName, "")}:
                    </span>{' '}
                    <span className="text-ui-dim">{msg.text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Relationship Events */}
        {relationshipEvents.length > 0 && (
          <div className="px-5 py-3 border-b border-ui-line">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              Relationship Events
            </div>
            <div className="space-y-1">
              {relationshipEvents.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="px-1.5 py-0.5 rounded-sm text-[9px] bg-ui-raised text-ui-text capitalize">
                    {e.event_type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-ui-dim flex-1 truncate">{e.description}</span>
                  <div className="flex gap-2 shrink-0 text-[10px]">
                    {e.friendshipDelta !== 0 && (
                      <span className={deltaColor(e.friendshipDelta)}>F{deltaSign(e.friendshipDelta)}</span>
                    )}
                    {e.romanceDelta !== 0 && (
                      <span className={deltaColor(e.romanceDelta)}>R{deltaSign(e.romanceDelta)}</span>
                    )}
                    {e.trustDelta !== 0 && (
                      <span className={deltaColor(e.trustDelta)}>T{deltaSign(e.trustDelta)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Facts Created */}
        {createdFacts.length > 0 && (
          <div className="px-5 py-3">
            <div className="text-[10px] text-ui-dim uppercase tracking-wider mb-2 font-medium">
              Facts Created
            </div>
            <div className="space-y-1">
              {createdFacts.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className={`px-1.5 py-0.5 rounded-sm text-[9px] capitalize ${
                    f.sensitivity >= 3 ? 'bg-ui-bad/20 text-ui-bad' :
                    f.sensitivity >= 2 ? 'bg-ui-warn/20 text-ui-warn' :
                    'bg-ui-raised text-ui-text'
                  }`}>
                    {f.type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-ui-dim">{f.content}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No impact */}
        {relationshipEvents.length === 0 && createdFacts.length === 0 && (
          <EmptyState
            compact
            icon="🌫"
            title="This chat changed nothing."
            hint="Relationship shifts and new secrets or rumours would be listed here."
          />
        )}
      </div>
    </div>
  );
}
