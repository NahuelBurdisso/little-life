import { useEffect, useMemo, type ReactNode } from "react";
import { trpc } from "../../lib/trpc";
import { COLORS } from "../../lib/constants";
import { formatGameMinute, gameTimeAgo } from "../../lib/formatters";
import { ledgerIsStale } from "../../lib/romanceUi";
import type {
  Ledger,
  LedgerCouple,
  LedgerCrush,
  LedgerLonging,
  LedgerLover,
  LedgerMilestone,
  LedgerPerson,
  LedgerScandal,
} from "../../../server/lib/intimacy/ledger";
import { EmptyState } from "./EmptyState";
import { MiniPortrait } from "./MiniPortrait";
import { Skeleton } from "./Skeleton";
import { W } from "./warmClasses";

interface RomanceLedgerProps {
  isOpen: boolean;
  onClose: () => void;
  /** A pair row opens the pair dossier for its two residents (ids as strings, like the graph's edges). */
  onViewPair: (a: string, b: string) => void;
  /** A longing row jumps to that resident on the map. */
  onSelectAgent?: (agentId: string) => void;
}

type Portrait = { name: string; portrait_sprite?: string; gender?: string | null; age?: number | null };

const firstName = (name: string) => name.split(" ")[0];

const KIND_LABEL: Record<LedgerCouple["kind"], string> = {
  married: "Married",
  engaged: "Engaged",
  partners: "Partners",
};

const MILESTONE_LABEL: Record<LedgerMilestone["kind"], { icon: string; text: string }> = {
  first_kiss: { icon: "💋", text: "shared a first kiss" },
  first_night: { icon: "🕯️", text: "spent the first night together" },
};

const SCANDAL_ICON: Record<LedgerScandal["kind"], string> = {
  unwed_pregnancy: "🤰",
  affair: "🗝️",
  tryst_seen: "👀",
  kiss_seen: "👀",
};

// --- Bits ---------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={W.section}>
      <h3 className={W.sectionTitle}>{title}</h3>
      {hint && <p className="text-[10px] text-ui-muted -mt-1 mb-2 leading-snug">{hint}</p>}
      {children}
    </section>
  );
}

/** The two names of a row, small portraits alongside; the whole row opens the pair's dossier. */
function PairRow({
  a,
  b,
  portraits,
  onOpen,
  arrow,
  children,
}: {
  a: LedgerPerson;
  b: LedgerPerson;
  portraits: Map<number, Portrait>;
  onOpen: (a: LedgerPerson, b: LedgerPerson) => void;
  /** Directional rows (crushes) read "a -> b". */
  arrow?: boolean;
  children?: ReactNode;
}) {
  const pa = portraits.get(a.id);
  const pb = portraits.get(b.id);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(a, b)}
        title={`Open ${firstName(a.name)} and ${firstName(b.name)}`}
        className="w-full flex items-center gap-2 py-1.5 px-1 -mx-1 text-left hover:bg-ui-hover transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ui-gold"
      >
        {pa && <MiniPortrait agent={pa} size={22} />}
        <span className="text-xs text-ui-text font-medium truncate">{firstName(a.name)}</span>
        <span aria-hidden="true" className="text-ui-dim text-[10px]">{arrow ? "→" : "&"}</span>
        {pb && <MiniPortrait agent={pb} size={22} />}
        <span className="text-xs text-ui-text font-medium truncate">{firstName(b.name)}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0 text-[10px] text-ui-dim">{children}</span>
      </button>
    </li>
  );
}

function Tag({ children, title, tone = "plain" }: { children: string; title?: string; tone?: "plain" | "gold" | "warn" }) {
  const cls =
    tone === "gold" ? "border-ui-line-accent text-ui-gold"
    : tone === "warn" ? "border-ui-warn/60 text-ui-warn"
    : "border-ui-line text-ui-dim";
  return (
    <span title={title} className={`text-[9px] px-1.5 py-px border ${cls}`}>
      {children}
    </span>
  );
}

// --- Sections ---------------------------------------------------------------------------

function Couples({ rows, ...row }: { rows: LedgerCouple[] } & RowProps) {
  if (rows.length === 0) {
    return <EmptyState compact icon="💍" title="No couples yet." hint="Partners, engagements and marriages are listed here." />;
  }
  return (
    <ul className="divide-y divide-ui-line/50">
      {rows.map((c) => (
        <PairRow key={`${c.a.id}-${c.b.id}`} a={c.a} b={c.b} {...row}>
          <Tag tone={c.kind === "married" ? "gold" : "plain"}>{KIND_LABEL[c.kind]}</Tag>
          {c.sinceMinute != null && (
            <span className="tabular-nums" title={formatGameMinute(c.sinceMinute)}>
              since day {Math.floor(c.sinceMinute / 1440)}
            </span>
          )}
        </PairRow>
      ))}
    </ul>
  );
}

