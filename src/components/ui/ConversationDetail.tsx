import { trpc } from "../../lib/trpc";

interface ConversationDetailProps {
  conversationId: number | null;
  onClose: () => void;
}

function deltaColor(value: number): string {
  if (value > 0) return 'text-green-400';
  if (value < 0) return 'text-red-400';
  return 'text-gray-400';
}

function deltaSign(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}

export function ConversationDetail({ conversationId, onClose }: ConversationDetailProps) {
  const { data: impact } = trpc.conversations.getImpact.useQuery(
    { conversationId: conversationId! },
    { enabled: conversationId != null }
  );

  if (!conversationId) return null;
  if (!impact) return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl p-6 text-gray-400 text-sm">Loading...</div>
    </div>
  );

  const { conversation: convo, names, relationshipEvents, createdFacts, totals } = impact;
  const participants = (convo.participants as number[]).map(id => names[id] ?? `Agent ${id}`);
  const messages = (convo.messages as Array<{ speakerId: number; text: string; sentiment?: number }>) ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[550px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <div>
            <h2 className="text-sm font-bold text-white">{participants.join(' & ')}</h2>
            {convo.topic && (
              <div className="text-[10px] text-gray-400 italic">{convo.topic}</div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Impact Summary */}
        <div className="px-5 py-3 border-b border-gray-700">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">Impact</div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className={`text-lg font-bold ${deltaColor(totals.friendship)}`}>
                {deltaSign(totals.friendship)}
              </div>
              <div className="text-[9px] text-gray-500">Friendship</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${deltaColor(totals.romance)}`}>
                {deltaSign(totals.romance)}
              </div>
              <div className="text-[9px] text-gray-500">Romance</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${deltaColor(totals.trust)}`}>
                {deltaSign(totals.trust)}
              </div>
              <div className="text-[9px] text-gray-500">Trust</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${
                totals.sentiment > 0.2 ? 'text-green-400' : totals.sentiment < -0.2 ? 'text-red-400' : 'text-gray-400'
              }`}>
                {totals.sentiment > 0 ? '+' : ''}{totals.sentiment.toFixed(1)}
              </div>
              <div className="text-[9px] text-gray-500">Sentiment</div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="px-5 py-3 border-b border-gray-700">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
            Dialogue ({totals.turns} turn{totals.turns !== 1 ? 's' : ''})
          </div>
          {messages.length === 0 ? (
            <div className="text-xs text-gray-500 italic">No messages recorded</div>
          ) : (
            <div className="space-y-2">
              {messages.map((msg, i) => {
                const speakerName = names[msg.speakerId] ?? 'Unknown';
                return (
                  <div key={i} className="text-xs">
                    <span className="font-semibold text-gray-200">{speakerName}:</span>{' '}
                    <span className="text-gray-400">{msg.text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Relationship Events */}
        {relationshipEvents.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-700">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              Relationship Events
            </div>
            <div className="space-y-1">
              {relationshipEvents.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="px-1.5 py-0.5 rounded text-[9px] bg-gray-700 text-gray-300 capitalize">
                    {e.event_type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-gray-400 flex-1 truncate">{e.description}</span>
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
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-2 font-medium">
              Facts Created
            </div>
            <div className="space-y-1">
              {createdFacts.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] capitalize ${
                    f.sensitivity >= 3 ? 'bg-red-900/50 text-red-300' :
                    f.sensitivity >= 2 ? 'bg-yellow-900/50 text-yellow-300' :
                    'bg-gray-700 text-gray-300'
                  }`}>
                    {f.type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-gray-400">{f.content}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No impact */}
        {relationshipEvents.length === 0 && createdFacts.length === 0 && (
          <div className="px-5 py-3 text-xs text-gray-500 italic">
            No notable impact from this conversation.
          </div>
        )}
      </div>
    </div>
  );
}
