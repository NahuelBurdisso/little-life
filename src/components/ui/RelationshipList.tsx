import React from "react";
import { COLORS } from "../../lib/constants";
import { EmptyState } from "./EmptyState";

interface RelationshipEntry {
  relationship: {
    agent_a: number;
    agent_b: number;
    friendship_ab: number;
    friendship_ba: number;
    romance_ab: number;
    romance_ba: number;
    trust_ab: number;
    trust_ba: number;
    familiarity: number;
    interaction_count: number;
    status: string;
    tags: string[];
  };
  otherAgent: { id: number; name: string } | null;
}

interface RelationshipListProps {
  relationships: RelationshipEntry[];
  selectedAgentId?: string;
  /** Makes each row a button that selects + focuses that resident. */
  onSelectAgent?: (agentId: string) => void;
  /** Adds a history button to each row that opens the pair dossier with that resident. */
  onViewPair?: (otherAgentId: string) => void;
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
            backgroundColor: i < count ? color : "var(--ui-border)",
          }}
        />
      ))}
    </span>
  );
}

function statusBadge(status: string): React.ReactElement | null {
  const styles: Record<string, string> = {
    friends: "bg-ui-blue/15 text-ui-blue",
    close_friends: "bg-ui-blue/25 text-ui-blue",
    best_friends: "bg-ui-blue/40 text-ui-text",
    dating: "bg-pink-900/50 text-pink-300",
    partners: "bg-pink-800/50 text-pink-200",
    rivals: "bg-red-900/50 text-red-300",
    enemies: "bg-red-800/50 text-red-200",
    acquaintances: "bg-ui-raised/50 text-ui-dim",
  };

  const style = styles[status];
  if (!style && status === "strangers") return null;

  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${style ?? "bg-ui-raised/50 text-ui-dim"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function RelationshipList({
  relationships,
  selectedAgentId,
  onSelectAgent,
  onViewPair,
}: RelationshipListProps) {
  if (relationships.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-ui-line">
        <div className="text-xs text-ui-dim font-medium mb-1">
          Relationships
        </div>
        <EmptyState
          compact
          icon="🤝"
          title="Hasn't met anyone yet."
          hint="Friendships, crushes and rivalries appear here as they form."
        />
      </div>
    );
  }

  // Sort by friendship strength descending
  const sorted = [...relationships]
    .filter((r) => r.otherAgent !== null)
    .sort((a, b) => {
      const aFriend = Math.max(
        Math.abs(a.relationship.friendship_ab),
        Math.abs(a.relationship.friendship_ba)
      );
      const bFriend = Math.max(
        Math.abs(b.relationship.friendship_ab),
        Math.abs(b.relationship.friendship_ba)
      );
      return bFriend - aFriend;
    });

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="text-xs text-ui-dim font-medium mb-1.5">
        Relationships
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {sorted.map((entry) => {
          const { relationship: rel, otherAgent } = entry;
          if (!otherAgent) return null;

          // Determine which direction's values to show (perspective of selected agent)
          const isA = Number(selectedAgentId) === rel.agent_a;
          const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
          const romance = isA ? rel.romance_ab : rel.romance_ba;

          const rowBody = (
            <>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-ui-text truncate">
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
              {onSelectAgent && (
                <span aria-hidden="true" className="text-ui-faint group-hover:text-ui-gold transition-colors text-xs">
                  ›
                </span>
              )}
            </>
          );

          // A button only when there is somewhere to go, so a read-only list
          // isn't announced as a set of dead buttons.
          const row = onSelectAgent ? (
            <button
              key={otherAgent.id}
              type="button"
              onClick={() => onSelectAgent(String(otherAgent.id))}
              title={`Go to ${otherAgent.name}`}
              className="group w-full text-left flex items-center justify-between gap-2 px-1.5 py-1 -mx-1.5 rounded-sm cursor-pointer hover:bg-ui-hover focus-visible:bg-ui-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-ui-gold transition-colors"
            >
              {rowBody}
            </button>
          ) : (
            <div key={otherAgent.id} className="flex items-center justify-between gap-2 px-1.5 py-1">
              {rowBody}
            </div>
          );
          if (!onViewPair) return row;

          // The history button is the row's sibling, not a child: buttons can't
          // nest, and the row's own click already means "go to them".
          return (
            <div key={otherAgent.id} className="flex items-center gap-1">
              <div className="flex-1 min-w-0">{row}</div>
              <button
                type="button"
                onClick={() => onViewPair(String(otherAgent.id))}
                title={`History with ${otherAgent.name}: turning points, secrets, story`}
                aria-label={`Relationship history with ${otherAgent.name}`}
                className="shrink-0 px-1.5 py-1 text-xs text-ui-dim hover:text-ui-gold hover:bg-ui-hover rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-ui-gold transition-colors"
              >
                📖
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
