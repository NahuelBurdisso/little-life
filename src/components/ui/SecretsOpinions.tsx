import { trpc } from "../../lib/trpc";
import { EmptyState } from "./EmptyState";
import { SkeletonSection } from "./Skeleton";

interface SecretsOpinionsProps {
  agentId: number;
  agentName: string;
}

const FACT_COLORS: Record<string, string> = {
  crush: "text-pink-400",
  heartbreak: "text-rose-400",
  affair: "text-red-400",
  kiss_seen: "text-pink-300",
  tryst_seen: "text-pink-400",
  illegitimate_pregnancy: "text-rose-300",
  theft: "text-orange-400",
  blackmail: "text-red-500",
  grudge: "text-red-600",
  sickness: "text-yellow-300",
  financial: "text-yellow-400",
  alcoholic: "text-amber-400",
  work_issue: "text-orange-300",
  drunk_incident: "text-amber-300",
  rumor: "text-purple-400",
  confession: "text-ui-blue",
  seduction: "text-pink-300",
  reputation: "text-red-300",
  secret_told: "text-indigo-400",
  gambling_loss: "text-yellow-500",
};

function opinionTemplate(
  agentName: string,
  otherName: string,
  friendship: number,
  romance: number,
  trust: number,
  status: string
): string {
  if (romance > 60) {
    return `${agentName} has strong romantic feelings for ${otherName}.`;
  }
  if (romance > 30) {
    return `${agentName} finds ${otherName} rather attractive.`;
  }
  if (friendship < -40) {
    return `${agentName} genuinely dislikes ${otherName}.`;
  }
  if (friendship < -10) {
    return `${agentName} finds ${otherName} irritating.`;
  }
  if (trust > 70) {
    return `${agentName} trusts ${otherName} completely.`;
  }
  if (friendship > 70) {
    return `${agentName} considers ${otherName} a close friend.`;
  }
  if (friendship > 40) {
    return `${agentName} genuinely likes ${otherName}.`;
  }
  if (status === "rivals") {
    return `${agentName} sees ${otherName} as a rival.`;
  }
  if (status === "enemies") {
    return `${agentName} considers ${otherName} an enemy.`;
  }
  if (status === "dating" || status === "partners") {
    return `${agentName} is romantically involved with ${otherName}.`;
  }
  return `${agentName} knows ${otherName} but doesn't feel strongly either way.`;
}

export function SecretsOpinions({ agentId, agentName }: SecretsOpinionsProps) {
  const { data: knownFacts, isLoading: factsLoading } = trpc.knowledge.getKnownBy.useQuery({ agentId });
  const { data: relationships, isLoading: relsLoading } = trpc.relationships.getAgentRelationships.useQuery({ agentId });

  if (factsLoading || relsLoading) {
    return (
      <>
        <SkeletonSection rows={3} />
        <SkeletonSection rows={3} />
      </>
    );
  }

  // Filter to secrets (sensitivity >= 2), sort by sensitivity desc
  const secrets = (knownFacts ?? [])
    .filter((f) => f.sensitivity >= 2)
    .sort((a, b) => b.sensitivity - a.sensitivity)
    .slice(0, 8);

  // Top 5 relationships by absolute friendship strength
  const topRelationships = (relationships ?? [])
    .filter((r): r is typeof r & { otherAgent: NonNullable<typeof r.otherAgent> } => r.otherAgent !== null)
    .sort((a, b) => {
      const isAa = a.relationship.agent_a === agentId;
      const isAb = b.relationship.agent_a === agentId;
      const aFriend = Math.abs(isAa ? a.relationship.friendship_ab : a.relationship.friendship_ba);
      const bFriend = Math.abs(isAb ? b.relationship.friendship_ab : b.relationship.friendship_ba);
      return bFriend - aFriend;
    })
    .slice(0, 5);

  return (
    <div>
      {/* Secrets section */}
      <div className="px-3 py-2 border-b border-ui-line">
        <div className="text-xs text-ui-dim font-medium mb-1.5">
          Secrets Known ({secrets.length})
        </div>

        {secrets.length === 0 ? (
          <EmptyState
            compact
            icon="🤐"
            title="Hasn't heard any secrets yet."
            hint="Confessions, crushes and scandals they learn about are kept here."
          />
        ) : (
          <div className="space-y-1.5">
            {secrets.map((fact) => {
              const isHighSecret = fact.sensitivity >= 3;
              return (
                <div
                  key={fact.id}
                  className={`text-[11px] rounded px-1.5 py-1 ${
                    isHighSecret
                      ? "bg-ui-bad/10 border border-ui-bad/25"
                      : "bg-ui-warn/10 border border-ui-warn/20"
                  }`}
                >
                  <div className="flex items-start gap-1">
                    <span className="shrink-0">
                      {isHighSecret ? "🔒" : "🔑"}
                    </span>
                    <span
                      className={`capitalize font-medium shrink-0 ${
                        FACT_COLORS[fact.type] ?? "text-ui-dim"
                      }`}
                    >
                      {fact.type.replace(/_/g, " ")}
                    </span>
                    <span className="text-ui-dim flex-1">{fact.content}</span>
                  </div>
                  <div className="text-[9px] text-ui-muted mt-0.5">
                    Known by {(fact.known_by as number[]).length} people
                    {fact.reliability && fact.reliability !== "confirmed" && (
                      <span className="ml-2 text-ui-warn capitalize">
                        {fact.reliability}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Opinions section */}
      <div className="px-3 py-2 border-b border-ui-line">
        <div className="text-xs text-ui-dim font-medium mb-1.5">
          Opinions
        </div>

        {topRelationships.length === 0 ? (
          <EmptyState
            compact
            icon="🗨"
            title="No strong opinions yet."
            hint="As friendships and grudges form, what they think of each person appears here."
          />
        ) : (
          <div className="space-y-1.5">
            {topRelationships.map((entry) => {
              const rel = entry.relationship;
              const other = entry.otherAgent;
              const isA = rel.agent_a === agentId;
              const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
              const romance = isA ? rel.romance_ab : rel.romance_ba;
              const trust = isA ? rel.trust_ab : rel.trust_ba;

              const opinion = opinionTemplate(
                agentName,
                other.name,
                friendship,
                romance,
                trust,
                rel.status
              );

              const friendshipColor =
                friendship > 40
                  ? "text-ui-blue"
                  : friendship < -20
                  ? "text-ui-bad"
                  : "text-ui-dim";

              return (
                <div key={other.id} className="text-[11px]">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-ui-text font-medium">{other.name}</span>
                    <span className={`text-[10px] ${friendshipColor}`}>
                      {friendship > 0 ? "+" : ""}
                      {Math.round(friendship)}
                    </span>
                  </div>
                  <p className="text-ui-muted italic">{opinion}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
