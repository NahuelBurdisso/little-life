import { useState, useEffect, useCallback, useRef } from "react";
import { trpc } from "./lib/trpc";
import { isWorldReplaced } from "./lib/worldIdentity";
import { SetupWizard } from "./components/setup/SetupWizard";
import { TopBar } from "./components/ui/TopBar";
import { ActivityFeed } from "./components/ui/ActivityFeed";
import { AgentPanel } from "./components/ui/AgentPanel";
import { ConversationPanel } from "./components/ui/ConversationPanel";
import { ResizeHandle } from "./components/ui/ResizeHandle";
import { GameCanvas } from "./components/canvas/GameCanvas";
import { AgentTooltip } from "./components/overlays/AgentTooltip";
import { DramaAlerts } from "./components/overlays/DramaAlerts";
import { NudgeMenu } from "./components/overlays/NudgeMenu";
import { EventMenu } from "./components/ui/EventMenu";
import { TownStats } from "./components/ui/TownStats";
import { Gazette } from "./components/ui/Gazette";
import { useGazette } from "./hooks/useGazette";
import { NewAgentDialog } from "./components/ui/NewAgentDialog";
import { RelationshipGraph } from "./components/ui/RelationshipGraph";
import { ConversationHistory } from "./components/ui/ConversationHistory";
import { useWorldState } from "./hooks/useWorldState";
import { gameMinutes } from "../server/lib/gameClock";
import { useAgents } from "./hooks/useAgents";
import { useConversations } from "./hooks/useConversations";
import { useNudge } from "./hooks/useNudge";
import { useKeyboardControls } from "./hooks/useKeyboardControls";
import { Toasts } from "./components/ui/Toasts";
import { LoadingScreen } from "./components/ui/LoadingScreen";
import { FloatingToolbar } from "./components/ui/FloatingToolbar";
import { AutoplayPanel } from "./components/ui/AutoplayPanel";

