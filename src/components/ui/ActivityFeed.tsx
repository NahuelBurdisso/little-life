import { useState } from "react";
import { useActivityFeed } from "../../hooks/useActivityFeed";
import { useWorldState } from "../../hooks/useWorldState";
import { timeAgo } from "../../lib/formatters";

// --- Event Categories ---

const EVENT_CATEGORIES = {
  conversation: { icon: '🗣️', color: '#9ca3af', label: 'Chat' },
  economy: { icon: '💰', color: '#eab308', label: 'Econ' },
  drama: { icon: '💔', color: '#ef4444', label: 'Drama' },
  state_change: { icon: '🧠', color: '#a855f7', label: 'States' },
  relationship: { icon: '🤝', color: '#60a5fa', label: 'Social' },
  world_event: { icon: '🌍', color: '#22c55e', label: 'World' },
  system: { icon: '⚙️', color: '#6b7280', label: 'System' },
  planning: { icon: '🧭', color: '#f59e0b', label: 'Plans' },
  cascade: { icon: '⛓', color: '#f97316', label: 'Cascade' },
} as const;

type EventCategory = keyof typeof EVENT_CATEGORIES;

function getCategory(type: string): EventCategory {
  if (type === 'conversation_ended') return 'conversation';
  if (type === 'economy') return 'economy';
  if (type === 'state_change') return 'state_change';
  if (type === 'relationship' || type === 'relationship_status_change') return 'relationship';
  if (type === 'drama' || type === 'theft_caught' || type === 'affair_discovery') return 'drama';
  if (type === 'world_event') return 'world_event';
  if (type === 'plan_generated' || type === 'plan_changed') return 'planning';
  return 'system';
}

// --- Helpers ---

function renderMessage(entry: ActivityEntry): string {
  const d = entry.template_data ?? {};
  if (d.message) return String(d.message);
  if (d.description) return String(d.description);
  // Plan events
  if (entry.type === 'plan_generated' && d.agentName) return `${d.agentName} planned their day.`;
  if (entry.type === 'plan_changed' && d.agentName) return `${d.agentName} changed plans${d.reason ? ': ' + String(d.reason).substring(0, 50) : ''}.`;
  if (d.agent && d.state) {
    if (entry.type === 'state_gained') return `${d.agent} became ${d.state}.`;
    if (entry.type === 'state_lost') return `${d.agent} is no longer ${d.state}.`;
  }
  if (d.agent1 && d.agent2 && d.status) return `${d.agent1} and ${d.agent2} are now ${d.status}.`;
  if (d.agent1 && d.agent2 && d.location !== undefined) return `${d.agent1} and ${d.agent2} finished talking.`;
  if (d.agent && d.amount) return `${d.agent} earned ${d.amount} coins.`;
  if (d.agent && d.item) return `${d.agent} bought ${d.item}.`;
  return entry.type;
}

// --- Component ---

interface ActivityEntry {
  id?: number;
  type: string;
  template_data?: Record<string, string | number>;
  metadata?: { chainId?: string; chainDepth?: number; ruleId?: string } | null;
  timestamp: number;
  real_timestamp?: number;
  agent_ids?: number[];
}

interface ChainGroup {
  _chain: true;
  chainId: string;
  events: ActivityEntry[];
}

type DisplayItem =
  | ActivityEntry
  | { _summary: true; count: number; timestamp: number }
  | ChainGroup;

