import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { TopBar } from "./components/ui/TopBar";
import { ActivityFeed } from "./components/ui/ActivityFeed";
import { AgentPanel } from "./components/ui/AgentPanel";
import { GameCanvas } from "./components/canvas/GameCanvas";
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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showEventMenu, setShowEventMenu] = useState(false);
  const [showTownStats, setShowTownStats] = useState(false);

  // Initialize world on first load
  const initialize = useMutation(api.init.initialize.initialize);
  useEffect(() => {
    if (!worldLoading && !world) {
      initialize({});
    }
  }, [worldLoading, world, initialize]);

  // Keyboard controls
  useKeyboardControls({
    onTogglePause: () => nudge.togglePause(),
    onChangeSpeed: (speed: number) => nudge.changeSpeed(speed),
    onDeselect: () => setSelectedAgentId(null),
  });

  if (worldLoading || !world) {
    return (
      <div className="h-screen w-screen bg-gray-900 text-white flex items-center justify-center">
        <p className="text-lg">Loading Little Life...</p>
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
          onAgentSelect={setSelectedAgentId}
          onAgentContextMenu={(_id, _pos) => { /* Task 22 */ }}
          onAgentHover={(_id, _pos) => { /* Task 22 */ }}
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
    </div>
  );
}
