import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { TopBar } from "./components/ui/TopBar";
import { ActivityFeed } from "./components/ui/ActivityFeed";
import { useWorldState } from "./hooks/useWorldState";
import { useAgents } from "./hooks/useAgents";
import { useNudge } from "./hooks/useNudge";
import { useKeyboardControls } from "./hooks/useKeyboardControls";

export default function App() {
  const { world, events, isLoading: worldLoading } = useWorldState();
  const { agents } = useAgents();
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
        {/* Canvas area - placeholder for now, Task 19 adds PixiJS */}
        <div className="flex-1 bg-gray-800 flex items-center justify-center relative">
          <p className="text-gray-500">Canvas loads here (Task 19)</p>
          {/* Agent count for debugging/interaction before canvas exists */}
          <div className="absolute bottom-4 left-4 text-xs text-gray-400">
            {agents.length} agents active
          </div>
        </div>
        {/* AgentPanel sidebar - placeholder, Task 21 */}
        {selectedAgentId && (
          <div className="w-[300px] bg-gray-850 border-l border-gray-700 p-4">
            <button
              onClick={() => setSelectedAgentId(null)}
              className="text-gray-400 hover:text-white float-right"
            >
              ✕
            </button>
            <p className="text-sm text-gray-400">Agent Panel (Task 21)</p>
          </div>
        )}
      </div>
      <ActivityFeed />
    </div>
  );
}
