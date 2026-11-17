import { useEffect, useRef, useCallback, useState } from "react";
import { trpc } from "../../lib/trpc";
import { useAgents } from "../../hooks/useAgents";
import { EmptyState } from "./EmptyState";
import { topState, stateCss } from "../../lib/stateStyle";

interface RelationshipGraphProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectAgent?: (agentId: string) => void;
  /** Clicking an edge opens the pair dossier for its two residents. */
  onViewPair?: (a: string, b: string) => void;
}

interface GraphNode {
  id: string;
  label: string;
  job: string;
  mood: number;
  states: string[];
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
  friendshipAB: number;
  friendshipBA: number;
  romanceAB: number;
  romanceBA: number;
  trustAB: number;
  trustBA: number;
  status: string;
  tags: string[];
  interactionCount: number;
}

type FilterMode = "all" | "friends" | "romance" | "rivals" | "drama";

// --- Color helpers ---

function agentColorHex(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const s = 60, l = 50;
  return `hsl(${hue}, ${s}%, ${l}%)`;
}

/** One table for the canvas and the legend below it, so they can't drift apart. */
const EDGE_COLORS = {
  grudge: '#991b1b',
  rivalry: '#ef4444',
  romance: '#f472b6',
  friendship: '#22c55e',
  neutral: '#4a4535',
} as const;

function getEdgeColor(edge: GraphEdge): string {
  if (edge.tags.includes('grudge')) return EDGE_COLORS.grudge;
  if (edge.status === 'rivals' || edge.status === 'enemies') return EDGE_COLORS.rivalry;
  if (edge.status === 'partners' || edge.romanceAB > 30 || edge.romanceBA > 30) return EDGE_COLORS.romance;
  const avgFriendship = (edge.friendshipAB + edge.friendshipBA) / 2;
  if (avgFriendship > 30) return EDGE_COLORS.friendship;
  if (avgFriendship < -30) return EDGE_COLORS.rivalry;
  return EDGE_COLORS.neutral;
}

function getEdgeWidth(edge: GraphEdge): number {
  const strength = Math.max(
    Math.abs(edge.friendshipAB), Math.abs(edge.friendshipBA),
    Math.abs(edge.romanceAB), Math.abs(edge.romanceBA),
  );
  return Math.max(0.5, strength / 25);
}

/** Stable identity for an edge. `edgesRef` is rebuilt from scratch whenever the
 *  relationship query refetches, so object identity is not usable for "is this
 *  the edge the cursor is on". */
function edgeKey(edge: GraphEdge): string {
  return `${edge.source}|${edge.target}`;
}

function passesFilter(edge: GraphEdge, filter: FilterMode): boolean {
  if (filter === 'all') return true;
  const avgF = (edge.friendshipAB + edge.friendshipBA) / 2;
  const maxR = Math.max(edge.romanceAB, edge.romanceBA);
  if (filter === 'friends') return avgF > 20;
  if (filter === 'romance') return maxR > 15;
  if (filter === 'rivals') return avgF < -20 || edge.tags.includes('grudge') || edge.status === 'rivals' || edge.status === 'enemies';
  if (filter === 'drama') return edge.tags.includes('grudge') || edge.status === 'partners' || edge.status === 'rivals' || edge.status === 'enemies' || maxR > 40 || avgF < -40;
  return true;
}

// --- Component ---

