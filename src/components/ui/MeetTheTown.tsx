import { useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { useEscapeClose } from "../../hooks/useEscapeClose";
import { buildResidentCards, secretsLine, type ResidentCard, type TourAgent } from "../../lib/townTour";
import { MiniPortrait } from "./MiniPortrait";
import { W } from "./warmClasses";

/** How the overlay was left: Skip drops the coach marks too, everything else moves on to them. */
export type TourExit = "skip" | "continue";

interface MeetTheTownProps {
  isOpen: boolean;
  onClose: (exit: TourExit) => void;
  agents: ReadonlyArray<TourAgent>;
  /** Focus a resident on the map (App's focusAgent). */
  onSelectAgent: (agentId: string) => void;
  /** Opened from the toolbar after the intro was already seen: a plain Close, no "next". */
  replay?: boolean;
}

const ARC_ICON: Record<string, string> = {
  romance: "💞",
  rivalry: "⚔️",
  reconciliation: "🤝",
  love_triangle: "🔺",
  downfall: "📉",
  scandal: "🗞️",
};

function Row({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-snug">
      <span aria-hidden className="w-4 shrink-0 text-center">
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Card({ card, onPick }: { card: ResidentCard; onPick: () => void }) {
  const secrets = secretsLine(card.secretCount);
  return (
    <button
      type="button"
      onClick={onPick}
      title={`Go to ${card.name} on the map`}
      className={`${W.card} text-left p-3 flex flex-col gap-2 hover:bg-[var(--ui-bg-hover)] hover:border-[var(--ui-border-accent)] transition-colors`}
    >
      <div className="flex items-center gap-2.5">
        <MiniPortrait agent={{ name: card.name, portrait_sprite: card.portraitSprite }} size={48} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-[var(--ui-accent-gold)] truncate">{card.name}</div>
          <div className={`text-[11px] ${W.muted} truncate`}>
            {card.age} · {card.workplace ? `works at ${card.workplace}` : "no regular job"}
          </div>
        </div>
      </div>
      {card.hook && <p className="text-xs text-[var(--ui-text-primary)] leading-snug">{card.hook}</p>}
      <div className="flex flex-col gap-1 mt-auto">
        {card.tie && (
          <Row icon="❤️">
            <span className={W.muted}>Closest to</span> {card.tie.name}{" "}
            <span className={W.muted}>({card.tie.label})</span>
          </Row>
        )}
        {card.rival && (
          <Row icon="⚡">
            <span className={W.muted}>Friction with</span> {card.rival.name}{" "}
            <span className={W.muted}>({card.rival.label})</span>
          </Row>
        )}
        {secrets && (
          <Row icon="🤫">
            <span className="text-[var(--ui-accent-blue)]">{secrets}</span>
          </Row>
        )}
        {card.arcs.slice(0, 2).map((arc) => (
          <Row key={arc.id} icon={ARC_ICON[arc.kind] ?? "📖"}>
            <span className="text-[var(--ui-warning)]">{arc.title}</span>
          </Row>
        ))}
        {!card.tie && !card.rival && !secrets && card.arcs.length === 0 && (
          <span className={`text-[11px] ${W.faint}`}>Still finding their place. Watch this one.</span>
        )}
      </div>
    </button>
  );
}

/**
 * First-run overlay: who lives here. Every card is assembled from queries the app
 * already runs, so nothing is spoiled beyond what the player would see in the side
 * panels; secrets show only as a count. Clicking a card jumps the camera to that
 * resident.
 */
export function MeetTheTown({ isOpen, onClose, agents, onSelectAgent, replay = false }: MeetTheTownProps) {
  const { data: relationships } = trpc.relationships.getGraph.useQuery(undefined, { enabled: isOpen });
  const { data: secrets } = trpc.knowledge.getSecretNetwork.useQuery(undefined, { enabled: isOpen });
  const { data: arcs } = trpc.chronicle.getArcs.useQuery({ limit: 30 }, { enabled: isOpen });
  const { data: places } = trpc.locations.getAll.useQuery(undefined, { enabled: isOpen });

  useEscapeClose(isOpen, () => onClose("continue"));

  const cards = useMemo(
    () =>
      isOpen
        ? buildResidentCards({
            agents,
            relationships: relationships ?? [],
            secrets: secrets ?? [],
            arcs: arcs ?? [],
            places: places ?? [],
          })
        : [],
    [isOpen, agents, relationships, secrets, arcs, places],
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => onClose("continue")}
      role="dialog"
      aria-modal="true"
      aria-label="Meet the town"
    >
      <div
        className={`${W.modal} w-[980px] max-w-full max-h-[90vh] flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={W.modalHeader}>
          <div>
            <h2 className={`${W.title} text-base`}>Meet the town</h2>
            <p className={`text-[11px] ${W.muted}`}>
              {cards.length} residents. Click anyone to find them on the map.
            </p>
          </div>
          <button onClick={() => onClose("continue")} className={W.close} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {cards.length === 0 ? (
            <p className={`text-xs ${W.muted}`}>Nobody has moved in yet.</p>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  onPick={() => {
                    onSelectAgent(String(card.id));
                    onClose("continue");
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 border-t border-[var(--ui-border)] bg-[var(--ui-bg-raised)]">
          {replay ? (
            <>
              <span />
              <button onClick={() => onClose("skip")} className={`px-4 py-1.5 text-xs font-semibold ${W.btnPrimary}`}>
                Close
              </button>
            </>
          ) : (
            <>
              <button onClick={() => onClose("skip")} className={`px-3 py-1.5 text-xs ${W.btn}`}>
                Skip intro
              </button>
              <button
                onClick={() => onClose("continue")}
                className={`px-4 py-1.5 text-xs font-semibold ${W.btnPrimary}`}
              >
                Show me around
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
