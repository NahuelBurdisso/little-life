import { useEffect, useRef, useCallback } from "react";
import { trpc } from "../../lib/trpc";
import { useAgents } from "../../hooks/useAgents";

interface RelationshipGraphProps {
  isOpen: boolean;
  onClose: () => void;
}

interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  source: string;
  target: string;
  friendship: number;
  romance: number;
}

export function RelationshipGraph({ isOpen, onClose }: RelationshipGraphProps) {
  const { agents } = useAgents();
  const { data: relationships } = trpc.relationships.getGraph.useQuery();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const initializedRef = useRef(false);

  // Build graph data when agents/relationships change
  const buildGraph = useCallback(() => {
    if (!agents.length) return;

    const CX = 300;
    const CY = 250;
    const R = 150;

    // Only reinitialize positions if agents changed
    const existingIds = new Set(nodesRef.current.map((n) => n.id));
    const agentIds = new Set(agents.map((a: any) => a._id));

    if (!initializedRef.current || existingIds.size !== agentIds.size) {
      nodesRef.current = agents.map((a: any, i: number) => {
        const angle = (2 * Math.PI * i) / agents.length;
        return {
          id: a._id,
          label: a.name,
          x: CX + R * Math.cos(angle),
          y: CY + R * Math.sin(angle),
          vx: 0,
          vy: 0,
        };
      });
      initializedRef.current = true;
    }

    edgesRef.current = (relationships ?? []).map((r: any) => ({
      source: r.agentA,
      target: r.agentB,
      friendship: Math.max(r.friendshipAB ?? 0, r.friendshipBA ?? 0),
      romance: Math.max(r.romanceAB ?? 0, r.romanceBA ?? 0),
    }));
  }, [agents, relationships]);

  useEffect(() => {
    if (!isOpen) {
      initializedRef.current = false;
      return;
    }

    buildGraph();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    const tick = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;

      // Force simulation step
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = 2000 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      // Attraction along edges
      for (const edge of edges) {
        const a = nodeMap.get(edge.source);
        const b = nodeMap.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const strength = Math.abs(edge.friendship) / 100;
        const force = (dist - 120) * 0.01 * (0.5 + strength);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      // Center gravity
      for (const node of nodes) {
        node.vx += (W / 2 - node.x) * 0.002;
        node.vy += (H / 2 - node.y) * 0.002;
      }

      // Apply velocity with damping
      for (const node of nodes) {
        node.vx *= 0.85;
        node.vy *= 0.85;
        node.x += node.vx;
        node.y += node.vy;
        // Clamp
        node.x = Math.max(40, Math.min(W - 40, node.x));
        node.y = Math.max(40, Math.min(H - 40, node.y));
      }

      // Draw
      ctx.clearRect(0, 0, W, H);

      // Edges
      for (const edge of edges) {
        const a = nodeMap.get(edge.source);
        const b = nodeMap.get(edge.target);
        if (!a || !b) continue;

        let color: string;
        let width: number;

        if (edge.romance > 30) {
          color = "#f472b6"; // pink
          width = Math.max(1, edge.romance / 25);
        } else if (edge.friendship > 30) {
          color = "#22c55e"; // green
          width = Math.max(1, edge.friendship / 25);
        } else if (edge.friendship < -30) {
          color = "#ef4444"; // red
          width = Math.max(1, Math.abs(edge.friendship) / 25);
        } else {
          color = "#4b5563"; // gray
          width = 0.5;
        }

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      }

      // Nodes
      for (const node of nodes) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 14, 0, 2 * Math.PI);
        ctx.fillStyle = "#1f2937";
        ctx.fill();
        ctx.strokeStyle = "#60a5fa";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(node.label, node.x, node.y);
      }

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [isOpen, buildGraph]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[640px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-sm font-bold text-white">Relationship Graph</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
            &times;
          </button>
        </div>
        <div className="p-2">
          <canvas
            ref={canvasRef}
            width={600}
            height={500}
            className="w-full rounded bg-gray-900"
          />
        </div>
        {/* Legend */}
        <div className="flex items-center justify-center gap-4 px-5 py-2 border-t border-gray-700 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-green-500" /> Friendship
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-pink-400" /> Romance
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-red-500" /> Rivalry
          </span>
        </div>
      </div>
    </div>
  );
}