export function RelationshipGraph({ isOpen, onClose, onSelectAgent, onViewPair }: RelationshipGraphProps) {
  const { agents } = useAgents();
  const { data: relationships } = trpc.relationships.getGraph.useQuery();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const initializedRef = useRef(false);
  const stabilizedRef = useRef(false);
  const tickCountRef = useRef(0);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<GraphEdge | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // The draw loop reads hover through refs rather than the state above: state
  // would have to be in the effect's dependency list, which would tear down and
  // restart the animation frame on every mouse move. The state drives the
  // tooltips only.
  const hoveredNodeIdRef = useRef<string | null>(null);
  const hoveredEdgeKeyRef = useRef<string | null>(null);

  // Camera state
  const cameraRef = useRef({ offsetX: 0, offsetY: 0, zoom: 1 });
  const dragRef = useRef<{ type: 'pan' | 'node'; startX: number; startY: number; nodeId?: string } | null>(null);
  // Where the button went down, in canvas pixels. A pan or a node drag also ends
  // in a `click`; comparing against this is what tells a click on an edge from
  // the end of a drag that happened to finish over one.
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  const buildGraph = useCallback(() => {
    if (!agents.length) return;

    const CX = 400;
    const CY = 300;
    const R = 200;

    const existingIds = new Set(nodesRef.current.map((n) => n.id));
    const agentIds = new Set(agents.map((a) => String(a.id)));

    if (!initializedRef.current || existingIds.size !== agentIds.size) {
      nodesRef.current = agents.map((a, i) => {
        const angle = (2 * Math.PI * i) / agents.length;
        const states = (a.activeStates ?? []).map((s) => s.type);
        return {
          id: String(a.id),
          label: a.name,
          job: a.job_title ?? '',
          mood: a.needs?.mood ?? 50,
          states,
          color: agentColorHex(a.name),
          x: CX + R * Math.cos(angle),
          y: CY + R * Math.sin(angle),
          vx: 0, vy: 0,
          pinned: false,
        };
      });
      initializedRef.current = true;
      stabilizedRef.current = false;
      tickCountRef.current = 0;
    } else {
      // Update dynamic data without resetting positions
      for (const node of nodesRef.current) {
        const agent = agents.find((a) => String(a.id) === node.id);
        if (agent) {
          node.mood = agent.needs?.mood ?? 50;
          node.states = (agent.activeStates ?? []).map((s) => s.type);
        }
      }
    }

    edgesRef.current = (relationships ?? []).map((r) => ({
      source: String(r.agent_a),
      target: String(r.agent_b),
      friendshipAB: r.friendship_ab ?? 0,
      friendshipBA: r.friendship_ba ?? 0,
      romanceAB: r.romance_ab ?? 0,
      romanceBA: r.romance_ba ?? 0,
      trustAB: r.trust_ab ?? 0,
      trustBA: r.trust_ba ?? 0,
      status: r.status ?? 'strangers',
      tags: r.tags ?? [],
      interactionCount: r.interaction_count ?? 0,
    }));
  }, [agents, relationships]);

  // Mouse handlers
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const cam = cameraRef.current;
    return {
      x: (sx - cam.offsetX) / cam.zoom,
      y: (sy - cam.offsetY) / cam.zoom,
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x, y } = screenToWorld(sx, sy);
    pressRef.current = { x: sx, y: sy };

    // Check if clicking a node
    for (const node of nodesRef.current) {
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < 18 * 18) {
        dragRef.current = { type: 'node', startX: sx, startY: sy, nodeId: node.id };
        node.pinned = true;
        return;
      }
    }

    // Pan
    dragRef.current = { type: 'pan', startX: sx, startY: sy };
  }, [screenToWorld]);

  /** The visible edge within 8 px of a world-space point, if any. */
  const findEdgeAt = useCallback((x: number, y: number): GraphEdge | null => {
    for (const edge of edgesRef.current) {
      if (!passesFilter(edge, filter)) continue;
      const a = nodesRef.current.find(n => n.id === edge.source);
      const b = nodesRef.current.find(n => n.id === edge.target);
      if (!a || !b) continue;
      // Point-to-line distance
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const projX = a.x + t * dx;
      const projY = a.y + t * dy;
      const dist = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
      if (dist < 8) return edge;
    }
    return null;
  }, [filter]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x, y } = screenToWorld(sx, sy);

    if (dragRef.current) {
      if (dragRef.current.type === 'pan') {
        const dx = sx - dragRef.current.startX;
        const dy = sy - dragRef.current.startY;
        cameraRef.current.offsetX += dx;
        cameraRef.current.offsetY += dy;
        dragRef.current.startX = sx;
        dragRef.current.startY = sy;
      } else if (dragRef.current.type === 'node' && dragRef.current.nodeId) {
        const node = nodesRef.current.find(n => n.id === dragRef.current!.nodeId);
        if (node) {
          node.x = x;
          node.y = y;
          node.vx = 0;
          node.vy = 0;
        }
      }
      return;
    }

    // Hover detection — nodes
    let foundNode = false;
    for (const node of nodesRef.current) {
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < 18 * 18) {
        setHoveredNode(node);
        setHoveredEdge(null);
        setTooltipPos({ x: sx, y: sy });
        hoveredNodeIdRef.current = node.id;
        hoveredEdgeKeyRef.current = null;
        foundNode = true;
        break;
      }
    }

    if (!foundNode) {
      setHoveredNode(null);
      hoveredNodeIdRef.current = null;

      // Hover detection — edges
      const edge = findEdgeAt(x, y);
      if (edge) {
        setHoveredEdge(edge);
        setTooltipPos({ x: sx, y: sy });
        hoveredEdgeKeyRef.current = edgeKey(edge);
      } else {
        setHoveredEdge(null);
        hoveredEdgeKeyRef.current = null;
      }
    }
  }, [findEdgeAt, screenToWorld]);

  // A click that didn't travel, landing on a line (and not on a resident, whose
  // circle sits over its edges), opens that pair's dossier. Hover only ever
  // showed a tooltip, so the "why" behind a line stayed out of reach.
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const press = pressRef.current;
    pressRef.current = null;
    if (!rect || !press || !onViewPair) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (Math.hypot(sx - press.x, sy - press.y) > 4) return;
    const { x, y } = screenToWorld(sx, sy);
    if (nodesRef.current.some((n) => (x - n.x) ** 2 + (y - n.y) ** 2 < 18 * 18)) return;
    const edge = findEdgeAt(x, y);
    if (edge) onViewPair(edge.source, edge.target);
  }, [findEdgeAt, onViewPair, screenToWorld]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Leaving the canvas has to drop the hover too, or the tooltip stays pinned
  // over whatever the cursor last touched.
  const handleMouseLeave = useCallback(() => {
    dragRef.current = null;
    setHoveredNode(null);
    setHoveredEdge(null);
    hoveredNodeIdRef.current = null;
    hoveredEdgeKeyRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cam = cameraRef.current;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.3, Math.min(3, cam.zoom * factor));

    // Zoom toward cursor
    cam.offsetX = sx - (sx - cam.offsetX) * (newZoom / cam.zoom);
    cam.offsetY = sy - (sy - cam.offsetY) * (newZoom / cam.zoom);
    cam.zoom = newZoom;
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { x, y } = screenToWorld(sx, sy);

    for (const node of nodesRef.current) {
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < 18 * 18) {
        onSelectAgent?.(node.id);
        onClose();
        return;
      }
    }

    // Double-click empty space: reset layout
    initializedRef.current = false;
    stabilizedRef.current = false;
    tickCountRef.current = 0;
    cameraRef.current = { offsetX: 0, offsetY: 0, zoom: 1 };
    buildGraph();
  }, [screenToWorld, onSelectAgent, onClose, buildGraph]);

  // Animation loop
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
      const cam = cameraRef.current;
      const filteredEdges = edges.filter(e => passesFilter(e, filter));

      // Force simulation (only if not stabilized)
      if (!stabilizedRef.current) {
        tickCountRef.current++;
        const nodeMap = new Map(nodes.map(n => [n.id, n]));

        // Repulsion. Every pair is visited even when one end is pinned: the
        // per-node `pinned` guards below already stop a pinned node from
        // moving, whereas skipping the outer iteration also cancelled the push
        // a pinned node exerts on everything after it in the array.
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const force = 3000 / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
            if (!b.pinned) { b.vx += fx; b.vy += fy; }
          }
        }

        // Attraction along visible edges
        for (const edge of filteredEdges) {
          const a = nodeMap.get(edge.source);
          const b = nodeMap.get(edge.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const strength = Math.max(
            Math.abs(edge.friendshipAB), Math.abs(edge.friendshipBA),
            Math.abs(edge.romanceAB), Math.abs(edge.romanceBA),
          ) / 100;
          const force = (dist - 150) * 0.008 * (0.3 + strength);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!a.pinned) { a.vx += fx; a.vy += fy; }
          if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
        }

        // Center gravity
        for (const node of nodes) {
          if (node.pinned) continue;
          node.vx += (W / 2 - node.x) * 0.001;
          node.vy += (H / 2 - node.y) * 0.001;
        }

        // Apply velocity
        for (const node of nodes) {
          if (node.pinned) continue;
          node.vx *= 0.82;
          node.vy *= 0.82;
          node.x += node.vx;
          node.y += node.vy;
        }

        // Stabilize after 120 frames (~2 seconds)
        if (tickCountRef.current > 120) {
          stabilizedRef.current = true;
        }
      }

      // --- Draw ---
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(cam.offsetX, cam.offsetY);
      ctx.scale(cam.zoom, cam.zoom);

      const nodeMap = new Map(nodes.map(n => [n.id, n]));

      // Connected nodes for dimming
      const connectedIds = new Set<string>();
      for (const edge of filteredEdges) {
        connectedIds.add(edge.source);
        connectedIds.add(edge.target);
      }

      // Edges
      for (const edge of filteredEdges) {
        const a = nodeMap.get(edge.source);
        const b = nodeMap.get(edge.target);
        if (!a || !b) continue;

        const color = getEdgeColor(edge);
        const width = getEdgeWidth(edge);
        const isHovered = hoveredEdgeKeyRef.current === edgeKey(edge);

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = isHovered ? width + 2 : width;
        ctx.globalAlpha = isHovered ? 1 : 0.7;

        // Dashed line for grudges
        if (edge.tags.includes('grudge')) {
          ctx.setLineDash([6, 4]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Status label at midpoint
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (edge.status !== 'strangers' && edge.status !== 'acquaintances') {
          ctx.fillStyle = color;
          ctx.font = "bold 8px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          // Background pill
          const label = edge.status.replace(/_/g, ' ');
          const tw = ctx.measureText(label).width + 6;
          ctx.fillStyle = '#0f0e0b';
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.roundRect(mx - tw / 2, my - 6, tw, 12, 3);
          ctx.fill();
          ctx.globalAlpha = 1;

          ctx.fillStyle = color;
          ctx.fillText(label, mx, my);
        }
      }

      // Nodes
      for (const node of nodes) {
        const isDimmed = filter !== 'all' && !connectedIds.has(node.id);
        const isHovered = hoveredNodeIdRef.current === node.id;

        ctx.globalAlpha = isDimmed ? 0.3 : 1;

        // State ring
        const ringState = topState(node.states);
        if (ringState) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 19, 0, 2 * Math.PI);
          ctx.strokeStyle = stateCss(ringState, '#6a6250');
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }

        // Main circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, 16, 0, 2 * Math.PI);
        ctx.fillStyle = isHovered ? '#2e2b20' : '#252219';
        ctx.fill();
        ctx.strokeStyle = node.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Initial
        ctx.fillStyle = "#d4c9a8";
        ctx.font = "bold 14px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(node.label.charAt(0).toUpperCase(), node.x, node.y);

        // Name below
        ctx.font = "9px sans-serif";
        ctx.fillStyle = isDimmed ? '#6a6250' : '#d4c9a8';
        ctx.fillText(node.label, node.x, node.y + 26);

        // Mood indicator (small dot below name)
        const moodColor = node.mood > 70 ? '#22c55e' : node.mood >= 40 ? '#eab308' : '#ef4444';
        ctx.beginPath();
        ctx.arc(node.x, node.y + 34, 3, 0, 2 * Math.PI);
        ctx.fillStyle = moodColor;
        ctx.fill();

        ctx.globalAlpha = 1;
      }

      ctx.restore();

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [isOpen, buildGraph, filter]);

  if (!isOpen) return null;

  const filterButtons: { mode: FilterMode; label: string; icon: string }[] = [
    { mode: 'all', label: 'All', icon: '🔗' },
    { mode: 'friends', label: 'Friends', icon: '🤝' },
    { mode: 'romance', label: 'Romance', icon: '💕' },
    { mode: 'rivals', label: 'Rivals', icon: '⚔️' },
    { mode: 'drama', label: 'Drama', icon: '💔' },
  ];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-ui-panel border border-ui-line shadow-2xl w-[840px] max-w-[95vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-ui-line">
          <h2 className="text-sm font-bold text-ui-text">Relationship Graph</h2>
          <div className="flex items-center gap-2">
            {filterButtons.map(({ mode, label, icon }) => (
              <button
                key={mode}
                onClick={() => setFilter(mode)}
                className={`text-xs px-2 py-1 rounded-sm border transition-colors ${
                  filter === mode
                    ? 'bg-ui-hover text-ui-gold border-ui-line-accent'
                    : 'text-ui-dim border-transparent hover:text-ui-text hover:bg-ui-hover'
                }`}
              >
                {icon} {label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="text-ui-dim hover:text-ui-text text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Canvas */}
        <div className="p-2 relative">
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            className={`w-full rounded-sm bg-ui-deep ${
              hoveredEdge && !hoveredNode && onViewPair ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
            }`}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
          />

          {/* Nothing to draw yet: an empty canvas looks broken, so say why. */}
          {(agents.length === 0 || (relationships ?? []).length === 0) && (
            <div className="absolute inset-2 flex items-center justify-center pointer-events-none">
              <EmptyState
                icon="🕸"
                title={agents.length === 0 ? "Nobody lives here yet." : "Nobody has met yet."}
                hint="Friendships, romances and rivalries are drawn as lines between residents as they form."
              />
            </div>
          )}

          {/* Node Tooltip */}
          {hoveredNode && (
            <div
              className="absolute z-50 pointer-events-none bg-ui-deep border border-ui-line rounded-sm px-3 py-2 text-xs shadow-lg"
              style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 10 }}
            >
              <div className="font-bold text-ui-text">{hoveredNode.label}</div>
              {hoveredNode.job && <div className="text-ui-dim">{hoveredNode.job}</div>}
              <div className="flex items-center gap-1 mt-1">
                <span className="text-ui-dim">Mood:</span>
                <span className={hoveredNode.mood > 70 ? 'text-ui-good' : hoveredNode.mood >= 40 ? 'text-ui-gold' : 'text-ui-bad'}>
                  {Math.round(hoveredNode.mood)}
                </span>
              </div>
              {hoveredNode.states.length > 0 && (
                <div className="text-ui-dim mt-0.5">
                  States: {hoveredNode.states.join(', ')}
                </div>
              )}
              <div className="text-ui-muted mt-1 italic">Double-click to select</div>
            </div>
          )}

          {/* Edge Tooltip */}
          {hoveredEdge && !hoveredNode && (
            <div
              className="absolute z-50 pointer-events-none bg-ui-deep border border-ui-line rounded-sm px-3 py-2 text-xs shadow-lg"
              style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 10 }}
            >
              <div className="font-bold text-ui-text capitalize">{hoveredEdge.status.replace(/_/g, ' ')}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1 text-ui-text">
                <span>Friendship:</span>
                <span>{hoveredEdge.friendshipAB.toFixed(0)} / {hoveredEdge.friendshipBA.toFixed(0)}</span>
                <span>Romance:</span>
                <span>{hoveredEdge.romanceAB.toFixed(0)} / {hoveredEdge.romanceBA.toFixed(0)}</span>
                <span>Trust:</span>
                <span>{hoveredEdge.trustAB.toFixed(0)} / {hoveredEdge.trustBA.toFixed(0)}</span>
                <span className="text-ui-dim">Interactions:</span>
                <span className="text-ui-dim">{hoveredEdge.interactionCount}</span>
              </div>
              {hoveredEdge.tags.length > 0 && (
                <div className="text-ui-dim mt-1">Tags: {hoveredEdge.tags.join(', ')}</div>
              )}
              {onViewPair && <div className="text-ui-muted mt-1 italic">Click for their story</div>}
            </div>
          )}
        </div>

        {/* Legend: what the lines and rings mean, then how to drive the graph. */}
        <div className="px-5 py-2.5 border-t border-ui-line flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[10px]">
          <div className="flex items-center gap-4 text-ui-dim">
            <span className="text-ui-muted uppercase tracking-wider">Lines</span>
            {([
              ['Friendship', EDGE_COLORS.friendship, false],
              ['Romance', EDGE_COLORS.romance, false],
              ['Rivalry', EDGE_COLORS.rivalry, false],
              ['Grudge', EDGE_COLORS.grudge, true],
            ] as const).map(([label, color, dashed]) => (
              <span key={label} className="flex items-center gap-1.5">
                <span
                  className="inline-block w-5"
                  style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }}
                />
                {label}
              </span>
            ))}
            <span className="flex items-center gap-1.5" title="A coloured ring around a resident shows their strongest active state (angry, in love, drunk...)">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-ui-gold" />
              State ring
            </span>
          </div>
          <div className="flex items-center gap-3 text-ui-muted">
            {[
              ['drag', 'move or pan'],
              ['scroll', 'zoom'],
              ['click line', 'their story'],
              ['double-click', 'open resident'],
              ['double-click empty', 'reset view'],
            ].map(([key, what]) => (
              <span key={key} className="flex items-center gap-1">
                <kbd className="px-1 py-px bg-ui-raised border border-ui-line text-ui-dim rounded-sm not-italic">{key}</kbd>
                {what}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