export function ActivityFeed() {
  const { activities } = useActivityFeed();
  const { world } = useWorldState();
  const [filters, setFilters] = useState<Record<EventCategory, boolean>>({
    conversation: true,
    economy: true,
    drama: true,
    state_change: true,
    relationship: true,
    world_event: true,
    system: true,
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

  // Build chainId → [entries] map
  const chainMap = new Map<string, ActivityEntry[]>();
  const chainedIds = new Set<number>();

  for (const entry of allEntries) {
    const chainId = entry.metadata?.chainId;
    if (chainId) {
      if (!chainMap.has(chainId)) chainMap.set(chainId, []);
      chainMap.get(chainId)!.push(entry);
      if (entry.id != null) chainedIds.add(entry.id);
    }
  }

  // Filter: if cascade filter is off, exclude chained events entirely
  // Otherwise, apply normal category filters to unchained events, cascade groups count as one item
  const processedChainIds = new Set<string>();

  const filtered: DisplayItem[] = [];
  let convoBatch = 0;
  let lastConvoTimestamp = 0;

  const flushConvoBatch = () => {
    if (convoBatch > 0) {
      filtered.push({ _summary: true, count: convoBatch, timestamp: lastConvoTimestamp });
      convoBatch = 0;
    }
  };

  for (const entry of allEntries) {
    const chainId = entry.metadata?.chainId;

    // Handle chained event — emit the group once when we first see this chainId
    if (chainId && !processedChainIds.has(chainId)) {
      processedChainIds.add(chainId);
      if (filters.cascade) {
        const chainEvents = chainMap.get(chainId) ?? [entry];
        flushConvoBatch();
        filtered.push({ _chain: true, chainId, events: chainEvents });
      }
      continue;
    }

    // Skip duplicate chained entries (already handled above via group)
    if (chainId && processedChainIds.has(chainId)) {
      continue;
    }

    // Regular (unchained) entry
    const cat = getCategory(entry.type);
    if (!filters[cat]) continue;

    if (cat === 'conversation') {
      convoBatch++;
      lastConvoTimestamp = entry.timestamp;
    } else {
      flushConvoBatch();
      filtered.push(entry);
    }
  }
  flushConvoBatch();

  return (
    <div className="h-full bg-gray-800 border-t border-gray-700 flex flex-col">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-gray-700 shrink-0">
        {(Object.entries(EVENT_CATEGORIES) as [EventCategory, (typeof EVENT_CATEGORIES)[EventCategory]][]).map(
          ([key, { icon, color, label }]) => (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                filters[key] ? '' : 'opacity-40'
              }`}
              style={
                filters[key]
                  ? { color, borderColor: color, backgroundColor: color + '20' }
                  : { borderColor: '#4b5563' }
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
        {filtered.length === 0 ? (
          <p className="text-gray-500 text-xs">No activity yet...</p>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((item, i) => {
              // Conversation summary
              if ('_summary' in item) {
                return (
                  <div key={`summary-${i}`} className="text-[11px] text-gray-500 italic pl-1">
                    🗣️ {item.count} conversation{item.count > 1 ? 's' : ''} ended
                  </div>
                );
              }

              // Chain group
              if ('_chain' in item) {
                const { chainId, events } = item;
                const isExpanded = expandedChains.has(chainId);
                const firstEvent = events[0];
                const consequenceCount = events.length - 1;
                const autoCollapse = events.length >= 3;

                return (
                  <div key={`chain-${chainId}`}>
                    {/* Chain header */}
                    <button
                      onClick={() => toggleChain(chainId)}
                      className="w-full text-left text-[11px] flex gap-1.5 border-l-2 pl-1.5 py-0.5 hover:bg-gray-700/40 transition-colors rounded-r"
                      style={{ borderLeftColor: '#f97316', borderLeftWidth: 2 }}
                    >
                      <span className="shrink-0">⛓</span>
                      <span className="text-gray-500 shrink-0 w-12 text-right">
                        {world
                          ? timeAgo(firstEvent.timestamp, world.time.totalTicks, world.tick_speed)
                          : ''}
                      </span>
                      <span className="text-orange-300 flex-1">
                        {renderMessage(firstEvent)}
                      </span>
                      {consequenceCount > 0 && (
                        <span
                          className="shrink-0 text-[10px] px-1 rounded-full font-semibold"
                          style={{ backgroundColor: '#f9731620', color: '#f97316', border: '1px solid #f9731640' }}
                        >
                          → {consequenceCount} consequence{consequenceCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      <span className="shrink-0 text-gray-500">
                        {(!autoCollapse || isExpanded) && consequenceCount > 0 ? '▲' : consequenceCount > 0 ? '▼' : ''}
                      </span>
                    </button>

                    {/* Expanded chain children */}
                    {(!autoCollapse || isExpanded) && consequenceCount > 0 && (
                      <div className="ml-3 border-l-2 border-orange-900/60 pl-1.5 space-y-0.5 mt-0.5">
                        {events.slice(1).map((child, ci) => (
                          <div
                            key={child.id ?? `chain-child-${chainId}-${ci}`}
                            className="text-[11px] flex gap-1.5 py-0.5"
                          >
                            <span className="shrink-0 text-orange-600/70">↳</span>
                            <span className="text-gray-500 shrink-0 w-12 text-right">
                              {world
                                ? timeAgo(child.timestamp, world.time.totalTicks, world.tick_speed)
                                : ''}
                            </span>
                            <span className="text-gray-400">{renderMessage(child)}</span>
                          </div>
                        ))}
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

              return (
                <div
                  key={item.id ?? `entry-${i}`}
                  className={`text-[11px] flex gap-1.5 border-l-2 pl-1.5 py-0.5 ${
                    isDrama ? 'font-semibold' : ''
                  }`}
                  style={{
                    borderLeftColor: color,
                    borderLeftWidth: isDrama ? 3 : isState ? 2 : 1,
                  }}
                >
                  <span className="shrink-0">{icon}</span>
                  <span className="text-gray-500 shrink-0 w-12 text-right">
                    {world
                      ? timeAgo(item.timestamp, world.time.totalTicks, world.tick_speed)
                      : ''}
                  </span>
                  <span className={isDrama ? 'text-red-300' : 'text-gray-300'}>
                    {renderMessage(item)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
