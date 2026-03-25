import { useState, useEffect, useCallback } from "react";
import { trpc } from "./lib/trpc";
import { TopBar } from "./components/ui/TopBar";
import { ActivityFeed } from "./components/ui/ActivityFeed";
import { AgentPanel } from "./components/ui/AgentPanel";
import { GameCanvas } from "./components/canvas/GameCanvas";
import { AgentTooltip } from "./components/overlays/AgentTooltip";
import { NudgeMenu } from "./components/overlays/NudgeMenu";
import { EventMenu } from "./components/ui/EventMenu";
import { TownStats } from "./components/ui/TownStats";
import { NewAgentDialog } from "./components/ui/NewAgentDialog";
import { RelationshipGraph } from "./components/ui/RelationshipGraph";
import { useWorldState } from "./hooks/useWorldState";
import { useAgents } from "./hooks/useAgents";
import { useConversations } from "./hooks/useConversations";
import { useNudge } from "./hooks/useNudge";
import { useKeyboardControls } from "./hooks/useKeyboardControls";

export default function App() {
  const { world, events, isLoading: worldLoading } = useWorldState();
  const { agents } = useAgents();
  const { conversations } = useConversations();
  const nudge = useNudge();
  const { data: locations } = trpc.locations.getAll.useQuery();
  const { data: allRelationships } = trpc.relationships.getGraph.useQuery();

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null); // string representation of numeric ID
  const [showEventMenu, setShowEventMenu] = useState(false);
  const [showTownStats, setShowTownStats] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showRelGraph, setShowRelGraph] = useState(false);

  // Tooltip state
  const [hoveredAgent, setHoveredAgent] = useState<{ name: string; currentAction: { type?: string } | string | null } | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Context menu state
  const [contextMenuAgent, setContextMenuAgent] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Close modals on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenuAgent) {
          setContextMenuAgent(null);
          setContextMenuPos(null);
        } else if (showEventMenu) {
          setShowEventMenu(false);
        } else if (showTownStats) {
          setShowTownStats(false);
        } else if (showNewAgent) {
          setShowNewAgent(false);
        } else if (showRelGraph) {
          setShowRelGraph(false);
        } else if (selectedAgentId) {
          setSelectedAgentId(null);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenuAgent, showEventMenu, showTownStats, showNewAgent, showRelGraph, selectedAgentId]);

  // Keyboard controls
  useKeyboardControls({
    onTogglePause: () => nudge.togglePause(),
    onChangeSpeed: (speed: number) => nudge.changeSpeed(speed),
    onDeselect: () => setSelectedAgentId(null),
  });

  // Canvas callbacks
  const handleAgentHover = useCallback(
    (agentId: string | null, pos?: { x: number; y: number }) => {
      if (!agentId || !pos) {
        setHoveredAgent(null);
        setHoverPos(null);
        return;
      }
      const agent = agents.find((a) => String(a.id) === agentId);
      if (agent) {
        setHoveredAgent({ name: agent.name, currentAction: agent.current_action });
        setHoverPos(pos);
      }
    },
    [agents]
  );

  const handleAgentContextMenu = useCallback(
    (agentId: string, pos: { x: number; y: number }) => {
      setContextMenuAgent(agentId);
      setContextMenuPos(pos);
      // Clear tooltip when context menu opens
      setHoveredAgent(null);
      setHoverPos(null);
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuAgent(null);
    setContextMenuPos(null);
  }, []);

  if (worldLoading || !world) {
    return (
      <div className="h-screen w-screen bg-gray-900 text-white flex flex-col items-center justify-center gap-4">
        <p className="text-lg">Loading Little Life...</p>
        <p className="text-sm text-gray-500">
          Connecting to server...
        </p>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-gray-900 text-white flex flex-col overflow-hidden">
      <TopBar
        world={world}
        events={events ?? []}
        onShowEvents={() => setShowEventMenu(true)}
        onShowStats={() => setShowTownStats(true)}
      />
      <div className="flex-1 flex overflow-hidden">
        {/* PixiJS game canvas */}
        <GameCanvas
          agents={agents}
          world={world}
          conversations={conversations ?? []}
          locations={locations ?? []}
          relationships={allRelationships ?? []}
          onAgentSelect={setSelectedAgentId}
          onAgentContextMenu={handleAgentContextMenu}
          onAgentHover={handleAgentHover}
          selectedAgentId={selectedAgentId}
        />
        {/* AgentPanel sidebar */}
        {selectedAgentId && (
          <AgentPanel
            agentId={selectedAgentId}
            onClose={() => setSelectedAgentId(null)}
          />
        )}
      </div>
      <ActivityFeed />

      {/* Floating toolbar for extra actions */}
      <div className="fixed bottom-16 right-4 z-30 flex flex-col gap-2">
        <button
          onClick={() => setShowNewAgent(true)}
          className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg shadow transition-colors"
          title="Add new agent"
        >
          ➕ New Resident
        </button>
        <button
          onClick={() => setShowRelGraph(true)}
          className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg shadow transition-colors"
          title="View relationships"
        >
          🔗 Relationships
        </button>
      </div>

      {/* Tooltip overlay */}
      <AgentTooltip agent={hoveredAgent} position={hoverPos} />

      {/* Context menu */}
      {contextMenuAgent && contextMenuPos && (
        <NudgeMenu
          agentId={contextMenuAgent}
          selectedAgentId={selectedAgentId}
          position={contextMenuPos}
          agents={agents}
          locations={locations ?? []}
          onClose={handleCloseContextMenu}
          onSelectAgent={(id) => {
            setSelectedAgentId(id);
            handleCloseContextMenu();
          }}
        />
      )}

      {/* Modals */}
      <EventMenu
        isOpen={showEventMenu}
        onClose={() => setShowEventMenu(false)}
        activeEvents={events ?? []}
      />
      <TownStats
        isOpen={showTownStats}
        onClose={() => setShowTownStats(false)}
      />
      <NewAgentDialog
        isOpen={showNewAgent}
        onClose={() => setShowNewAgent(false)}
      />
      <RelationshipGraph
        isOpen={showRelGraph}
        onClose={() => setShowRelGraph(false)}
      />

      {/* Attribution */}
      <div className="fixed bottom-1 left-1 z-10 text-[8px] text-gray-500 opacity-40 pointer-events-none">
        Art: LimeZu (CC-BY 4.0)
      </div>
    </div>
  );
}