export default function App() {
  const { world, events, isLoading: worldLoading } = useWorldState();
  const { agents } = useAgents();
  const { conversations } = useConversations();
  const nudge = useNudge();
  const utils = trpc.useUtils();
  const { data: locations } = trpc.locations.getAll.useQuery();
  const { data: allRelationships } = trpc.relationships.getGraph.useQuery();

  const [setupComplete, setSetupComplete] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null); // string representation of numeric ID
  const [focusNonce, setFocusNonce] = useState(0);
  const [showEventMenu, setShowEventMenu] = useState(false);
  const [showTownStats, setShowTownStats] = useState(false);
  const [showGazette, setShowGazette] = useState(false);
  const gazette = useGazette(showGazette);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showRelGraph, setShowRelGraph] = useState(false);
  const [showConvoHistory, setShowConvoHistory] = useState(false);
  const [showAutoplay, setShowAutoplay] = useState(false);
  const [autoCut, setAutoCut] = useState(false);

  // Reset all UI state when world returns to wizard state (after resetToWizard)
  // `resetToWizard` is the only thing that nulls `setup_config`, so that is what
  // actually distinguishes "no world yet" from a live one. Keying on
  // `totalTicks === 0 && is_paused` instead meant pausing inside the first
  // second of a fresh simulation threw the user back into the wizard on top of
  // a fully seeded world.
  const isNewSimulation = Boolean(world) && world?.setup_config == null;
  useEffect(() => {
    if (isNewSimulation) {
      setSetupComplete(false);
      setSelectedAgentId(null);
      setShowEventMenu(false);
      setShowTownStats(false);
      setShowGazette(false);
      setShowNewAgent(false);
      setShowRelGraph(false);
      setShowConvoHistory(false);
      setShowAutoplay(false);
    }
  }, [isNewSimulation]);

  // Resizable panel sizes
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(300);
  const [bottomHeight, setBottomHeight] = useState(120);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth(w => Math.max(40, Math.min(500, w + delta)));
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightWidth(w => Math.max(40, Math.min(500, w - delta)));
  }, []);
  const handleBottomResize = useCallback((delta: number) => {
    setBottomHeight(h => Math.max(24, Math.min(400, h - delta)));
  }, []);

  // Tooltip state
  const [hoveredAgent, setHoveredAgent] = useState<{ name: string; currentAction: unknown; place: string | null } | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Context menu state
  const [contextMenuAgent, setContextMenuAgent] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  // A world replace (TopBar Restart, a Restart from another tab, a reseed script)
  // is announced on the dirty channels, but those only invalidate the queries
  // each hook is wired to. `locations.getAll` is on no channel at all, so the old
  // town's buildings stayed on the map until a page reload, and every other
  // unwired query kept describing the old world. Agent ids restart at 1, so a
  // selected id silently re-points at a different townsperson — drop it.
  //
  // The clock check can't see a replace of a world still at totalTicks 0
  // (restart while paused at the start), so TopBar also calls
  // `handleWorldReplaced` directly for the replaces this tab asked for.
  const handleWorldReplaced = useCallback(() => {
    setSelectedAgentId(null);
    setContextMenuAgent(null);
    setContextMenuPos(null);
  }, []);
  const totalTicks = world?.time?.totalTicks ?? null;
  const lastTotalTicksRef = useRef<number | null>(null);
  useEffect(() => {
    if (isWorldReplaced(lastTotalTicksRef.current, totalTicks)) {
      utils.invalidate();
      handleWorldReplaced();
    }
    // A momentary null (no world row mid-reset) must not erase the last known
    // clock, or the drop that follows it would go unnoticed.
    if (totalTicks != null) lastTotalTicksRef.current = totalTicks;
  }, [totalTicks, utils, handleWorldReplaced]);

  // Close modals on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenuAgent) {
          setContextMenuAgent(null);
          setContextMenuPos(null);
        } else if (showEventMenu) {
          setShowEventMenu(false);
        } else if (showGazette) {
          setShowGazette(false);
        } else if (showTownStats) {
          setShowTownStats(false);
        } else if (showNewAgent) {
          setShowNewAgent(false);
        } else if (showAutoplay) {
          setShowAutoplay(false);
        } else if (showConvoHistory) {
          // Escape closes the topmost layer, so this chain must match paint
          // order: ConversationHistory is rendered last and covers the graph.
          setShowConvoHistory(false);
        } else if (showRelGraph) {
          setShowRelGraph(false);
        } else if (selectedAgentId) {
          setSelectedAgentId(null);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenuAgent, showEventMenu, showGazette, showTownStats, showNewAgent, showRelGraph, showConvoHistory, showAutoplay, selectedAgentId]);

  // Keyboard controls
  useKeyboardControls({
    // The wizard and loading screen render before the sim exists; Space there
    // would unpause an unseeded world and drop the user into the main UI.
    enabled: Boolean(world) && !worldLoading && !(isNewSimulation && !setupComplete),
    onTogglePause: () => nudge.togglePause(),
    onChangeSpeed: (speed: number) => nudge.changeSpeed(speed),
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
        // The building the agent is in, so "working" can say where.
        const place = locations?.find((l) => l.id === (agent as { current_location?: number | null }).current_location)?.name ?? null;
        setHoveredAgent({ name: agent.name, currentAction: agent.current_action, place });
        setHoverPos(pos);
      }
    },
    [agents, locations]
  );

  // Select an agent AND re-center on them, even if they were already selected.
  const focusAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setFocusNonce(n => n + 1);
  }, []);

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

  // Show setup wizard if simulation hasn't started
  if (isNewSimulation && !setupComplete) {
    return <SetupWizard onStart={() => {
      utils.invalidate(); // refetch all queries after seed
      setSetupComplete(true);
    }} />;
  }

  if (worldLoading || !world) {
    return <LoadingScreen />;
  }

  return (
    <div className="h-screen w-screen bg-ui-deep text-ui-text flex flex-col overflow-hidden">
      <TopBar
        world={world}
        events={events ?? []}
        liveConversations={conversations?.length ?? 0}
        awakeAgents={agents.filter((a) => {
          const t = (a as { current_action?: { type?: string } }).current_action?.type;
          return t !== 'sleeping' && t !== 'dead';
        }).length}
        onShowEvents={() => setShowEventMenu(true)}
        onShowStats={() => setShowTownStats(true)}
        onShowGazette={() => setShowGazette(true)}
        hasNewGazette={gazette.hasNew}
        onWorldReplaced={handleWorldReplaced}
      />
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Conversations sidebar */}
        <div style={{ width: leftWidth }} className="flex-shrink-0 overflow-hidden">
          <ConversationPanel onSelectAgent={focusAgent} />
        </div>
        <ResizeHandle direction="horizontal" onResize={handleLeftResize} />
        {/* PixiJS game canvas */}
        <GameCanvas
          agents={agents}
          world={world}
          events={events}
          conversations={conversations ?? []}
          locations={locations ?? []}
          relationships={allRelationships ?? []}
          onAgentSelect={setSelectedAgentId}
          onAgentContextMenu={handleAgentContextMenu}
          onAgentHover={handleAgentHover}
          selectedAgentId={selectedAgentId}
          focusNonce={focusNonce}
        />
        {/* AgentPanel sidebar */}
        {selectedAgentId && (
          <>
            <ResizeHandle direction="horizontal" onResize={handleRightResize} />
            <div style={{ width: rightWidth }} className="flex-shrink-0 overflow-hidden">
              <AgentPanel
                agentId={selectedAgentId}
                onClose={() => setSelectedAgentId(null)}
                onSelectAgent={focusAgent}
              />
            </div>
          </>
        )}
      </div>
      <ResizeHandle direction="vertical" onResize={handleBottomResize} />
      <div style={{ height: bottomHeight }} className="flex-shrink-0 overflow-hidden">
        <ActivityFeed onSelectAgent={focusAgent} />
      </div>

      {/* Floating toolbar for extra actions */}
      <FloatingToolbar
        onNewAgent={() => setShowNewAgent(true)}
        onShowRelationships={() => setShowRelGraph(true)}
        onShowHistory={() => setShowConvoHistory(true)}
        onShowAutoplay={() => setShowAutoplay(true)}
        autoCut={autoCut}
        onToggleAutoCut={() => setAutoCut(v => !v)}
        rightOffset={selectedAgentId ? rightWidth + 16 : 16}
      />

      {/* Acknowledgements for player actions (lib/toast.ts) */}
      <Toasts />

      {/* Drama alerts + optional camera auto-cut */}
      <DramaAlerts autoFollow={autoCut} onFocusAgent={focusAgent} />

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
        nowMinutes={world?.time ? gameMinutes(world.time) : null}
      />
      <Gazette
        isOpen={showGazette}
        onClose={() => setShowGazette(false)}
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
        onSelectAgent={(id) => {
          setSelectedAgentId(id);
          setShowRelGraph(false);
        }}
      />
      <ConversationHistory
        isOpen={showConvoHistory}
        onClose={() => setShowConvoHistory(false)}
        onSelectAgent={(id) => {
          // Close first: the history modal covers the map, so the camera move
          // would otherwise happen behind it.
          setShowConvoHistory(false);
          focusAgent(id);
        }}
      />
      <AutoplayPanel isOpen={showAutoplay} onClose={() => setShowAutoplay(false)} />

      {/* Attribution */}
      <div className="fixed bottom-1 left-1 z-10 text-[8px] text-ui-muted opacity-40 pointer-events-none">
        Art: LimeZu (CC-BY 4.0)
      </div>
    </div>
  );
}
