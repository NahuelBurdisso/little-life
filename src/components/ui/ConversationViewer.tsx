import { useEffect, useRef } from "react";

interface Message {
  speakerId: string;
  text: string;
  sentiment?: number;
  timestamp?: number;
}

interface ConversationViewerProps {
  conversation: {
    _id: string;
    participants: string[];
    messages: Message[];
    topic: string | null;
    status: string;
    sentiment: number;
  };
  agentNames: Map<string, string>;
}

function sentimentBorderColor(sentiment: number | undefined): string {
  if (sentiment === undefined) return "border-gray-600";
  if (sentiment > 0.2) return "border-green-600";
  if (sentiment < -0.2) return "border-red-600";
  return "border-gray-600";
}

export function ConversationViewer({
  conversation,
  agentNames,
}: ConversationViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation.messages.length]);

  if (conversation.messages.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-gray-600 italic">
        Conversation starting...
      </div>
    );
  }

  // Determine left/right by participant order
  const leftSpeaker = conversation.participants[0];

  return (
    <div className="px-3 py-2 border-b border-gray-700">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-gray-500 font-medium">Conversation</span>
        {conversation.topic && (
          <span className="text-[10px] text-gray-600 italic truncate ml-2">
            {conversation.topic}
          </span>
        )}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            conversation.status === "active"
              ? "bg-green-900/50 text-green-300"
              : "bg-gray-700/50 text-gray-400"
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
          const name =
            agentNames.get(msg.speakerId) ?? msg.speakerId.slice(-4);

          return (
            <div
              key={i}
              className={`flex flex-col ${isLeft ? "items-start" : "items-end"}`}
            >
              <span className="text-[10px] text-gray-500 mb-0.5">{name}</span>
              <div
                className={`text-[11px] leading-tight px-2 py-1 rounded-lg max-w-[85%] border ${sentimentBorderColor(msg.sentiment)} ${
                  isLeft
                    ? "bg-gray-700 text-gray-200 rounded-tl-none"
                    : "bg-gray-600 text-gray-100 rounded-tr-none"
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
