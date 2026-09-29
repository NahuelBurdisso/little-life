import { useEffect } from "react";
import { trpc } from "../../lib/trpc";
import { useBrewing } from "../../hooks/useBrewing";
import { useWorldState } from "../../hooks/useWorldState";
import { gameMinutes } from "../../../server/lib/gameClock";
import type { StoryArc } from "../../../server/lib/chronicle";
import type { BrewingItem } from "../../../server/lib/brewing";
import type { InboxEntry } from "../../lib/alertInbox";
import {
  HOT_BREWING, JOURNAL_TABS, badgeText, stepTab, tabBadges, tabForDigit, type JournalTab,
} from "../../lib/journal";
import { BrewingList, StoryArcList } from "./StoryLists";
import { TimelineView } from "./Timeline";
import { GazetteView } from "./Gazette";
import { InboxView } from "./Inbox";
import { ConversationHistoryView } from "./ConversationHistory";
import { ChallengesView } from "./ChallengesView";

interface JournalProps {
  /** The tab showing, or null when the Journal is closed (App owns it: `openJournal(tab)`). */
  tab: JournalTab | null;
  onTabChange: (tab: JournalTab) => void;
  onClose: () => void;
  /** A resident was clicked: the caller closes the Journal (it covers the map) and focuses them. */
  onSelectAgent: (agentId: string) => void;
  /** Alerts (useDramaAlerts), for the Inbox tab and its badge. */
  inbox: {
    entries: readonly InboxEntry[];
    unread: number;
    markAllRead: () => void;
    clear: () => void;
  };
  /** A Town Crier edition not yet opened (useGazette). */
  hasNewPaper: boolean;
  agents: ReadonlyArray<{ id: number | string; name: string }>;
}

/** Typing in a field (Talks search, Timeline resident picker) keeps its keys. */
function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

/**
 * The Town Journal: every story surface in one place. Brewing and Stories used
 * to be feed tabs, the Timeline and conversation History were toolbar modals,
 * the Inbox a bell popover and the Paper its own modal; seven places to look
 * for "what happened". Opened with J or the TopBar's 📖, deep-linked from the
 * feed's 🔥 chip and the recap card.
 *
 * Only the showing tab is mounted, so each keeps its old "query only while
 * visible" behaviour, and filters reset when the tab is left. Escape is App's
 * (its overlay chain); ← / → and 1–7 switch tabs here, taken in the capture
 * phase so the digits don't also change the speed.
 */
