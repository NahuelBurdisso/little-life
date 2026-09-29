import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "../../lib/trpc";
import { useNudge } from "../../hooks/useNudge";
import { COLORS } from "../../lib/constants";
import { formatGameMinute, gameTimeAgo } from "../../lib/formatters";
import type {
  DossierArc,
  DossierConversation,
  DossierEvent,
  DossierSecret,
  Feeling,
  HistoryPoint,
  PairDossier as PairDossierData,
} from "../../../server/lib/pairDossier";
import { EmptyState } from "./EmptyState";
import { MiniPortrait } from "./MiniPortrait";
import { Skeleton } from "./Skeleton";
import { W } from "./warmClasses";

interface PairDossierProps {
  /** The two residents (numeric ids), or null when closed. */
  pair: { a: number; b: number } | null;
  onClose: () => void;
  /** Jump to a resident on the map. The caller closes the modals stacked over it. */
  onFocusAgent: (agentId: string) => void;
}

type Metric = "friendship" | "romance" | "trust";

const METRICS: Array<{ key: Metric; label: string; color: string }> = [
  { key: "friendship", label: "Friendship", color: COLORS.relationship.friendship },
  { key: "romance", label: "Romance", color: COLORS.relationship.romance },
  { key: "trust", label: "Trust", color: "#c8a84b" },
];

/** Icon + label per event type; unknown types fall back to their own name. */
const EVENT_LOOK: Record<string, { icon: string; label: string }> = {
  fight: { icon: "👊", label: "Fight" },
  confrontation: { icon: "⚔️", label: "Confrontation" },
  confrontation_escalated: { icon: "🔥", label: "Confrontation escalated" },
  confrontation_resolved: { icon: "🕊️", label: "Confrontation settled" },
  theft_caught: { icon: "🫳", label: "Caught stealing" },
  arrested: { icon: "⛓️", label: "Arrested" },
  confession: { icon: "💌", label: "Confession" },
  seduction: { icon: "🌹", label: "Advance" },
  gift: { icon: "🎁", label: "Gift" },
  reconciliation: { icon: "🤝", label: "Made up" },
  conversation: { icon: "💬", label: "Talked" },
  helped: { icon: "🩹", label: "Helped" },
  begging: { icon: "🥺", label: "Begged" },
  gambling: { icon: "🎲", label: "Gambling" },
  secret_shared: { icon: "🤫", label: "Shared a secret" },
  rumor_backlash: { icon: "📢", label: "Rumor backfired" },
};

function eventLook(type: string) {
  return EVENT_LOOK[type] ?? { icon: "•", label: type.replace(/_/g, " ") };
}

const ARC_LABEL: Record<string, string> = {
  romance: "Romance",
  rivalry: "Rivalry",
  reconciliation: "Reconciliation",
  love_triangle: "Love triangle",
  downfall: "Downfall",
  scandal: "Scandal",
};

function firstName(name: string): string {
  return name.split(" ")[0];
}

