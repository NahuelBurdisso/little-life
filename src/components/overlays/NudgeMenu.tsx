import { useState, useEffect, useRef } from "react";
import { useNudge } from "../../hooks/useNudge";
import { trpc } from "../../lib/trpc";

interface NudgeMenuProps {
  agentId: string;
  selectedAgentId: string | null;
  position: { x: number; y: number };
  agents: any[];
  locations: any[];
  onClose: () => void;
  onSelectAgent: (id: string) => void;
}

type SubMenu = "talk" | "goto" | "money" | "topic" | "secret" | null;

export function NudgeMenu({
  agentId,
  selectedAgentId,
  position,
  agents,
  locations,
  onClose,
  onSelectAgent,
}: NudgeMenuProps) {
  const { suggestTalk, suggestGoTo, giveMoney, removeAgent, tellSecret, forceConfront } = useNudge();
  const [subMenu, setSubMenu] = useState<SubMenu>(null);
  const [topicText, setTopicText] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentAgent = agents.find((a: any) => String(a.id) === agentId);
  const otherAgents = agents.filter((a: any) => String(a.id) !== agentId);
  const isPairMode = selectedAgentId !== null && selectedAgentId !== agentId;

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (subMenu) setSubMenu(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, subMenu]);

  // Only the secret picker needs this, and it is a full-table scan server-side.
  const { data: knownFacts } = trpc.knowledge.getKnownBy.useQuery(
    { agentId: Number(agentId) },
    { enabled: subMenu === "secret" },
  );

  // A secret the listener already knows is not a reveal, so drop those.
  const tellableSecrets = (knownFacts ?? [])
    .filter(
      (f: any) =>
        f.sensitivity >= 2 && !(f.known_by as number[]).includes(Number(selectedAgentId)),
    )
    .sort((a: any, b: any) => b.sensitivity - a.sensitivity)
    .slice(0, 8);

  // Clamp position to viewport
  const left = Math.min(position.x, window.innerWidth - 220);
  const top = Math.min(position.y, window.innerHeight - 300);

  const menuItemClass =
    "w-full text-left px-3 py-1.5 text-xs hover:bg-gray-600 transition-colors rounded";

  if (isPairMode) {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[180px]"
        style={{ left, top }}
      >
        <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wider">
          {currentAgent?.name ?? "Agent"} + {agents.find((a: any) => String(a.id) === selectedAgentId)?.name ?? "Agent"}
        </div>
        {subMenu === "topic" ? (
          <div className="px-3 py-1.5">
            <input
              autoFocus
              type="text"
              placeholder="Enter topic..."
              value={topicText}
              onChange={(e) => setTopicText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && topicText.trim()) {
                  suggestTalk(agentId, selectedAgentId!, topicText.trim());
                  onClose();
                }
              }}
              className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
            />
            <button
              onClick={() => {
                if (topicText.trim()) {
                  suggestTalk(agentId, selectedAgentId!, topicText.trim());
                  onClose();
                }
              }}
              className="mt-1 w-full text-center px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded"
            >
              Send
            </button>
          </div>
        ) : subMenu === "secret" ? (
          <div className="max-h-48 overflow-y-auto">
            <button
              className="w-full text-left px-3 py-1 text-[10px] text-gray-500"
              onClick={() => setSubMenu(null)}
            >
              ← Back
            </button>
            {tellableSecrets.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-gray-500">
                {currentAgent?.name ?? "They"} knows no secrets the other doesn't.
              </p>
            ) : (
              tellableSecrets.map((f: any) => (
                <button
                  key={f.id}
                  className={menuItemClass}
                  title={f.content}
                  onClick={() => {
                    tellSecret(agentId, selectedAgentId!, f.id);
                    onClose();
                  }}
                >
                  🤫 {f.content}
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            <button
              className={menuItemClass}
              onClick={() => {
                suggestTalk(agentId, selectedAgentId!);
                onClose();
              }}
            >
              💬 Suggest they chat
            </button>
            <button className={menuItemClass} onClick={() => setSubMenu("topic")}>
              📝 Suggest topic...
            </button>
            <button className={menuItemClass} onClick={() => setSubMenu("secret")}>
              🤫 Tell a secret...
            </button>
            <button
              className={menuItemClass}
              onClick={() => {
                forceConfront(agentId, selectedAgentId!);
                onClose();
              }}
            >
              ⚔️ Force confrontation
            </button>
            <button
              className={menuItemClass}
              onClick={() => {
                onSelectAgent(agentId);
                onClose();
              }}
            >
              👁️ View relationship
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left, top }}
    >
      <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wider">
        {currentAgent?.name ?? "Agent"}
      </div>

      {subMenu === "talk" && (
        <div className="max-h-40 overflow-y-auto">
          <button className="w-full text-left px-3 py-1 text-[10px] text-gray-500" onClick={() => setSubMenu(null)}>
            ← Back
          </button>
          {otherAgents.map((a: any) => (
            <button
              key={String(a.id)}
              className={menuItemClass}
              onClick={() => {
                suggestTalk(agentId, String(a.id));
                onClose();
              }}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}

      {subMenu === "goto" && (
        <div className="max-h-40 overflow-y-auto">
          <button className="w-full text-left px-3 py-1 text-[10px] text-gray-500" onClick={() => setSubMenu(null)}>
            ← Back
          </button>
          {locations.map((loc: any) => (
            <button
              key={String(loc.id)}
              className={menuItemClass}
              onClick={() => {
                suggestGoTo(agentId, String(loc.id));
                onClose();
              }}
            >
              {loc.name}
            </button>
          ))}
        </div>
      )}

      {subMenu === "money" && (
        <div>
          <button className="w-full text-left px-3 py-1 text-[10px] text-gray-500" onClick={() => setSubMenu(null)}>
            ← Back
          </button>
          {[10, 25, 50, 100].map((amount) => (
            <button
              key={amount}
              className={menuItemClass}
              onClick={() => {
                giveMoney(agentId, amount);
                onClose();
              }}
            >
              💰 {amount} coins
            </button>
          ))}
        </div>
      )}

      {subMenu === null && !confirmRemove && (
        <>
          <button className={menuItemClass} onClick={() => setSubMenu("talk")}>
            💬 Suggest talk to...
          </button>
          <button className={menuItemClass} onClick={() => setSubMenu("goto")}>
            🚶 Suggest go to...
          </button>
          <button className={menuItemClass} onClick={() => setSubMenu("money")}>
            💰 Give money
          </button>
          <button
            className={menuItemClass}
            onClick={() => {
              onSelectAgent(agentId);
              onClose();
            }}
          >
            👁️ View memories
          </button>
          <div className="border-t border-gray-700 my-1" />
          <p className="px-3 py-1 text-[10px] text-gray-500 leading-tight">
            Select an agent, then right-click another for secrets and confrontations.
          </p>
          <button
            className={`${menuItemClass} text-red-400 hover:bg-red-900/30`}
            onClick={() => setConfirmRemove(true)}
          >
            ❌ Remove from town
          </button>
        </>
      )}

      {confirmRemove && (
        <div className="px-3 py-2">
          <p className="text-xs text-gray-300 mb-2">Remove {currentAgent?.name}?</p>
          <div className="flex gap-2">
            <button
              className="flex-1 px-2 py-1 text-xs bg-red-600 hover:bg-red-500 rounded"
              onClick={() => {
                removeAgent(agentId);
                onClose();
              }}
            >
              Confirm
            </button>
            <button
              className="flex-1 px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 rounded"
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
