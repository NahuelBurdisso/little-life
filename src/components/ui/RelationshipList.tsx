import React from "react";
import { COLORS } from "../../lib/constants";

interface RelationshipEntry {
  relationship: {
    agentA: string;
    agentB: string;
    friendshipAB: number;
    friendshipBA: number;
    romanceAB: number;
    romanceBA: number;
    trustAB: number;
    trustBA: number;
    familiarity: number;
    interactionCount: number;
    status: string;
    tags: string[];
  };
  otherAgent: { _id: string; name: string } | null;
}

interface RelationshipListProps {
  relationships: RelationshipEntry[];
  selectedAgentId?: string;
}

function strengthIndicator(value: number, max = 100): number {
  // Return 1-5 scale
  const normalized = Math.abs(value) / max;
  if (normalized > 0.8) return 5;
  if (normalized > 0.6) return 4;
  if (normalized > 0.4) return 3;
  if (normalized > 0.2) return 2;
  return 1;
}

function renderDots(count: number, color: string): React.ReactElement {
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{
            backgroundColor: i < count ? color : "#4b5563",
          }}
        />
      ))}
    </span>
  );
}

function statusBadge(status: string): React.ReactElement | null {
  const styles: Record<string, string> = {
    friends: "bg-blue-900/50 text-blue-300",
    close_friends: "bg-blue-800/50 text-blue-200",
    best_friends: "bg-blue-700/50 text-blue-100",
    dating: "bg-pink-900/50 text-pink-300",
    partners: "bg-pink-800/50 text-pink-200",
    rivals: "bg-red-900/50 text-red-300",
    enemies: "bg-red-800/50 text-red-200",
    acquaintances: "bg-gray-700/50 text-gray-400",
  };

  const style = styles[status];
  if (!style && status === "strangers") return null;

  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${style ?? "bg-gray-700/50 text-gray-400"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function RelationshipList({
  relationships,
  selectedAgentId,
}: RelationshipListProps) {
  if (relationships.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-gray-700">
        <div className="text-xs text-gray-500 font-medium mb-1">
          Relationships
        </div>
        <div className="text-xs text-gray-600 italic">
          No relationships yet.
        </div>
      </div>
    );
  }

  // Sort by friendship strength descending
  const sorted = [...relationships]
    .filter((r) => r.otherAgent !== null)
    .sort((a, b) => {
      const aFriend = Math.max(
        Math.abs(a.relationship.friendshipAB),
        Math.abs(a.relationship.friendshipBA)
      );
      const bFriend = Math.max(
        Math.abs(b.relationship.friendshipAB),
        Math.abs(b.relationship.friendshipBA)
      );
      return bFriend - aFriend;
    });

  return (
    <div className="px-3 py-2 border-b border-gray-700">
      <div className="text-xs text-gray-500 font-medium mb-1.5">
        Relationships
      </div>
      <div className="space-y-1.5 max-h-40 overflow-y-auto">
        {sorted.map((entry) => {
          const { relationship: rel, otherAgent } = entry;
          if (!otherAgent) return null;

          // Determine which direction's values to show (perspective of selected agent)
          const isA = selectedAgentId === rel.agentA;
          const friendship = isA ? rel.friendshipAB : rel.friendshipBA;
          const romance = isA ? rel.romanceAB : rel.romanceBA;

          return (
            <div
              key={otherAgent._id}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs text-white truncate">
                  {otherAgent.name}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  {renderDots(
                    strengthIndicator(friendship),
                    friendship >= 0
                      ? COLORS.relationship.friendship
                      : COLORS.relationship.rivalry
                  )}
                  {romance > 10 &&
                    renderDots(
                      strengthIndicator(romance),
                      COLORS.relationship.romance
                    )}
                </div>
              </div>
              <div className="flex-shrink-0">{statusBadge(rel.status)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