function signed(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? "+" : ""}${r}`;
}

function sentimentColor(s: number): string {
  if (s > 0.2) return "var(--ui-positive)";
  if (s < -0.2) return "var(--ui-negative)";
  return "var(--ui-text-secondary)";
}

// --- Feelings ------------------------------------------------------------------

/** A -100..100 value as a bar growing from the middle: right is warm, left is cold. */
function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.min(100, Math.abs(value));
  const cold = value < 0;
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-14 shrink-0 text-ui-dim">{label}</span>
      <div className="relative h-1.5 flex-1 bg-ui-deep border border-ui-line">
        <div className="absolute inset-y-0 left-1/2 w-px bg-ui-line-accent" />
        <div
          className="absolute inset-y-0"
          style={{
            backgroundColor: cold ? COLORS.relationship.rivalry : color,
            width: `${pct / 2}%`,
            [cold ? "right" : "left"]: "50%",
          }}
        />
      </div>
      <span className="w-8 shrink-0 text-right tabular-nums text-ui-text">{Math.round(value)}</span>
    </div>
  );
}

function FeelingCard({ from, to, feeling }: { from: string; to: string; feeling: Feeling }) {
  return (
    <div className={`${W.card} px-3 py-2 space-y-1`}>
      <div className="text-[10px] text-ui-dim truncate">
        <span className="text-ui-text font-medium">{from}</span> feels about {to}
      </div>
      {METRICS.map((m) => (
        <Meter key={m.key} label={m.label} value={feeling[m.key]} color={m.color} />
      ))}
    </div>
  );
}

// --- Sparkline ---------------------------------------------------------------------

const SPARK_W = 560;
const SPARK_H = 96;
const SPARK_PAD = { l: 26, r: 10, t: 8, b: 16 };

function Sparkline({
  series,
  color,
  nameA,
  nameB,
}: {
  series: HistoryPoint[];
  color: string;
  nameA: string;
  nameB: string;
}) {
  const geometry = useMemo(() => {
    const values = series.flatMap((p) => [p.aToB, p.bToA]);
    // Always include zero so "warm" and "cold" read at a glance, and never
    // squash a small wobble into a full-height cliff.
    let lo = Math.min(0, ...values);
    let hi = Math.max(0, ...values);
    if (hi - lo < 30) {
      hi += 15;
      lo -= 15;
    }
    const t0 = series[0].minute;
    const t1 = series[series.length - 1].minute;
    const span = Math.max(1, t1 - t0);
    const x = (m: number) => SPARK_PAD.l + ((m - t0) / span) * (SPARK_W - SPARK_PAD.l - SPARK_PAD.r);
    const y = (v: number) => SPARK_PAD.t + (1 - (v - lo) / (hi - lo)) * (SPARK_H - SPARK_PAD.t - SPARK_PAD.b);
    const line = (pick: (p: HistoryPoint) => number) =>
      series.map((p) => `${x(p.minute).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
    return { lo, hi, x, y, t0, t1, a: line((p) => p.aToB), b: line((p) => p.bToA) };
  }, [series]);

  const last = series[series.length - 1];
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="w-full h-auto"
      role="img"
      aria-label={`History: ${nameA} ends at ${Math.round(last.aToB)}, ${nameB} at ${Math.round(last.bToA)}`}
    >
      {/* zero line + scale */}
      <line
        x1={SPARK_PAD.l}
        x2={SPARK_W - SPARK_PAD.r}
        y1={geometry.y(0)}
        y2={geometry.y(0)}
        stroke="var(--ui-border-accent)"
        strokeDasharray="3 3"
        strokeWidth={1}
      />
      <text x={SPARK_PAD.l - 4} y={geometry.y(0) + 3} textAnchor="end" fontSize={8} fill="var(--ui-text-secondary)">0</text>
      <text x={SPARK_PAD.l - 4} y={SPARK_PAD.t + 6} textAnchor="end" fontSize={8} fill="var(--ui-text-secondary)">{Math.round(geometry.hi)}</text>
      <text x={SPARK_PAD.l - 4} y={SPARK_H - SPARK_PAD.b} textAnchor="end" fontSize={8} fill="var(--ui-text-secondary)">{Math.round(geometry.lo)}</text>
      <polyline points={geometry.a} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <polyline points={geometry.b} fill="none" stroke={color} strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" opacity={0.85} />
      <circle cx={geometry.x(last.minute)} cy={geometry.y(last.aToB)} r={3} fill={color} />
      <circle cx={geometry.x(last.minute)} cy={geometry.y(last.bToA)} r={3} fill="var(--ui-bg-panel)" stroke={color} strokeWidth={1.5} />
      <text x={SPARK_PAD.l} y={SPARK_H - 3} fontSize={8} fill="var(--ui-text-secondary)">{formatGameMinute(geometry.t0)}</text>
      <text x={SPARK_W - SPARK_PAD.r} y={SPARK_H - 3} textAnchor="end" fontSize={8} fill="var(--ui-text-secondary)">{formatGameMinute(geometry.t1)}</text>
    </svg>
  );
}

