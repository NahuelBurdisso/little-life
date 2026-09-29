import { useEffect, useMemo, useState } from "react";
import { useActivityFeed } from "../../hooks/useActivityFeed";
import { useWorldState } from "../../hooks/useWorldState";
import { timeAgo } from "../../lib/formatters";
import { renderMessage, type ActivityEntry } from "../../lib/activityMessage";
import { HOT_BREWING } from "../../lib/journal";
import type { BrewingItem } from "../../../server/lib/brewing";

// --- Event Categories ---

const EVENT_CATEGORIES = {
  conversation: { icon: '💬', color: '#6080c0', label: 'Chat' },
  economy:      { icon: '$',  color: '#c8a84b', label: 'Econ' },
  drama:        { icon: '!',  color: '#a03028', label: 'Drama' },
  state_change: { icon: '◆',  color: '#787060', label: 'States' },
  relationship: { icon: '♦',  color: '#a0c060', label: 'Social' },
  world_event:  { icon: '~',  color: '#4080a0', label: 'World' },
  goal:         { icon: '▶',  color: '#c07840', label: 'Goals' },
  aspiration:   { icon: '★',  color: '#9b7ab0', label: 'Dreams' },
  player:       { icon: '✦',  color: '#c8a84b', label: 'You' },
  system:       { icon: '⚙',  color: '#504838', label: 'System' },
  error:        { icon: '✕',  color: '#a03028', label: 'Errors' },
  planning:     { icon: '▷',  color: '#c8a84b', label: 'Plans' },
  cascade:      { icon: '⛓',  color: '#c07840', label: 'Cascade' },
} as const;

type EventCategory = keyof typeof EVENT_CATEGORIES;

function getCategory(type: string): EventCategory {
  if (type === 'conversation_ended') return 'conversation';
  if (type === 'economy' || type === 'salary_paid' || type === 'purchase') return 'economy';
  if (type === 'state_gained' || type === 'state_lost' || type === 'state_change') return 'state_change';
  if (['contemplate', 'fish', 'garden', 'forage', 'perform', 'jog', 'browse', 'cook', 'rest', 'watch'].includes(type)) return 'state_change';
  if (type === 'relationship' || type === 'relationship_status_change') return 'relationship';
  if (type === 'drama' || type === 'theft_caught' || type === 'affair_discovery' || type === 'interaction_resolved') return 'drama';
  if (type === 'confrontation' || type === 'tavern_drunk') return 'drama';
  if (type === 'gift' || type === 'secret_shared' || type === 'birthday' || type === 'tavern_tipsy' || type === 'hobby_levelup') return 'relationship';
  if (type.startsWith('player_') || type.startsWith('challenge_')) return 'player';
  if (type === 'world_event' || type === 'season_survived') return 'world_event';
  if (type === 'goal_ambition_shifted' || type === 'goal_ambition_generated' || type.startsWith('aspiration')) return 'aspiration';
  if (type.startsWith('goal_')) return 'goal';
  if (type === 'plan_generated' || type === 'plan_changed') return 'planning';
  if (type === 'error') return 'error';
  return 'system';
}

// --- Component ---

interface ChainGroup {
  _chain: true;
  chainId: string;
  /** The oldest member present in the feed window, chosen before the per-category
   *  filters run so a filtered-out trigger can't be replaced by its own
   *  consequence. It is the real trigger only when the whole chain fits in the
   *  window — a cascade that straddles the 50-row limit loses its earliest rows,
   *  and this is then the oldest surviving consequence. */
  root: ActivityEntry;
  /** Timestamp of the newest member, filtered or not — the group sits at that
   *  member's slot in the feed, so the header must be labelled with its time. */
  newestTimestamp: number;
  /** Consequences that cleared the category filters. May be empty. */
  events: ActivityEntry[];
}

type DisplayItem =
  | ActivityEntry
  | { _summary: true; count: number; timestamp: number; lastId: number }
  | ChainGroup;

