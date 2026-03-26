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
} as const;

type EventCategory = keyof typeof EVENT_CATEGORIES;

function getCategory(type: string): EventCategory {
  if (type === 'conversation_ended') return 'conversation';
  if (type === 'economy') return 'economy';
  if (type === 'state_change') return 'state_change';
  if (type === 'relationship' || type === 'relationship_status_change') return 'relationship';
  if (type === 'drama' || type === 'theft_caught' || type === 'affair_discovery') return 'drama';
  if (type === 'world_event') return 'world_event';
  return 'system';
}

// --- Component ---

interface ActivityEntry {
  id?: number;
  type: string;
  message: string;
  timestamp: number;
  real_timestamp?: number;
  agent_ids?: number[];
}

export function ActivityFeed() {
  const { activities } = useActivityFeed();
  const { world } = useWorldState();
  const [collapsed, setCollapsed] = useState(false);
  const [filters, setFilters] = useState<Record<EventCategory, boolean>>({
    conversation: true,
    economy: true,
    drama: true,
    state_change: true,
    relationship: true,
    world_event: true,
    system: true,
  });

  const toggleFilter = (cat: EventCategory) => {
    setFilters(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  // Filter activities
  const filtered = (activities as ActivityEntry[]).filter(a => filters[getCategory(a.type)]);

  // Collapse consecutive conversations into summaries
  type DisplayItem = ActivityEntry | { _summary: true; count: number; timestamp: number };
  const displayItems: DisplayItem[] = [];
  let convoBatch = 0;
  let lastConvoTimestamp = 0;

  for (const entry of filtered) {
    const cat = getCategory(entry.type);
    if (cat === 'conversation') {
      convoBatch++;
      lastConvoTimestamp = entry.timestamp;
    } else {
      if (convoBatch > 0) {
        displayItems.push({ _summary: true, count: convoBatch, timestamp: lastConvoTimestamp });
        convoBatch = 0;
      }
      displayItems.push(entry);
    }
  }
  if (convoBatch > 0) {
    displayItems.push({ _summary: true, count: convoBatch, timestamp: lastConvoTimestamp });
  }

  if (collapsed) {
    return (
      <div
        className="h-6 bg-gray-800 border-t border-gray-700 flex items-center px-2 cursor-pointer hover:bg-gray-750 transition-colors shrink-0"
        onClick={() => setCollapsed(false)}
        title="Show activity feed"
      >
        <span className="text-[10px] text-gray-400">▲ Activity Feed</span>
      </div>
    );
  }

  return (
    <div className="h-[120px] bg-gray-800 border-t border-gray-700 flex flex-col shrink-0">
      {/* Filter bar */}
      <div className="flex gap-1 px-2 py-1 border-b border-gray-700 shrink-0">
        <button
          onClick={() => setCollapsed(true)}
          className="text-gray-500 hover:text-gray-300 text-[10px] mr-1 transition-colors"
          title="Minimize feed"
        >
          ▼
        </button>
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
        {displayItems.length === 0 ? (
          <p className="text-gray-500 text-xs">No activity yet...</p>
        ) : (
          <div className="space-y-0.5">
            {displayItems.map((item, i) => {
              if ('_summary' in item) {
                return (
                  <div key={`summary-${i}`} className="text-[11px] text-gray-500 italic pl-1">
                    🗣️ {item.count} conversation{item.count > 1 ? 's' : ''} ended
                  </div>
                );
              }

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
                    {item.message}
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