function History({ dossier, first, second }: { dossier: PairDossierData; first: string; second: string }) {
  const available = METRICS.filter((m) => dossier.history[m.key].length > 0);
  const [metric, setMetric] = useState<Metric>("friendship");
  const active = available.find((m) => m.key === metric) ?? available[0];

  if (!active) {
    return (
      <EmptyState
        compact
        icon="📈"
        title="No recorded changes yet."
        hint="Every chat, gift and clash that moves how they feel is charted here."
      />
    );
  }
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {available.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMetric(m.key)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              active.key === m.key
                ? "bg-ui-hover text-ui-text border-ui-line-accent"
                : "text-ui-dim border-ui-line hover:border-ui-line-accent"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-ui-dim">
          <span className="inline-flex items-center gap-1">
            <svg width="16" height="6" aria-hidden="true"><line x1="0" x2="16" y1="3" y2="3" stroke={active.color} strokeWidth="2" /></svg>
            {first}
          </span>
          <span className="inline-flex items-center gap-1">
            <svg width="16" height="6" aria-hidden="true"><line x1="0" x2="16" y1="3" y2="3" stroke={active.color} strokeWidth="2" strokeDasharray="4 2" /></svg>
            {second}
          </span>
        </span>
      </div>
      <Sparkline series={dossier.history[active.key]} color={active.color} nameA={first} nameB={second} />
      <p className="text-[9px] text-ui-muted mt-0.5">
        Rebuilt backwards from today&apos;s values using the recorded events; small chats older than three game days
        are no longer kept, and slow drift between events is folded into the earlier points.
      </p>
    </div>
  );
}

// --- Story so far ----------------------------------------------------------------------

type StoryItem =
  | { kind: "event"; minute: number; key: string; event: DossierEvent }
  | { kind: "conversation"; minute: number; key: string; convo: DossierConversation };

function Chip({ title, children }: { title: string; children: string }) {
  return (
    <span title={title} className="text-[9px] px-1.5 py-px border border-ui-line text-ui-dim tabular-nums">
      {children}
    </span>
  );
}