interface ActivityFeedProps {
  /** Selects the agent an event is about, which also focuses the camera on them. */
  onSelectAgent?: (agentId: string) => void;
  /** The 🔥 chip: open the Journal on its Brewing tab. */
  onOpenBrewing?: () => void;
}

/**
 * The live strip under the map: what is happening now (All) and the big beats
 * (Highlights). Stories, Brewing and the rest of the history live in the
 * Journal; the 🔥 chip is the way there when something is close to the boil.
 */
export function ActivityFeed({ onSelectAgent, onOpenBrewing }: ActivityFeedProps) {
  const { activities, highlights, brewing } = useActivityFeed();
  const { world } = useWorldState();
  const [tab, setTab] = useState<'all' | 'highlights'>('all');
  const [filters, setFilters] = useState<Record<EventCategory, boolean>>({
    conversation: true,
    economy: true,
    drama: true,
    state_change: true,
    relationship: true,
    world_event: true,
    goal: true,
    aspiration: true,
    player: true,
    system: true,
    error: true,
    planning: true,
    cascade: true,
  });
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());

  const toggleFilter = (cat: EventCategory) => {
    setFilters(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const toggleChain = (chainId: string) => {
    setExpandedChains(prev => {
      const next = new Set(prev);
      if (next.has(chainId)) {
        next.delete(chainId);
      } else {
        next.add(chainId);
      }
      return next;
    });
  };

  // Separate cascade (chained) events from regular events
  const allEntries = activities as unknown as ActivityEntry[];

  // Build chainId → [entries] map. Memoised because grouping and sorting every
  // chain is proportional to the whole feed, and this component re-renders on
  // unrelated state (filter toggles, chain expansion) as well as on new data.
  const chainMap = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();

    for (const entry of allEntries) {
      const chainId = entry.metadata?.chainId;
      if (chainId) {
        if (!map.has(chainId)) map.set(chainId, []);
        map.get(chainId)!.push(entry);
      }
    }

    // The feed arrives newest-first, which would present a cascade's final effect as
    // the trigger and its cause as the last "consequence". Re-order causally. Row id
    // is the ordering key rather than metadata.chainDepth: a chain is written within
    // a single tick so ids are monotonic, and depth is reset to 1 partway through
    // some cascades, which would scramble the order instead of fixing it.
    for (const events of map.values()) {
      events.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    }

    return map;
  }, [allEntries]);

  // `expandedChains` would otherwise accumulate every chain the user ever opened,
  // long after those rows scrolled off the end of the feed's fixed window.
  useEffect(() => {
    setExpandedChains(prev => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (chainMap.has(id)) next.add(id);
      }
      // Same identity when nothing was pruned, so this can't loop.
      return next.size === prev.size ? prev : next;
    });
  }, [chainMap]);

  // Filter: if cascade filter is off, exclude chained events entirely
  // Otherwise, apply normal category filters to unchained events, cascade groups count as one item
  const filtered = useMemo<DisplayItem[]>(() => {
    const processedChainIds = new Set<string>();

    const out: DisplayItem[] = [];
    let convoBatch = 0;
    let lastConvoTimestamp = 0;
    let lastConvoId = 0;

    const flushConvoBatch = () => {
      if (convoBatch > 0) {
        out.push({
          _summary: true,
          count: convoBatch,
          timestamp: lastConvoTimestamp,
          lastId: lastConvoId,
        });
        convoBatch = 0;
      }
    };

    for (const entry of allEntries) {
      const chainId = entry.metadata?.chainId;

      // Handle chained event — emit the group once when we first see this chainId
      if (chainId && !processedChainIds.has(chainId)) {
        processedChainIds.add(chainId);
        // Cascade is a container filter, not an override: members still have to
        // clear the per-category filters, or unchecking e.g. States would leave
        // every cascade-produced state change on screen inside a ⛓ group.
        // The root is what the group is *about*, so it decides whether the group
        // appears at all — filtering it out while keeping its consequences would
        // promote a consequence to the header and invert the stated causality.
        // `chainMap` only sees the rows `getRecent` returned, so for a cascade
        // that straddles the feed window this is the oldest *surviving* member,
        // not necessarily the trigger. `metadata.chainDepth` can't be used to
        // detect that: it is reset to 1 partway through some cascades.
        const members = chainMap.get(chainId) ?? [entry];
        const root = members[0];
        if (filters.cascade && filters[getCategory(root.type)]) {
          flushConvoBatch();
          out.push({
            _chain: true,
            chainId,
            root,
            newestTimestamp: members[members.length - 1].timestamp,
            events: members.slice(1).filter(e => filters[getCategory(e.type)]),
          });
        }
        continue;
      }
      if (chainId) continue; // rest of the group, already emitted above

      // Regular (unchained) entry
      const cat = getCategory(entry.type);
      if (!filters[cat]) continue;

      if (cat === 'conversation') {
        convoBatch++;
        lastConvoTimestamp = entry.timestamp;
        lastConvoId = entry.id ?? lastConvoId;
      } else {
        flushConvoBatch();
        out.push(entry);
      }
    }
    flushConvoBatch();

    return out;
  }, [allEntries, chainMap, filters]);

  // Highlights are server-filtered to high-importance story beats, so they skip
  // the category filters and cascade grouping entirely.
  const items: DisplayItem[] =
    tab === 'highlights' ? (highlights as unknown as ActivityEntry[]) : filtered;

  const brewingItems = brewing as BrewingItem[];
  const hotCount = brewingItems.filter(b => b.heat >= HOT_BREWING).length;

  return (
    <div className="h-full bg-[#1a1814] border-t border-[#3a3028] flex flex-col">
      {/* Tabs */}
      <div className="flex gap-1 px-2 pt-1 shrink-0">
        {([['all', 'All'], ['highlights', '★ Highlights']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`text-[10px] px-2 py-0.5 border transition-colors ${
              tab === key
                ? 'text-[#d4c9a8] border-[#c07840] bg-[#c0784020]'
                : 'text-[#504838] border-[#3a3028]'
            }`}
          >
            {label}
          </button>
        ))}
        {/* What is brewing, as a count that stays visible whatever the tab: the
            list itself is the Journal's Brewing tab. Warm when something is
            close to going off, quiet otherwise; absent when nothing brews. */}
        {onOpenBrewing && brewingItems.length > 0 && (
          <button
            type="button"
            onClick={onOpenBrewing}
            title={`${brewingItems.length} brewing${hotCount > 0 ? `, ${hotCount} close to the boil` : ''} — open the Journal`}
            aria-label={`${brewingItems.length} brewing${hotCount > 0 ? `, ${hotCount} hot` : ''}: open the Journal's Brewing tab`}
            className={`ml-auto text-[10px] px-2 py-0.5 border transition-colors ${
              hotCount > 0
                ? 'text-ui-warn border-[#c07840] bg-[#a0302820] hover:bg-[#a0302840]'
                : 'text-[#8a7f65] border-[#3a3028] hover:bg-[#2e2b20]'
            }`}
          >
            <span aria-hidden="true">🔥</span> {hotCount > 0 ? hotCount : brewingItems.length}
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div
        className="flex flex-wrap gap-1 px-2 py-1 border-b border-[#3a3028] shrink-0"
        hidden={tab !== 'all'}
      >
        {(Object.entries(EVENT_CATEGORIES) as [EventCategory, (typeof EVENT_CATEGORIES)[EventCategory]][]).map(
          ([key, { icon, color, label }]) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleFilter(key)}
              aria-pressed={filters[key]}
              className={`text-[10px] px-1.5 py-0.5 border transition-colors ${
                filters[key] ? '' : 'opacity-40'
              }`}
              style={
                filters[key]
                  ? { color, borderColor: color, backgroundColor: color + '20' }
                  : { borderColor: '#3a3028' }
              }
              title={label}
            >
              {icon} {label}
            </button>
          ),
        )}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {items.length === 0 ? (
          <p className="text-[#504838] text-xs">
            {tab === 'all' ? 'No activity yet...' : 'No dramatic events yet...'}
          </p>
        ) : (
          <div className="space-y-0.5">
            {items.map((item, i) => {
              // Conversation summary
              if ('_summary' in item) {
                return (
                  // Keyed by the batch's newest row id, not the list index, which
                  // renumbers every row below whenever a new event arrives. The
                  // timestamp and count are part of the key because `lastId` is 0
                  // for a batch whose rows all arrived without ids, which would
                  // collide across every such batch in the list.
                  <div
                    key={`summary-${item.lastId}-${item.timestamp}-${item.count}`}
                    className="text-[11px] text-[#504838] italic pl-1"
                  >
                    💬 {item.count} conversation{item.count > 1 ? 's' : ''} ended
                  </div>
                );
              }

              // Chain group
              if ('_chain' in item) {
                const { chainId, root, newestTimestamp, events } = item;
                const isExpanded = expandedChains.has(chainId);
                const consequenceCount = events.length;
                const autoCollapse = consequenceCount >= 2;

                const headerClass =
                  "w-full text-left text-[11px] flex gap-1.5 border-l-2 pl-1.5 py-0.5";
                const headerStyle = { borderLeftColor: '#c07840', borderLeftWidth: 2 };
                // The group sits at the position of its newest member, so label it
                // with that time — the root's older timestamp would break the
                // feed's top-to-bottom chronology.
                const headerTime = world
                  ? timeAgo(newestTimestamp, world.time.totalTicks, world.tick_speed, world.is_paused)
                  : '';
                // The sentence is the root's, the column time is the chain's latest,
                // so surface the root's own time rather than letting them disagree.
                const headerTitle = world
                  ? `Started ${timeAgo(root.timestamp, world.time.totalTicks, world.tick_speed, world.is_paused)}`
                  : undefined;
                const headerMessage = renderMessage(root);
                const headerSubjectId =
                  onSelectAgent != null ? root.agent_ids?.[0] : undefined;
                const headerBody = (
                  <>
                    <span className="shrink-0">⛓</span>
                    <span className="text-[#504838] shrink-0 w-12 text-right">{headerTime}</span>
                    <span className="text-[#c07840] flex-1">{headerMessage}</span>
                    {consequenceCount > 0 && (
                      <span
                        className="shrink-0 text-[10px] px-1 font-semibold"
                        style={{ backgroundColor: '#c0784020', color: '#c07840', border: '1px solid #c0784040' }}
                      >
                        → {consequenceCount} consequence{consequenceCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="shrink-0 text-[#504838]">
                      {autoCollapse ? (isExpanded ? '▲' : '▼') : ''}
                    </span>
                  </>
                );

                return (
                  <div key={`chain-${chainId}`}>
                    {/* Chain header — only a button when there's something to toggle.
                        Short chains render fully expanded, so toggling is a no-op. */}
                    {autoCollapse ? (
                      <button
                        type="button"
                        onClick={() => toggleChain(chainId)}
                        aria-expanded={isExpanded}
                        className={`${headerClass} cursor-pointer hover:bg-[#2e2b20] focus-visible:bg-[#2e2b20] transition-colors`}
                        style={headerStyle}
                        title={headerTitle}
                      >
                        {headerBody}
                      </button>
                    ) : headerSubjectId != null ? (
                      // Nothing to toggle, so the header behaves like any other
                      // row: click it to focus its subject.
                      <button
                        type="button"
                        onClick={() => onSelectAgent!(String(headerSubjectId))}
                        className={`${headerClass} cursor-pointer hover:bg-[#2e2b20] focus-visible:bg-[#2e2b20] transition-colors`}
                        style={headerStyle}
                        title={headerTitle}
                        aria-label={`${headerTime} ${headerMessage} — focus agent`.trim()}
                      >
                        {headerBody}
                      </button>
                    ) : (
                      <div className={headerClass} style={headerStyle} title={headerTitle}>
                        {headerBody}
                      </div>
                    )}

                    {/* Expanded chain children */}
                    {(!autoCollapse || isExpanded) && consequenceCount > 0 && (
                      <div className="ml-3 border-l-2 border-[#6b5c30] pl-1.5 space-y-0.5 mt-0.5">
                        {events.map((child, ci) => {
                          const childSubjectId = child.agent_ids?.[0];
                          const childClickable = onSelectAgent != null && childSubjectId != null;
                          const childMessage = renderMessage(child);
                          const childTime = world
                            ? timeAgo(child.timestamp, world.time.totalTicks, world.tick_speed, world.is_paused)
                            : '';
                          const childClass = "w-full text-left text-[11px] flex gap-1.5 py-0.5";
                          const childBody = (
                            <>
                              <span className="shrink-0 text-[#c07840]">↳</span>
                              <span className="text-[#504838] shrink-0 w-12 text-right">{childTime}</span>
                              <span className="text-[#8a7f65]">{childMessage}</span>
                            </>
                          );
                          const childKey = child.id ?? `chain-child-${chainId}-${ci}`;
                          return childClickable ? (
                            <button
                              key={childKey}
                              type="button"
                              onClick={() => onSelectAgent!(String(childSubjectId))}
                              className={`${childClass} cursor-pointer hover:bg-[#2e2b20] focus-visible:bg-[#2e2b20] transition-colors`}
                              aria-label={`${childTime} ${childMessage} — focus agent`.trim()}
                            >
                              {childBody}
                            </button>
                          ) : (
                            <div key={childKey} className={childClass}>
                              {childBody}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // Regular event
              const cat = getCategory(item.type);
              const { icon, color } = EVENT_CATEGORIES[cat];
              const isDrama = cat === 'drama';
              const isState = cat === 'state_change';
              const isGoal = cat === 'goal';
              const isAspiration = cat === 'aspiration';
              const isError = cat === 'error';
              // The player's own actions get the gold "✦ You" treatment so they stand
              // out from the town's ambient chatter (they used to fall into "System").
              const isPlayer = cat === 'player';
              const isBold = isDrama || isAspiration || isPlayer;
              const subjectId = item.agent_ids?.[0];
              const clickable = onSelectAgent != null && subjectId != null;
              const message = renderMessage(item);
              const timeLabel = world
                ? timeAgo(item.timestamp, world.time.totalTicks, world.tick_speed, world.is_paused)
                : '';
              const rowStyle = {
                borderLeftColor: color,
                borderLeftWidth: isDrama || isAspiration || isPlayer ? 3 : isState || isGoal ? 2 : 1,
              };
              const rowClass = `w-full text-left text-[11px] flex gap-1.5 border-l-2 pl-1.5 py-0.5 ${
                isBold ? 'font-semibold' : ''
              }`;
              const rowBody = (
                <>
                  <span className="shrink-0">{icon}</span>
                  <span className="text-[#504838] shrink-0 w-12 text-right">{timeLabel}</span>
                  <span className={
                    isDrama ? 'text-[#a03028]' :
                    isAspiration ? 'text-[#9b7ab0]' :
                    isGoal ? 'text-[#c07840]' :
                    isError ? 'text-[#a03028]' :
                    isPlayer ? 'text-[#c8a84b]' :
                    'text-[#a09070]'
                  }>
                    {message}
                  </span>
                </>
              );

              // Only rows with a subject become buttons — a `<button>` with
              // tabIndex={-1} would still be announced as one by screen readers.
              return clickable ? (
                <button
                  key={item.id ?? `entry-${i}`}
                  type="button"
                  onClick={() => onSelectAgent!(String(subjectId))}
                  className={`${rowClass} cursor-pointer hover:bg-[#2e2b20] focus-visible:bg-[#2e2b20] transition-colors`}
                  style={rowStyle}
                  aria-label={`${timeLabel} ${message} — focus agent`.trim()}
                >
                  {rowBody}
                </button>
              ) : (
                <div
                  key={item.id ?? `entry-${i}`}
                  className={rowClass}
                  style={rowStyle}
                >
                  {rowBody}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
