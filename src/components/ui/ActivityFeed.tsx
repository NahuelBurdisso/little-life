import { useState } from "react";
import { useActivityFeed } from "../../hooks/useActivityFeed";
import { useWorldState } from "../../hooks/useWorldState";
import { timeAgo } from "../../lib/formatters";

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
  if (type === 'relationship' || type === 'relationship_status_change') return 'relationship';
  if (type === 'drama' || type === 'theft_caught' || type === 'affair_discovery' || type === 'interaction_resolved') return 'drama';
  if (type === 'world_event') return 'world_event';
  if (type === 'goal_ambition_shifted' || type === 'goal_ambition_generated' || type.startsWith('aspiration')) return 'aspiration';
  if (type.startsWith('goal_')) return 'goal';
  if (type === 'plan_generated' || type === 'plan_changed') return 'planning';
  if (type === 'error') return 'error';
  return 'system';
}

// --- Helpers ---

function renderMessage(entry: ActivityEntry): string {
  const d = entry.template_data ?? {};
  if (d.description) return String(d.description);
  if (d.message) return String(d.message);

  // Goals
  if (entry.type === 'goal_created' && d.name && d.goal) return `${d.name} set a new goal: ${d.goal}`;
  if (entry.type === 'goal_completed' && (d.agent || d.name)) return `${d.agent ?? d.name} accomplished: ${d.goal_description ?? d.goal ?? 'a goal'}`;
  if (entry.type === 'goal_abandoned' && (d.agent || d.name)) return `${d.agent ?? d.name} gave up on: ${d.goal_description ?? d.goal ?? 'a goal'}`;

  // Aspirations
  if (entry.type === 'goal_ambition_shifted' && d.name) return `${d.name} had a change of heart — now driven by ${d.to}`;
  if (entry.type === 'goal_ambition_generated' && d.name) return `${d.name} discovered their life ambition: ${d.ambition}`;

  // Plans
  if (entry.type === 'plan_generated' && d.agentName) return `${d.agentName} planned their day.`;
  if (entry.type === 'plan_changed' && d.agentName) return `${d.agentName} changed plans${d.reason ? ': ' + String(d.reason).substring(0, 80) + '.' : '.'}`;

  // States
  if (d.agent && d.state) {
    if (entry.type === 'state_gained') return `${d.agent} became ${d.state}.`;
    if (entry.type === 'state_lost') return `${d.agent} is no longer ${d.state}.`;
  }

  // Relationships
  if (d.agent1 && d.agent2 && d.status) return `${d.agent1} and ${d.agent2} are now ${d.status}.`;
  if (d.agent1 && d.agent2 && d.location !== undefined) return `${d.agent1} and ${d.agent2} finished talking.`;

  // Economy
  if (d.agent && d.amount && d.item) return `${d.agent} bought ${d.item} for $${d.amount}.`;
  if (d.agent && d.amount) return `${d.agent} earned $${d.amount}.`;

  // Interactions
  if (d.initiator_name && d.verb && d.target_name) return `${d.initiator_name} ${d.verb} ${d.target_name}${d.location ? ' at ' + d.location : ''}`;

  // Errors
  if (entry.type === 'error' && d.system) return `[${d.system}] ${d.message ?? 'unknown error'}`;

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
    goal: true,
    aspiration: true,
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
    <div className="h-full bg-[#1a1814] border-t border-[#3a3028] flex flex-col">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-[#3a3028] shrink-0">
        {(Object.entries(EVENT_CATEGORIES) as [EventCategory, (typeof EVENT_CATEGORIES)[EventCategory]][]).map(
          ([key, { icon, color, label }]) => (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
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
        {filtered.length === 0 ? (
          <p className="text-[#504838] text-xs">No activity yet...</p>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((item, i) => {
              // Conversation summary
              if ('_summary' in item) {
                return (
                  <div key={`summary-${i}`} className="text-[11px] text-[#504838] italic pl-1">
                    💬 {item.count} conversation{item.count > 1 ? 's' : ''} ended
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
                      className="w-full text-left text-[11px] flex gap-1.5 border-l-2 pl-1.5 py-0.5 hover:bg-[#2e2b20] transition-colors"
                      style={{ borderLeftColor: '#c07840', borderLeftWidth: 2 }}
                    >
                      <span className="shrink-0">⛓</span>
                      <span className="text-[#504838] shrink-0 w-12 text-right">
                        {world
                          ? timeAgo(firstEvent.timestamp, world.time.totalTicks, world.tick_speed)
                          : ''}
                      </span>
                      <span className="text-[#c07840] flex-1">
                        {renderMessage(firstEvent)}
                      </span>
                      {consequenceCount > 0 && (
                        <span
                          className="shrink-0 text-[10px] px-1 font-semibold"
                          style={{ backgroundColor: '#c0784020', color: '#c07840', border: '1px solid #c0784040' }}
                        >
                          → {consequenceCount} consequence{consequenceCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      <span className="shrink-0 text-[#504838]">
                        {(!autoCollapse || isExpanded) && consequenceCount > 0 ? '▲' : consequenceCount > 0 ? '▼' : ''}
                      </span>
                    </button>

                    {/* Expanded chain children */}
                    {(!autoCollapse || isExpanded) && consequenceCount > 0 && (
                      <div className="ml-3 border-l-2 border-[#6b5c30] pl-1.5 space-y-0.5 mt-0.5">
                        {events.slice(1).map((child, ci) => (
                          <div
                            key={child.id ?? `chain-child-${chainId}-${ci}`}
                            className="text-[11px] flex gap-1.5 py-0.5"
                          >
                            <span className="shrink-0 text-[#c07840]">↳</span>
                            <span className="text-[#504838] shrink-0 w-12 text-right">
                              {world
                                ? timeAgo(child.timestamp, world.time.totalTicks, world.tick_speed)
                                : ''}
                            </span>
                            <span className="text-[#8a7f65]">{renderMessage(child)}</span>
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
              const isGoal = cat === 'goal';
              const isAspiration = cat === 'aspiration';
              const isError = cat === 'error';
              const isBold = isDrama || isAspiration;

              return (
                <div
                  key={item.id ?? `entry-${i}`}
                  className={`text-[11px] flex gap-1.5 border-l-2 pl-1.5 py-0.5 ${
                    isBold ? 'font-semibold' : ''
                  }`}
                  style={{
                    borderLeftColor: color,
                    borderLeftWidth: isDrama || isAspiration ? 3 : isState || isGoal ? 2 : 1,
                  }}
                >
                  <span className="shrink-0">{icon}</span>
                  <span className="text-[#504838] shrink-0 w-12 text-right">
                    {world
                      ? timeAgo(item.timestamp, world.time.totalTicks, world.tick_speed)
                      : ''}
                  </span>
                  <span className={
                    isDrama ? 'text-[#a03028]' :
                    isAspiration ? 'text-[#9b7ab0]' :
                    isGoal ? 'text-[#c07840]' :
                    isError ? 'text-[#a03028]' :
                    'text-[#a09070]'
                  }>
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