function StoryRow({ item, now, first, second }: { item: StoryItem; now: number; first: string; second: string }) {
  const when = (
    <span
      className="text-[9px] text-ui-muted shrink-0 tabular-nums"
      title={item.kind === "conversation" && item.convo.gameMinuteApproximate ? "Approximate: dated from wall-clock age" : undefined}
    >
      {item.kind === "conversation" && item.convo.gameMinuteApproximate ? "~" : ""}
      {formatGameMinute(item.minute)} · {gameTimeAgo(item.minute, now)}
    </span>
  );

  if (item.kind === "conversation") {
    const c = item.convo;
    return (
      <li className="flex gap-2.5 py-1.5">
        <span aria-hidden="true" className="w-5 text-center shrink-0">💬</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-ui-text font-medium">
              Talked{c.topic ? ` about ${c.topic}` : ""}
            </span>
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sentimentColor(c.sentiment) }} title={`Mood of the chat: ${c.sentiment.toFixed(2)}`} />
            <span className="text-[9px] text-ui-muted">{c.turns} lines{c.otherParticipants > 0 ? ` · with ${c.otherParticipants} other${c.otherParticipants > 1 ? "s" : ""}` : ""}</span>
            {when}
          </div>
          {c.quote && (
            <p className="text-[11px] text-ui-dim italic leading-snug mt-0.5">
              {firstName(c.quote.speakerName)}: &ldquo;{c.quote.text}&rdquo;
            </p>
          )}
        </div>
      </li>
    );
  }

  const e = item.event;
  const look = eventLook(e.eventType);
  return (
    <li className="flex gap-2.5 py-1.5">
      <span aria-hidden="true" className="w-5 text-center shrink-0">{look.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-xs font-medium ${e.pivotal ? "text-ui-gold" : "text-ui-text"}`}>{look.label}</span>
          {e.friendshipAToB !== 0 || e.friendshipBToA !== 0 ? (
            <Chip title={`Friendship: ${first} ${signed(e.friendshipAToB)}, ${second} ${signed(e.friendshipBToA)}`}>
              {`🤝 ${signed(e.friendshipAToB)} / ${signed(e.friendshipBToA)}`}
            </Chip>
          ) : null}
          {e.romanceAToB !== 0 || e.romanceBToA !== 0 ? (
            <Chip title={`Romance: ${first} ${signed(e.romanceAToB)}, ${second} ${signed(e.romanceBToA)}`}>
              {`💕 ${signed(e.romanceAToB)} / ${signed(e.romanceBToA)}`}
            </Chip>
          ) : null}
          {!e.processed && <span className="text-[9px] text-ui-warn">just happened</span>}
          {when}
        </div>
        <p className="text-[11px] text-ui-dim leading-snug">{e.description}</p>
      </div>
    </li>
  );
}

function StorySoFar({ dossier, first, second }: { dossier: PairDossierData; first: string; second: string }) {
  const [showMinor, setShowMinor] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const { items, hidden } = useMemo(() => {
    const all: StoryItem[] = [
      ...dossier.events.map((event): StoryItem => ({ kind: "event", minute: event.gameMinute, key: `e${event.id}`, event })),
      ...dossier.conversations.map((convo): StoryItem => ({ kind: "conversation", minute: convo.gameMinute, key: `c${convo.id}`, convo })),
    ];
    // A pair's ordinary small talk is one event per chat, next to the chat
    // itself, so the default view shows the turning points and the
    // conversations and folds the rest away.
    const minor = (i: StoryItem) => i.kind === "event" && !i.event.pivotal && i.event.eventType === "conversation";
    const shown = showMinor ? all : all.filter((i) => !minor(i));
    shown.sort((x, y) => x.minute - y.minute || x.key.localeCompare(y.key));
    return { items: shown, hidden: all.length - shown.length };
  }, [dossier.events, dossier.conversations, showMinor]);

  // Oldest first reads as a story, but the newest lines are what the player
  // came for: open scrolled to the end.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  if (items.length === 0 && hidden === 0) {
    return (
      <EmptyState
        compact
        icon="📖"
        title="Nothing has happened between them yet."
        hint="Turning points and conversations will be told here in order."
      />
    );
  }
  return (
    <div>
      <div ref={scroller} className="max-h-64 overflow-y-auto pr-1" style={{ colorScheme: "dark" }}>
        <ul className="divide-y divide-ui-line/50">
          {items.map((item) => (
            <StoryRow key={item.key} item={item} now={dossier.nowMinute} first={first} second={second} />
          ))}
        </ul>
      </div>
      {(hidden > 0 || showMinor) && (
        <button
          type="button"
          onClick={() => setShowMinor((v) => !v)}
          className="mt-1.5 text-[10px] text-ui-dim hover:text-ui-gold underline underline-offset-2"
        >
          {showMinor ? "Hide routine chat notes" : `Show ${hidden} routine chat note${hidden === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

// --- Secrets and arcs -------------------------------------------------------------------

function SecretRow({ secret, first, second }: { secret: DossierSecret; first: string; second: string }) {
  const scope =
    secret.scope === "between" ? "Between them" : secret.scope === "about_a" ? `About ${first}` : `About ${second}`;
  return (
    <li className="py-1.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[9px] uppercase tracking-wider text-ui-gold">{scope}</span>
        <span className="text-[9px] text-ui-muted" title="Sensitivity">
          {"●".repeat(Math.max(1, Math.min(5, secret.sensitivity)))}
        </span>
        {secret.isPublic && <span className="text-[9px] text-ui-warn">common knowledge</span>}
      </div>
      <p className="text-[11px] text-ui-text leading-snug">{secret.content}</p>
      <p className="text-[9px] text-ui-muted">
        {secret.knownByNames.length === 0 ? "Nobody in town knows." : `Known by ${secret.knownByNames.join(", ")}`}
      </p>
    </li>
  );
}

function ArcRow({ arc, now }: { arc: DossierArc; now: number }) {
  const latest = [...arc.beats].reverse().find((b) => b.gameMinute != null);
  return (
    <li className="py-1.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs text-ui-text font-medium">{arc.title}</span>
        <span className="text-[9px] px-1.5 py-px border border-ui-line-accent text-ui-gold">{ARC_LABEL[arc.kind] ?? arc.kind}</span>
        <span className="text-[9px] text-ui-muted" title="How hot the story is right now">
          {"🔥".repeat(arc.heat > 0.66 ? 3 : arc.heat > 0.33 ? 2 : 1)}
        </span>
        {latest?.gameMinute != null && <span className="text-[9px] text-ui-muted">{gameTimeAgo(latest.gameMinute, now)}</span>}
      </div>
      <p className="text-[11px] text-ui-dim leading-snug">{arc.summary}</p>
    </li>
  );
}

// --- Modal --------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={W.section}>
      <h3 className={W.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * One pair on one page (server/lib/pairDossier.ts): both directions of the
 * relationship, how it got here (sparkline + turning points + conversations),
 * the secrets and story arcs around it. Opened from the relationship graph
 * (click an edge), the agent panel's relationship rows, and the nudge menu's
 * "View relationship".
 *
 * Fresh because `useAgents` invalidates `relationships.getPair` on the agents
 * channel (throttled to one refetch per ~3 s), next to the graph query; the
 * modal itself needs no subscription.
 */
export function PairDossier({ pair, onClose, onFocusAgent }: PairDossierProps) {
  const nudge = useNudge();
  const { data: agents } = trpc.agents.getActive.useQuery(undefined, { enabled: pair != null });
  const { data: dossier, isLoading } = trpc.relationships.getPair.useQuery(
    pair ?? { a: 0, b: 0 },
    { enabled: pair != null, placeholderData: (prev) => prev },
  );
  const [talking, setTalking] = useState(false);

  if (!pair) return null;

  const agentA = agents?.find((x: { id: number }) => x.id === pair.a);
  const agentB = agents?.find((x: { id: number }) => x.id === pair.b);
  const nameA = dossier?.a.name ?? agentA?.name ?? "…";
  const nameB = dossier?.b.name ?? agentB?.name ?? "…";
  const first = firstName(nameA);
  const second = firstName(nameB);
  const rel = dossier?.relationship ?? null;

  const makeThemTalk = async () => {
    setTalking(true);
    try {
      await nudge.suggestTalk(pair.a, pair.b);
    } finally {
      setTalking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${nameA} and ${nameB}`}
        className={`${W.modal} w-[680px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`${W.modalHeader} shrink-0`}>
          <div className="flex items-center gap-2 min-w-0">
            {agentA && <MiniPortrait agent={agentA} size={28} />}
            <h2 className={`${W.title} truncate`}>
              {nameA} <span className="text-ui-dim font-normal">&amp;</span> {nameB}
            </h2>
            {agentB && <MiniPortrait agent={agentB} size={28} />}
            {rel && rel.status !== "strangers" && (
              <span className="text-[10px] px-1.5 py-0.5 bg-ui-raised text-ui-text border border-ui-line capitalize shrink-0">
                {rel.status.replace(/_/g, " ")}
              </span>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className={W.close}>
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1" style={{ colorScheme: "dark" }}>
          {/* Actions */}
          <div className="flex flex-wrap gap-2 px-4 py-2.5 border-b border-ui-line">
            <button type="button" onClick={() => onFocusAgent(String(pair.a))} className={`px-2.5 py-1 text-xs ${W.btn}`}>
              📍 Go to {first}
            </button>
            <button type="button" onClick={() => onFocusAgent(String(pair.b))} className={`px-2.5 py-1 text-xs ${W.btn}`}>
              📍 Go to {second}
            </button>
            <button
              type="button"
              disabled={talking}
              onClick={makeThemTalk}
              title={`Suggest that ${first} and ${second} have a chat`}
              className={`ml-auto px-3 py-1 text-xs ${W.btnPrimary}`}
            >
              💬 Make them talk
            </button>
          </div>

          {isLoading || !dossier ? (
            <div className="px-4 py-3 space-y-2" role="status" aria-label="Loading">
              <Skeleton className="h-3 w-48" />
              <Skeleton className="h-16" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <>
              <Section title="How they feel now">
                {rel ? (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <FeelingCard from={first} to={second} feeling={rel.aToB} />
                      <FeelingCard from={second} to={first} feeling={rel.bToA} />
                    </div>
                    <p className="text-[10px] text-ui-muted mt-1.5">
                      {rel.interactionCount} interaction{rel.interactionCount === 1 ? "" : "s"} · familiarity {Math.round(rel.familiarity)}
                      {rel.tags.length > 0 && <> · {rel.tags.join(", ")}</>}
                    </p>
                  </>
                ) : (
                  <EmptyState
                    compact
                    icon="👋"
                    title="They haven't really met."
                    hint="A first conversation creates the bond this page follows."
                  />
                )}
              </Section>

              <Section title="How it got here">
                <History dossier={dossier} first={first} second={second} />
              </Section>

              <Section title="Their story so far">
                <StorySoFar dossier={dossier} first={first} second={second} />
              </Section>

              {dossier.arcs.length > 0 && (
                <Section title="Story arcs">
                  <ul className="divide-y divide-ui-line/50">
                    {dossier.arcs.map((arc) => (
                      <ArcRow key={arc.id} arc={arc} now={dossier.nowMinute} />
                    ))}
                  </ul>
                </Section>
              )}

              {dossier.secrets.length > 0 && (
                <Section title="Secrets around them">
                  <ul className="divide-y divide-ui-line/50">
                    {dossier.secrets.map((s) => (
                      <SecretRow key={s.id} secret={s} first={first} second={second} />
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