export function Journal({ tab, onTabChange, onClose, onSelectAgent, inbox, hasNewPaper, agents }: JournalProps) {
  const { brewing } = useBrewing();
  const brewingItems = brewing as BrewingItem[];
  const hotBrewing = brewingItems.filter((b) => b.heat >= HOT_BREWING).length;
  const badges = tabBadges({ unreadAlerts: inbox.unread, hasNewPaper, hotBrewing });

  useEffect(() => {
    if (tab == null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      let next: JournalTab | null = null;
      if (e.key === "ArrowRight") next = stepTab(tab, 1);
      else if (e.key === "ArrowLeft") next = stepTab(tab, -1);
      else next = tabForDigit(e.key);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      onTabChange(next);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [tab, onTabChange]);

  if (tab == null) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Town Journal"
        className="bg-ui-panel border border-ui-line-accent shadow-2xl w-[780px] max-w-[95vw] h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 pt-2.5 border-b border-ui-line shrink-0 bg-ui-raised">
          <h2 className="text-sm font-bold text-ui-gold tracking-wide whitespace-nowrap pb-2">
            <span aria-hidden="true">📖 </span>Town Journal
          </h2>
          <div role="tablist" aria-label="Journal sections" className="flex-1 min-w-0 flex items-end gap-0.5 overflow-x-auto">
            {JOURNAL_TABS.map((t, i) => {
              const on = t.key === tab;
              const badge = badges[t.key];
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  id={`journal-tab-${t.key}`}
                  aria-selected={on}
                  aria-controls="journal-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => onTabChange(t.key)}
                  title={`${t.hint} (${i + 1})`}
                  className={`relative shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs border-b-2 transition-colors whitespace-nowrap ${
                    on
                      ? "border-ui-gold text-ui-text bg-ui-panel"
                      : "border-transparent text-ui-dim hover:text-ui-text hover:bg-ui-hover"
                  }`}
                >
                  <span aria-hidden="true">{t.icon}</span>
                  {t.label}
                  {badge != null && (
                    <span
                      className={`ml-0.5 text-[9px] font-bold rounded-full px-1 min-w-3.5 h-3.5 inline-flex items-center justify-center text-ui-deep ${
                        t.key === "brewing" ? "bg-ui-warn" : t.key === "inbox" ? "bg-ui-alert-player" : "bg-ui-gold"
                      }`}
                      aria-label={badge === "new" ? "new edition" : `${badge} ${t.key === "inbox" ? "unread" : "hot"}`}
                    >
                      {badge === "new" ? "new" : badgeText(badge)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ui-dim hover:text-ui-text text-lg leading-none pb-2"
            aria-label="Close the Journal"
            title="Close (Esc or J)"
          >
            &times;
          </button>
        </div>

        <div
          id="journal-panel"
          role="tabpanel"
          aria-labelledby={`journal-tab-${tab}`}
          className="flex-1 min-h-0 overflow-y-auto"
        >
          <JournalTabBody tab={tab} onSelectAgent={onSelectAgent} inbox={inbox} agents={agents} items={brewingItems} />
        </div>
      </div>
    </div>
  );
}

function JournalTabBody({
  tab,
  onSelectAgent,
  inbox,
  agents,
  items,
}: {
  tab: JournalTab;
  onSelectAgent: (agentId: string) => void;
  inbox: JournalProps["inbox"];
  agents: JournalProps["agents"];
  items: BrewingItem[];
}) {
  switch (tab) {
    case "brewing":
      return <BrewingList items={items} onSelectAgent={onSelectAgent} />;
    case "stories":
      return <StoriesTab onSelectAgent={onSelectAgent} />;
    case "timeline":
      return <TimelineView onSelectAgent={onSelectAgent} />;
    case "paper":
      return <GazetteView />;
    case "inbox":
      return <InboxTab inbox={inbox} agents={agents} onSelectAgent={onSelectAgent} />;
    case "talks":
      return <ConversationHistoryView onSelectAgent={onSelectAgent} />;
    case "challenges":
      return <ChallengesView agents={agents} onSelectAgent={onSelectAgent} />;
  }
}

/**
 * Same query key as the feed used to hold, so the feed's `activity.onUpdate`
 * subscription (useActivityFeed, always mounted) keeps it fresh.
 */
function StoriesTab({ onSelectAgent }: { onSelectAgent: (agentId: string) => void }) {
  const { data: arcs } = trpc.chronicle.getArcs.useQuery({ limit: 12 });
  const { world } = useWorldState();
  return (
    <StoryArcList
      arcs={(arcs ?? []) as StoryArc[]}
      nowMinute={world?.time ? gameMinutes(world.time) : null}
      onSelectAgent={onSelectAgent}
    />
  );
}

function InboxTab({
  inbox,
  agents,
  onSelectAgent,
}: {
  inbox: JournalProps["inbox"];
  agents: JournalProps["agents"];
  onSelectAgent: (agentId: string) => void;
}) {
  const { world } = useWorldState();
  return (
    <InboxView
      entries={inbox.entries}
      onMarkAllRead={inbox.markAllRead}
      onClear={inbox.clear}
      agents={agents}
      onFocusAgent={onSelectAgent}
      nowTicks={world?.time?.totalTicks ?? 0}
      tickSpeed={world?.tick_speed ?? 1}
      isPaused={Boolean(world?.is_paused)}
    />
  );
}