function Lovers({ rows, now, ...row }: { rows: LedgerLover[]; now: number } & RowProps) {
  if (rows.length === 0) {
    return <EmptyState compact icon="🌙" title="Nobody has been seeing anybody in secret." hint="Pairs who spend evenings together outside a marriage appear here." />;
  }
  return (
    <ul className="divide-y divide-ui-line/50">
      {rows.map((l) => (
        <PairRow key={`${l.a.id}-${l.b.id}`} a={l.a} b={l.b} {...row}>
          {l.secret && <Tag tone="warn" title="Nobody in town knows about them">secret</Tag>}
          <span className="tabular-nums" title="Evenings spent together">
            {l.nights} evening{l.nights === 1 ? "" : "s"}
          </span>
          {l.firstNightMinute != null && (
            <span className="tabular-nums" title={`The first: ${formatGameMinute(l.firstNightMinute)}`}>
              first {gameTimeAgo(l.firstNightMinute, now)}
            </span>
          )}
        </PairRow>
      ))}
    </ul>
  );
}

function Longing({
  rows,
  portraits,
  onSelectAgent,
}: {
  rows: LedgerLonging[];
  portraits: Map<number, Portrait>;
  onSelectAgent?: (agentId: string) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState compact icon="🕰️" title="Nobody is aching for anyone right now." />;
  }
  return (
    <ul className="space-y-1">
      {rows.map(({ person, longing }) => {
        const p = portraits.get(person.id);
        const body = (
          <>
            {p && <MiniPortrait agent={p} size={22} />}
            <span className="w-16 shrink-0 text-xs text-ui-text font-medium truncate text-left">{firstName(person.name)}</span>
            <span
              className="relative h-1.5 flex-1 bg-ui-deep border border-ui-line"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={longing}
              aria-label={`${firstName(person.name)}'s longing`}
            >
              <span className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, longing)}%`, backgroundColor: COLORS.relationship.romance }} />
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums text-[10px] text-ui-text">{longing}</span>
          </>
        );
        return (
          <li key={person.id}>
            {onSelectAgent ? (
              <button
                type="button"
                onClick={() => onSelectAgent(String(person.id))}
                className="w-full flex items-center gap-2 py-0.5 px-1 -mx-1 hover:bg-ui-hover transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ui-gold"
                title={`Go to ${firstName(person.name)}`}
              >
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-2 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Crushes({ rows, ...row }: { rows: LedgerCrush[] } & RowProps) {
  if (rows.length === 0) {
    return <EmptyState compact icon="🌸" title="No unanswered crushes." hint="A feeling that is not returned (yet) is listed here." />;
  }
  return (
    <ul className="divide-y divide-ui-line/50">
      {rows.map((c) => (
        <PairRow key={`${c.from.id}>${c.to.id}`} a={c.from} b={c.to} arrow {...row}>
          <span className="tabular-nums" title="How much they feel">💕 {c.romance}</span>
        </PairRow>
      ))}
    </ul>
  );
}

function Scandals({ rows, ...row }: { rows: LedgerScandal[] } & RowProps) {
  if (rows.length === 0) {
    return <EmptyState compact icon="🤫" title="Nothing is being whispered." hint="What the town has found out about its lovers shows up here." />;
  }
  return (
    <ul className="divide-y divide-ui-line/50">
      {rows.map((s) => {
        const text = (
          <span className="flex items-baseline gap-2 min-w-0">
            <span aria-hidden="true">{SCANDAL_ICON[s.kind]}</span>
            <span className="text-[11px] text-ui-text leading-snug">{s.text}</span>
          </span>
        );
        // A scandal that names two people opens their dossier; one that names a single woman has no pair to open.
        return s.b ? (
          <li key={s.factId}>
            <button
              type="button"
              onClick={() => row.onOpen(s.a, s.b!)}
              className="w-full text-left py-1.5 px-1 -mx-1 hover:bg-ui-hover transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ui-gold"
            >
              {text}
            </button>
          </li>
        ) : (
          <li key={s.factId} className="py-1.5">{text}</li>
        );
      })}
    </ul>
  );
}

function Milestones({ rows, now, ...row }: { rows: LedgerMilestone[]; now: number } & RowProps) {
  if (rows.length === 0) {
    return <EmptyState compact icon="📜" title="No firsts recorded yet." hint="First kisses, and the first evening two people spend together, are noted here." />;
  }
  return (
    <ul className="divide-y divide-ui-line/50">
      {rows.map((m) => {
        const look = MILESTONE_LABEL[m.kind];
        return (
          <PairRow key={`${m.kind}-${m.a.id}-${m.b.id}`} a={m.a} b={m.b} {...row}>
            <span aria-hidden="true">{look.icon}</span>
            <span>{look.text}</span>
            <span className="tabular-nums text-ui-muted" title={formatGameMinute(m.minute)}>{gameTimeAgo(m.minute, now)}</span>
          </PairRow>
        );
      })}
    </ul>
  );
}

interface RowProps {
  portraits: Map<number, Portrait>;
  onOpen: (a: LedgerPerson, b: LedgerPerson) => void;
}

// --- Modal --------------------------------------------------------------------------------

/**
 * The Hearts ledger: who is together, who is seeing whom in secret, who aches, who
 * pines unanswered, what the town is whispering and the first times, all in one
 * place (server/lib/intimacy/ledger.ts builds it; the player is the god of the
 * town and so sees secrets). Discreet throughout, and nobody under 18 is ever on it.
 * The adult-layer sections (lovers, longing, first nights, scandals born of a night)
 * are simply absent while the town's adult-content rule is off.
 *
 * Refreshes off the relationships channel and the agents flush (useAgents, throttled);
 * a row opens the pair dossier, which stacks above this modal.
 */
export function RomanceLedger({ isOpen, onClose, onViewPair, onSelectAgent }: RomanceLedgerProps) {
  // No `placeholderData`: a ledger kept from before the rule changed would show its adult chapters
  // (or hide them) until the refetch lands. The rule itself is the reference: a ledger built under
  // the other one is treated as still loading (`ledgerIsStale`) and refetched.
  const utils = trpc.useUtils();
  const { data: ledger, isLoading } = trpc.intimacy.getLedger.useQuery(undefined, { enabled: isOpen });
  const { data: rules } = trpc.world.getRules.useQuery(undefined, { enabled: isOpen });
  const stale = ledgerIsStale(ledger, rules);
  useEffect(() => {
    if (stale) void utils.intimacy.getLedger.invalidate();
  }, [stale, utils]);
  const { data: agents } = trpc.agents.getActive.useQuery(undefined, { enabled: isOpen });

  const portraits = useMemo(
    () => new Map<number, Portrait>((agents ?? []).map((a: { id: number } & Portrait) => [a.id, a])),
    [agents],
  );

  if (!isOpen) return null;

  const row: RowProps = { portraits, onOpen: (a, b) => onViewPair(String(a.id), String(b.id)) };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Hearts ledger"
        className={`${W.modal} w-[640px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`${W.modalHeader} shrink-0`}>
          <h2 className={W.title}>
            <span aria-hidden="true" className="mr-1.5">♥</span>Hearts
          </h2>
          <button onClick={onClose} aria-label="Close" className={W.close}>
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1" style={{ colorScheme: "dark" }}>
          {isLoading || !ledger || stale ? (
            <div className="px-4 py-3 space-y-2" role="status" aria-label="Loading">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-16" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <LedgerBody ledger={ledger} row={row} onSelectAgent={onSelectAgent} />
          )}
        </div>
      </div>
    </div>
  );
}

function LedgerBody({ ledger, row, onSelectAgent }: { ledger: Ledger; row: RowProps; onSelectAgent?: (agentId: string) => void }) {
  const now = ledger.nowMinute;
  return (
    <>
      <Section title={`Couples (${ledger.couples.length})`}>
        <Couples rows={ledger.couples} {...row} />
      </Section>

      {ledger.adultContent && (
        <Section title={`Lovers (${ledger.lovers.length})`} hint="You see what the town does not: pairs marked secret are hiding it.">
          <Lovers rows={ledger.lovers} now={now} {...row} />
        </Section>
      )}

      {ledger.adultContent && (
        <Section title="Longing" hint="Who aches most for someone right now.">
          <Longing rows={ledger.longing} portraits={row.portraits} onSelectAgent={onSelectAgent} />
        </Section>
      )}

      <Section title={`Crushes (${ledger.crushes.length})`} hint="Feelings that are not returned.">
        <Crushes rows={ledger.crushes} {...row} />
      </Section>

      <Section title={`Scandals (${ledger.scandals.length})`}>
        <Scandals rows={ledger.scandals} {...row} />
      </Section>

      <Section title="Firsts">
        <Milestones rows={ledger.milestones} now={now} {...row} />
      </Section>

      {!ledger.adultContent && (
        <p className="px-4 py-2 text-[10px] text-ui-muted">
          Some chapters of this ledger stay closed while adult content is off in this town&apos;s rules.
        </p>
      )}
    </>
  );
}
