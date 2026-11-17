import { useEffect, useRef } from "react";
import type { ConversationMessage } from '../../../server/db/schema';

interface ConversationViewerProps {
  conversation: {
    id: number;
    participants: number[];
    messages: ConversationMessage[];
    topic: string | null;
    status: string;
    sentiment: number;
  };
  agentNames: Map<string, string>;
  /** Makes speaker names buttons that select + focus that resident. */
  onSelectAgent?: (agentId: string) => void;
}

function sentimentBorderColor(sentiment: number | undefined): string {
  if (sentiment === undefined) return "border-ui-line";
  if (sentiment > 0.2) return "border-ui-good/60";
  if (sentiment < -0.2) return "border-ui-bad/60";
  return "border-ui-line";
}

export function ConversationViewer({
  conversation,
  agentNames,
  onSelectAgent,
}: ConversationViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation.messages.length]);

  if (conversation.messages.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-ui-muted italic">
        Conversation starting...
      </div>
    );
  }

  // Determine left/right by participant order
  const leftSpeaker = conversation.participants[0];

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-ui-dim font-medium">Conversation</span>
        {conversation.topic && (
          <span className="text-[10px] text-ui-muted italic truncate ml-2">
            {conversation.topic}
          </span>
        )}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            conversation.status === "active"
              ? "bg-ui-good/15 text-ui-good"
              : "bg-ui-raised/50 text-ui-dim"
          }`}
        >
          {conversation.status}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="space-y-1.5 max-h-40 overflow-y-auto pr-1"
      >
        {conversation.messages.map((msg, i) => {
          const isLeft = msg.speakerId === leftSpeaker;
          const speakerKey = String(msg.speakerId);
          const name =
            agentNames.get(speakerKey) ?? speakerKey.slice(-4);

          // A canned fallback ("Omar smiled and nodded.") is an action, not a
          // line: show it as italic narration instead of a speech bubble.
          if (msg.fallback) {
            return (
              <div key={i} className="text-center text-[10px] italic text-ui-muted">
                {msg.text}
              </div>
            );
          }

          return (
            <div
              key={i}
              className={`flex flex-col ${isLeft ? "items-start" : "items-end"}`}
            >
              {onSelectAgent && agentNames.has(speakerKey) ? (
                <button
                  type="button"
                  onClick={() => onSelectAgent(speakerKey)}
                  title={`Go to ${name}`}
                  className="text-[10px] text-ui-dim mb-0.5 cursor-pointer underline-offset-2 hover:text-ui-gold hover:underline focus-visible:text-ui-gold focus-visible:underline transition-colors"
                >
                  {name}
                </button>
              ) : (
                <span className="text-[10px] text-ui-dim mb-0.5">{name}</span>
              )}
              <div
                className={`text-[11px] leading-tight px-2 py-1 rounded-lg max-w-[85%] border ${sentimentBorderColor(msg.sentiment)} ${
                  isLeft
                    ? "bg-ui-raised text-ui-text rounded-tl-none"
                    : "bg-ui-hover text-ui-text rounded-tr-none"
                }`}
              >
                {msg.text}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
