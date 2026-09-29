import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Container, Graphics } from "pixi.js";
import { useGameCanvas } from "../../hooks/useGameCanvas";
import { TilemapRenderer } from "./TilemapRenderer";
import { BuildingRenderer } from "./BuildingRenderer";
import { CameraController } from "./CameraController";
import { LightingSystem } from "./LightingSystem";
import { WeatherEffects } from "./WeatherEffects";
import { SpritePool, actionTypeOf } from "./SpritePool";
import { BubbleSystem } from "./BubbleSystem";
import { InteractionLayer } from "./InteractionLayer";
import { locationAt, type LocationLike } from "../../lib/locationInfo";
import { ParticleEngine } from "./particles/ParticleEngine";
import { SYSTEM_FACTORIES } from "./systems";
import { taskThought } from "./systems/activityFx/workText";
import type { CanvasSystem, DataContext, FrameContext } from "./systems/types";
import type { ViewRect } from "./systems/view";
import { useCanvasActivity } from "../../hooks/useCanvasActivity";
import { onCanvasEvent } from "../../lib/canvasBus";
import { PlaybackOverlay } from "./PlaybackOverlay";
import type { ParticleContext } from "./particles/types";

// Day phases during which each building type's chimney smokes.
// Mirrors CHIMNEY_TYPES in BuildingRenderer (tavern, bakery, workshop, divebar, home).
const SMOKE_PHASES: Record<string, string[]> = {
  home: ['evening', 'night'],
  tavern: ['evening', 'night'],
  divebar: ['evening', 'night'],
  bakery: ['dawn', 'morning'],
  workshop: ['morning', 'afternoon'],
};

// Held-pose emotes: action type -> looping emote key. Emotes only live ~1.5s,
// so a pose that lasts minutes has to re-puff to stay legible.
const POSE_EMOTES: Record<string, string> = {
  sleeping: 'zzz',
  working: 'work',
};
const POSE_PUFF_INTERVAL_MS = 7000;

/** Head height — where the conversation arc attaches, above the feet anchor. */
const CONVO_LINK_LIFT = 14;

// Chimney rect sizes from BuildingRenderer.drawChimney (cw, ch).
// Writes into `out` instead of returning a point: the caller runs per frame.
function chimneyAnchor(loc: any, out: { x: number; y: number }): boolean {
  const pos = loc.position;
  if (!pos?.width) return false;
  const cw = loc.type === 'bakery' ? 6 : loc.type === 'workshop' ? 4 : 5;
  const ch = loc.type === 'bakery' ? 10 : loc.type === 'workshop' ? 8 : 9;
  out.x = pos.x + pos.width - cw - 4 + cw / 2; // chimney center (top-right, 4px inset)
  out.y = pos.y - ch + 2;                      // chimney cap top
  return true;
}

/**
 * FNV-1a over everything that actually changes the static tilemap layers.
 * `world` is re-parsed from JSON on every poll, so array identity can't gate the
 * redraw; the previous signature sampled only lengths plus the first and last
 * tile, which missed same-length content edits and any location that moved and
 * left stale zones, roads and door paths on screen.
 */
function hashStaticLayers(
  locations: any[],
  roads: Array<{ x: number; y: number }>,
  terrain: Array<{ x: number; y: number; kind?: string }>,
): number {
  let h = 2166136261;
  // `| 0` truncates, so this is blind to sub-pixel movement. Every coordinate fed
  // in is integer worldgen output (tile indices and tile-aligned rects), so that
  // assumption holds; a fractional location origin would need a different mix.
  const mix = (n: number) => { h = Math.imul(h ^ (n | 0), 16777619); };
  const mixStr = (s: string) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); };
  for (const loc of locations) {
    mix(loc.id ?? 0);
    mixStr(String(loc.type ?? ''));
    const p = loc.position;
    if (p) { mix(p.x); mix(p.y); mix(p.width); mix(p.height); }
    const e = loc.entry_point;
    if (e) { mix(e.x); mix(e.y); }
  }
  for (const t of roads) { mix(t.x); mix(t.y); }
  for (const t of terrain) { mix(t.x); mix(t.y); mixStr(String(t.kind ?? '')); }
  return h >>> 0;
}

interface GameCanvasProps {
  agents: any[];
  world: any;
  /** Rows from `world.getActiveEvents` — a separate query, not a column on `world`. */
  events?: any[];
  conversations: any[];
  locations?: any[];
  relationships?: any[];
  onAgentSelect: (agentId: string) => void;
  onAgentContextMenu: (agentId: string, pos: { x: number; y: number }) => void;
  onAgentHover: (agentId: string | null, pos?: { x: number; y: number }) => void;
  /** A click on a building/open area (no agent under it); `null` = bare ground. */
  onLocationSelect?: (locationId: number | null) => void;
  /** The location whose panel is open; outlined on the map. */
  selectedLocationId?: number | null;
  selectedAgentId: string | null;
  /** Bumped on every explicit focus request, so re-picking the same agent re-centers. */
  focusNonce?: number;
}

export const GameCanvas = React.memo(function GameCanvas({
  agents,
  world,
  events,
  conversations,
  locations,
  relationships,
  onAgentSelect,
  onAgentContextMenu,
  onAgentHover,
  onLocationSelect,
  selectedLocationId,
  selectedAgentId,
  focusNonce,
}: GameCanvasProps) {
  const { app, containerRef } = useGameCanvas();
  const activity = useCanvasActivity();

  // Refs for subsystems
  const tilemapRef = useRef<TilemapRenderer | null>(null);
  const buildingRendererRef = useRef<BuildingRenderer | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const lightingRef = useRef<LightingSystem | null>(null);
  const weatherRef = useRef<WeatherEffects | null>(null);
  const spritePoolRef = useRef<SpritePool | null>(null);
  const bubbleSystemRef = useRef<BubbleSystem | null>(null);
  const interactionRef = useRef<InteractionLayer | null>(null);
  const relationshipLinesRef = useRef<Graphics | null>(null);
  const tensionLinesRef = useRef<Graphics | null>(null);
  const pathTrailRef = useRef<Graphics | null>(null);
  const particleEngineRef = useRef<ParticleEngine | null>(null);
  /** Pluggable feature systems (systems/index.ts), created with the other subsystems. */
  const systemsRef = useRef<CanvasSystem[]>([]);
  // One data/frame context object each, refilled in place.
  const systemDataRef = useRef<DataContext>({
    agents: [], world: null, events: [], locations: [], conversations: [], relationships: [], activity: [],
  });
  const systemViewRef = useRef<ViewRect>({ x: 0, y: 0, w: 0, h: 0, scale: 1 });
  const systemFrameRef = useRef<FrameContext | null>(null);

  // Layer containers
  const worldContainerRef = useRef<Container | null>(null);

  // Track previous agent actions to detect changes for thought bubbles
  const prevActionsRef = useRef<Map<string, string>>(new Map());

  // Last time each held pose re-puffed its emote, keyed "agentId:emote"
  const lastPosePuffRef = useRef<Map<string, number>>(new Map());

  // Scratch buffers for the per-frame ticker. Reused and refilled in place —
  // allocating these at 60fps was steady GC churn.
  const posingRef = useRef<Set<string>>(new Set());
  const agentDataRef = useRef<ParticleContext['agents']>([]);
  const chimneyLocsRef = useRef<ParticleContext['locations']>([]);
  const particleCtxRef = useRef<ParticleContext>({
    agents: [], weather: 'sunny', dayPhase: 'morning', season: 'spring', locations: [],
  });

  // Content signature of the static tilemap layers, so they aren't rebuilt every
  // tick. Cleared when the renderer is torn down, since the new one draws none.
  const staticLayersSigRef = useRef('');

  // Camera follow-lock on the selected agent (cancelled when the user pans)
  const [following, setFollowing] = useState(false);
  // `followingRef` is what the ticker reads, so every mutation site writes it
  // synchronously — a deferred write would let a stale `true` survive a pan.
  const followingRef = useRef(false);
  const setFollow = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
  }, []);
  const selectedIdRef = useRef(selectedAgentId);
  useEffect(() => {
    selectedIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  // A focus request that arrived before the agent's sprite existed
  const pendingFocusRef = useRef<string | null>(null);

  // Stable locations ref so the init effect can read the latest value without re-running
  const locationsRef = useRef(locations);
  locationsRef.current = locations;

  // Stable data refs so the per-frame ticker can access latest conversations/agents/world
  const conversationsRef = useRef(conversations);
  const agentsRef = useRef(agents);
  const worldRef = useRef(world);
  // Read per frame by the link-line pass, so it can't wait for the data effect.
  // Agent ids are stringified once here rather than inside that pass: the pass
  // runs at 60fps over every relationship row, so the `String(rel.agent_a)`
  // conversions were ~24k short-lived strings a second. `relationships` is
  // re-parsed from JSON each poll, so this rebuilds about once a second.
  const normalizedRelationships = useMemo(
    () => (relationships ?? []).map((rel: any) => ({
      a: String(rel.agent_a),
      b: String(rel.agent_b),
      rel,
    })),
    [relationships],
  );
  const relationshipsRef = useRef(normalizedRelationships);
  relationshipsRef.current = normalizedRelationships;

  // Update refs when data changes
  useEffect(() => {
    conversationsRef.current = conversations;
    agentsRef.current = agents;
    worldRef.current = world;
  }, [conversations, agents, world]);

  // Stable callback refs so the interaction layer doesn't go stale
  const callbacksRef = useRef({ onAgentSelect, onAgentContextMenu, onAgentHover, onLocationSelect });
  callbacksRef.current = { onAgentSelect, onAgentContextMenu, onAgentHover, onLocationSelect };

  const stableOnSelect = useCallback((id: string) => callbacksRef.current.onAgentSelect(id), []);
  const stableOnHover = useCallback((id: string | null, pos?: { x: number; y: number }) => callbacksRef.current.onAgentHover(id, pos), []);
  const stableOnContext = useCallback((id: string, pos: { x: number; y: number }) => callbacksRef.current.onAgentContextMenu(id, pos), []);
  const stableOnLocation = useCallback((id: number | null) => callbacksRef.current.onLocationSelect?.(id), []);
  const stableLocationAt = useCallback(
    (x: number, y: number) => locationAt(x, y, (locationsRef.current ?? []) as LocationLike[])?.id ?? null,
    [],
  );

  /**
   * Tension + relationship lines. Anchored to interpolated sprite positions, so
   * this is driven from the per-frame ticker rather than the data effect — every
   * input is read through a ref for that reason. Declared above the ticker effect
   * that lists it as a dependency: a dependency array is evaluated during render,
   * and a `const` referenced before its initializer throws.
   */
  const drawAgentLinks = useCallback(() => {
    const g = relationshipLinesRef.current;
    const tg = tensionLinesRef.current;
    if (!g) return;
    g.clear();
    tg?.clear();

    const relationships = relationshipsRef.current;
    const selectedAgentId = selectedIdRef.current;

    // --- Tension lines: always-on faint lines for dramatic relationships ---
    if (tg && spritePoolRef.current && relationships.length > 0) {
      for (const { a, b, rel } of relationships) {
        let color = 0;
        let shouldDraw = false;

        if (rel.status === 'partners') { color = 0xec4899; shouldDraw = true; }
        else if ((rel.tags as string[])?.includes('grudge')) { color = 0x991b1b; shouldDraw = true; }
        else if (rel.status === 'rivals' || rel.status === 'enemies') { color = 0xef4444; shouldDraw = true; }

        if (!shouldDraw) continue;

        const spriteA = spritePoolRef.current.getSprite(a);
        const spriteB = spritePoolRef.current.getSprite(b);
        if (!spriteA || !spriteB) continue;

        // Brighten if either agent is selected
        const isSelected = a === selectedAgentId || b === selectedAgentId;
        const alpha = isSelected ? 0.6 : 0.15;

        tg.moveTo(spriteA.container.x, spriteA.container.y)
          .lineTo(spriteB.container.x, spriteB.container.y)
          .stroke({ color, alpha, width: 1.5 });
      }
    }

    // --- Active conversations: face the partner + draw a faint speech arc ---
    const convos = conversationsRef.current ?? [];
    if (spritePoolRef.current && convos.length > 0) {
      for (const convo of convos as any[]) {
        if (convo.status !== 'active') continue;
        const ids = (convo.participants ?? []) as (number | string)[];
        if (ids.length < 2) continue;
        const spriteA = spritePoolRef.current.getSprite(String(ids[0]));
        const spriteB = spritePoolRef.current.getSprite(String(ids[1]));
        if (!spriteA || !spriteB) continue;

        const ax = spriteA.container.x;
        const ay = spriteA.container.y;
        const bx = spriteB.container.x;
        const by = spriteB.container.y;

        // Standing still produces no step delta, so facing is whatever direction
        // they arrived in — often back to back. Turn them toward each other.
        if (ax !== bx) {
          spriteA.setFacing(bx < ax ? -1 : 1);
          spriteB.setFacing(ax < bx ? -1 : 1);
        }

        // Bowed upward and drawn at head height so it reads as an exchange rather
        // than another relationship line.
        const bow = Math.min(24, Math.max(8, Math.hypot(bx - ax, by - ay) * 0.3));
        g.moveTo(ax, ay - CONVO_LINK_LIFT)
          .quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - CONVO_LINK_LIFT - bow, bx, by - CONVO_LINK_LIFT)
          .stroke({ color: 0xfde68a, alpha: 0.3, width: 1.5 });
      }
    }

    // --- Selected agent relationship lines (detailed, with strength-based alpha) ---
    const agentId = selectedAgentId;
    if (!agentId || !spritePoolRef.current || relationships.length === 0) return;

    // Loop-invariant: the "from" end of every line below is the selected agent.
    const fromSprite = spritePoolRef.current.getSprite(agentId);
    if (!fromSprite) return;

    // Filtered inline rather than via `.filter` — this runs every frame.
    for (const { a, b, rel } of relationships) {
      const isMine = a === agentId || b === agentId;
      if (!isMine) continue;
      const otherId = a === agentId ? b : a;
      const toSprite = spritePoolRef.current.getSprite(otherId);
      if (!toSprite) continue;
      const strength = Math.max(Math.abs(rel.friendship_ab ?? 0), Math.abs(rel.romance_ab ?? 0));
      const alpha = Math.min((strength / 100) * 0.6, 0.6);
      const color =
        (rel.romance_ab ?? 0) > (rel.friendship_ab ?? 0)
          ? 0xf472b6
          : (rel.friendship_ab ?? 0) < 0
          ? 0xef4444
          : 0x60a5fa;
      // The container origin already is the agent's world position — the tension
      // lines above use it raw, and offsetting here left a second, dangling line.
      g.moveTo(fromSprite.container.x, fromSprite.container.y)
       .lineTo(toSprite.container.x, toSprite.container.y)
       .stroke({ color, alpha, width: 1 });
    }
  }, []);

  // Initialize subsystems when app is ready
  useEffect(() => {
    if (!app) return;

    // Create layer hierarchy
    const worldContainer = new Container();
    worldContainer.eventMode = "passive";
    worldContainer.interactiveChildren = true;
    worldContainerRef.current = worldContainer;
    app.stage.addChild(worldContainer);

    // Tilemap (grass background)
    const tilemap = new TilemapRenderer(app);
    worldContainer.addChild(tilemap.container);
    tilemapRef.current = tilemap;

    // Building renderer (buildings with interiors) — sits above tilemap
    const buildingRenderer = new BuildingRenderer(worldContainer);
    buildingRendererRef.current = buildingRenderer;

    // Locations are seeded by the `[locations]` effect below, which re-runs once
    // `app` is set. Initializing here too built every building
    // twice on mount.

    // Tension lines (always-on faint relationship indicators) — below sprites
    const tensionLines = new Graphics();
    tensionLines.eventMode = 'none';
    worldContainer.addChild(tensionLines);
    tensionLinesRef.current = tensionLines;

    // Path trail (dotted line showing selected agent's A* path) — below sprites
    const pathTrail = new Graphics();
    pathTrail.eventMode = 'none';
    worldContainer.addChild(pathTrail);
    pathTrailRef.current = pathTrail;

    // Ground layer for pluggable systems — decorations and critters under the agents
    const systemGround = new Container();
    systemGround.eventMode = 'none';
    worldContainer.addChild(systemGround);

    // Sprite pool (agent circles) — inside world so it moves with camera
    const spritePool = new SpritePool(worldContainer);
    spritePoolRef.current = spritePool;

    // Relationship lines graphics — between sprites and bubbles
    const relLines = new Graphics();
    relLines.eventMode = 'none'; // transparent to clicks
    worldContainer.addChild(relLines);
    relationshipLinesRef.current = relLines;

    // Over-agents layer for pluggable systems — beat effects, flying critters
    const systemOver = new Container();
    systemOver.eventMode = 'none';
    worldContainer.addChild(systemOver);

    // Particle engine — data-driven visual effects below speech bubbles
    const particleEngine = new ParticleEngine(worldContainer, 1000);
    particleEngine.initTextures(app.renderer as any).catch(err =>
      console.warn('[ParticleEngine] Texture init failed:', err)
    );
    particleEngineRef.current = particleEngine;

    // Bubble system — also inside world container so bubbles track agents
    const bubbleSystem = new BubbleSystem(worldContainer);
    bubbleSystemRef.current = bubbleSystem;

    // A system that fails to build must not take the canvas down with it.
    systemsRef.current = [];
    // `?nosystems` in the URL skips them all — the A/B switch for frame-time comparisons.
    const factories = new URLSearchParams(window.location.search).has('nosystems') ? [] : SYSTEM_FACTORIES;
    for (const make of factories) {
      try {
        systemsRef.current.push(make(
          { ground: systemGround, overAgents: systemOver },
          { sprites: spritePool, bubbles: bubbleSystem },
        ));
      } catch (err) {
        console.warn('[canvas systems] factory failed:', err);
      }
    }

    // Camera — dimensions will be set by the resize effect below
    const camera = new CameraController(app, worldContainer);
    // Clear the ref synchronously so the ticker stops fighting the drag this frame,
    // not whenever React gets around to committing the state update.
    camera.onUserPan = () => {
      setFollow(false);
    };
    cameraRef.current = camera;

    // Lighting system (lightmap overlay, replaces DayNightCycle)
    const lighting = new LightingSystem(app, worldContainer);
    lightingRef.current = lighting;

    // Weather (on stage, above world but below day/night)
    const weather = new WeatherEffects(app);
    weatherRef.current = weather;

    // Interaction layer
    const interaction = new InteractionLayer(spritePool, {
      onAgentSelect: stableOnSelect,
      onAgentHover: stableOnHover,
      onAgentContextMenu: stableOnContext,
      locationAt: stableLocationAt,
      onLocationSelect: stableOnLocation,
    });
    interaction.setup(app, worldContainer);
    interactionRef.current = interaction;

    // Animation loop — store ref for cleanup
    let lastLabelScale = 0;
    const cameraTickFn = (ticker: any) => {
      // Read the ref rather than the captured instance: the cleanup below nulls
      // it, and a frame that lands after teardown must not touch a destroyed
      // camera (StrictMode double-invoke, or any remount).
      const cam = cameraRef.current;
      if (!cam) return;
      // Follow-lock: re-aim at the selected agent every frame so the camera trails them
      const followId = selectedIdRef.current;
      if (followingRef.current && followId) {
        const followed = spritePoolRef.current?.getSprite(followId);
        if (followed) cam.focusOn(followed.container.x, followed.container.y);
      }
      cam.update(ticker.deltaTime);
      const s = cam.getScale();
      if (s !== lastLabelScale) {
        lastLabelScale = s;
        buildingRendererRef.current?.setZoom(s);
      }
    };
    app.ticker.add(cameraTickFn);

    return () => {
      app.ticker?.remove(cameraTickFn);
      staticLayersSigRef.current = '';
      // Both are keyed by agent id, and a world reset recycles ids. A surviving
      // `prevActionsRef` entry makes the new agent's first action look unchanged
      // and swallows its opening thought bubble; a surviving `lastPosePuffRef`
      // entry suppresses the pose emote for up to POSE_PUFF_INTERVAL_MS.
      prevActionsRef.current.clear();
      lastPosePuffRef.current.clear();
      for (const sys of systemsRef.current) sys.destroy();
      systemsRef.current = [];
      systemFrameRef.current = null;
      interaction.destroy();
      camera.destroy();
      lighting.destroy();
      weather.destroy();
      tilemap.destroy();
      buildingRenderer.destroy();
      spritePool.destroy();
      tensionLines.destroy();
      pathTrail.destroy();
      bubbleSystem.destroy();
      particleEngine.destroy();
      worldContainer.destroy({ children: true });
      // Every ref above now points at a destroyed object. The data effect and
      // the per-frame tickers reach for them through these refs, so leaving the
      // stale pointers in place lets a StrictMode double-invoke — or any
      // remount — drive dead subsystems. Null them so those paths bail instead.
      tilemapRef.current = null;
      buildingRendererRef.current = null;
      cameraRef.current = null;
      lightingRef.current = null;
      weatherRef.current = null;
      spritePoolRef.current = null;
      bubbleSystemRef.current = null;
      interactionRef.current = null;
      relationshipLinesRef.current = null;
      tensionLinesRef.current = null;
      pathTrailRef.current = null;
      particleEngineRef.current = null;
      worldContainerRef.current = null;
    };
  }, [app, stableOnSelect, stableOnHover, stableOnContext, stableLocationAt, stableOnLocation]);

  // Drive tilemap + camera dimensions from world state
  const mapW = (world as any)?.map_width ?? 0;
  const mapH = (world as any)?.map_height ?? 0;
  useEffect(() => {
    if (!tilemapRef.current || !cameraRef.current) return;
    if (mapW === 0 || mapH === 0) return;
    tilemapRef.current.resize(mapW, mapH);
    const size = tilemapRef.current.getMapSize();
    cameraRef.current.setMapSize(size.width, size.height);
    // `app` and the asset flag are dependencies even though they're unused here:
    // the world arrives before pixi is ready, so on a plain `[mapW, mapH]` this
    // would only ever run while the refs are still null and never again.
  }, [mapW, mapH, app]);

  // Initialize BuildingRenderer with location data when locations are available
  useEffect(() => {
    if (!buildingRendererRef.current || !locations || locations.length === 0) return;
    buildingRendererRef.current.init(locations);
    // `app` is a dep because the renderer is created in the
    // effect it gates; if locations arrive first this effect must re-run once it
    // exists, otherwise the map stays empty.
  }, [locations, app]);

  // Outline the location whose panel is open.
  useEffect(() => {
    const loc = selectedLocationId != null
      ? (locations ?? []).find((l: any) => l.id === selectedLocationId)
      : null;
    buildingRendererRef.current?.setSelectedRect(loc?.position ?? null);
  }, [selectedLocationId, locations, app]);

  // Update sprite targets when server data changes (sets targets, creates/removes sprites)
  useEffect(() => {
    if (!app || !spritePoolRef.current) return;

    const spritePool = spritePoolRef.current;
    // Set target positions on all sprites (they'll lerp toward these per-frame)
    spritePool.update(agents, selectedAgentId);

    // Show thought bubble when an agent's action changes
    for (const agent of agents) {
      const agentId = String(agent.id);
      // The server writes "daily work" for every shift; say what this workplace does instead.
      const actionDesc = taskThought((agent.current_action as any)?.taskDescription, agent, locations);
      const prevAction = prevActionsRef.current.get(agentId);

      if (actionDesc && actionDesc !== prevAction && bubbleSystemRef.current) {
        const sprite = spritePool.getSprite(agentId);
        if (sprite) {
          bubbleSystemRef.current.showTextThought(agentId, actionDesc, { x: sprite.container.x, y: sprite.container.y });
        }
      }
      prevActionsRef.current.set(agentId, actionDesc || '');
    }

    const liveIds = new Set(agents.map(a => String(a.id)));
    for (const agentId of prevActionsRef.current.keys()) {
      if (!liveIds.has(agentId)) prevActionsRef.current.delete(agentId);
    }

    // Retry a focus request that was made before the agent had a sprite
    const pending = pendingFocusRef.current;
    if (pending) {
      const sprite = spritePool.getSprite(pending);
      if (sprite && pending === selectedAgentId) {
        cameraRef.current?.focusOn(sprite.container.x, sprite.container.y);
        pendingFocusRef.current = null;
      } else if (pending !== selectedAgentId) {
        pendingFocusRef.current = null;
      }
    }

    // Rebind interaction events for any new sprites
    interactionRef.current?.updateBindings(spritePool.getAllIds());

    // Update occupancy dots on tilemap
    if (tilemapRef.current && locations) {
      tilemapRef.current.updateOccupancy(agents, locations);

      // Roads, terrain, zone patches and door paths are worldgen output that
      // only changes on a reseed — but `world` is re-parsed from JSON on every
      // poll, so array identity can't gate them and they were being torn down
      // and re-uploaded once a second. Redraw only when the content changes.
      const roads = world?.road_tiles ?? [];
      const terrain = world?.terrain_tiles ?? [];
      const sig = [
        mapW, mapH, locations.length, roads.length, terrain.length,
        hashStaticLayers(locations, roads, terrain),
      ].join('|');
      if (sig !== staticLayersSigRef.current) {
        staticLayersSigRef.current = sig;
        tilemapRef.current.setOpenAreaZones(locations);
        tilemapRef.current.setTerrainTiles(terrain);
        tilemapRef.current.setRoadTiles(roads);
        tilemapRef.current.setDoorPaths(locations, roads);
        lightingRef.current?.setRoadTiles(roads);
      }
    }

    // Update lighting system with current state
    if (lightingRef.current && locations && world) {
      // Active events come from their own query and are row objects, not a
      // `world.activeEvents` column — that read was always undefined, so the
      // festival glow had never rendered.
      const activeEvents = (events ?? []).map((e: any) => e.type);
      lightingRef.current.update(
        agents.map((a: any) => ({
          id: a.id,
          position: a.position ?? { x: 0, y: 0 },
          current_location: a.current_location ?? null,
          activeStates: a.activeStates ?? [],
        })),
        {
          day_phase: world?.day_phase ?? 'morning',
          weather: world?.weather ?? 'sunny',
          time: world?.time ?? { season: 'spring', hour: 12 },
        },
        locations,
        activeEvents,
      );
    }

    // Update BuildingRenderer with current agent locations
    if (buildingRendererRef.current) {
      const agentLocations = new Map<number, number | null>();
      for (const agent of agents) {
        agentLocations.set(agent.id, agent.current_location ?? null);
      }
      buildingRendererRef.current.update(agentLocations);
    }

    const data = systemDataRef.current;
    data.agents = agents;
    data.world = world;
    data.events = events ?? [];
    data.locations = locations ?? [];
    data.conversations = conversations ?? [];
    data.relationships = relationships ?? [];
    data.activity = activity;
    for (const sys of systemsRef.current) {
      try { sys.onData?.(data); } catch (err) { console.warn('[canvas systems] onData failed:', err); }
    }
    // `world` is a real dependency — this effect reads road/terrain tiles, day
    // phase, weather and time. It only appeared to work because `agents` gets a
    // fresh identity on the same poll; changing the weather while paused
    // updates `world` alone, and the lighting never saw it.
  }, [agents, selectedAgentId, locations, world, events, conversations, relationships, activity, app, mapW, mapH]);

  // Per-frame rendering loop — lerps sprites toward targets, no data dependency
  useEffect(() => {
    if (!app) return;

    const tickFn = (ticker: any) => {
      const delta = ticker.deltaTime;
      // Lerp all sprites toward their targets each frame
      spritePoolRef.current?.lerpAll(delta);
      // Link lines are anchored to interpolated sprite positions, so they have
      // to be redrawn alongside the lerp — on the data tick alone they visibly
      // detached from the sprites between polls.
      drawAgentLinks();
      // Update bubbles per-frame so expiry and emote float animation run smoothly
      if (bubbleSystemRef.current && spritePoolRef.current) {
        bubbleSystemRef.current.update(
          conversationsRef.current ?? [],
          agentsRef.current ?? [],
          delta / 60, // convert PIXI ticker delta to seconds
          spritePoolRef.current
        );

        // Held poses puff a matching emote on a slow loop so they read at a
        // glance. Driven per-frame rather than per-tick so they keep going while
        // paused. Keyed by "agentId:emote", not agent id, so switching pose
        // doesn't inherit the previous pose's cooldown.
        const now = Date.now();
        const posing = posingRef.current;
        posing.clear();
        for (const agent of agentsRef.current ?? []) {
          const emote = POSE_EMOTES[actionTypeOf(agent)];
          if (!emote) continue;
          const agentId = String(agent.id);
          const key = `${agentId}:${emote}`;
          posing.add(key);
          if (now - (lastPosePuffRef.current.get(key) ?? 0) < POSE_PUFF_INTERVAL_MS) continue;
          const sprite = spritePoolRef.current.getSprite(agentId);
          if (!sprite) continue;
          bubbleSystemRef.current.showEmote(agentId, emote, { x: sprite.container.x, y: sprite.container.y });
          lastPosePuffRef.current.set(key, now);
        }
        for (const key of lastPosePuffRef.current.keys()) {
          if (!posing.has(key)) lastPosePuffRef.current.delete(key);
        }
      }

      // Update particle engine per-frame. Every buffer below is hoisted and
      // refilled in place — `ParticleEngine.update` doesn't retain the context
      // past the call, and rebuilding it at 60fps was steady GC churn.
      const particleEngine = particleEngineRef.current;
      const spritePool = spritePoolRef.current;
      if (particleEngine && spritePool) {
        const sourceAgents = agentsRef.current ?? [];
        const agentData = agentDataRef.current;
        agentData.length = sourceAgents.length;
        for (let i = 0; i < sourceAgents.length; i++) {
          const a: any = sourceAgents[i];
          const id = String(a.id);
          const sprite = spritePool.getSprite(id);
          let entry = agentData[i];
          if (!entry) {
            entry = { id, x: 0, y: 0, states: [], action: 'idle' };
            agentData[i] = entry;
          }
          entry.id = id;
          entry.x = sprite?.container.x ?? 0;
          entry.y = sprite?.container.y ?? 0;
          const states = a.activeStates ?? [];
          entry.states.length = states.length;
          for (let s = 0; s < states.length; s++) entry.states[s] = states[s]?.type ?? states[s];
          entry.action = (typeof a.current_action === 'string' ? a.current_action : a.current_action?.type) ?? 'idle';
        }

        const dayPhase = (worldRef.current as any)?.day_phase ?? 'morning';

        // Synthetic 'chimney' locations — smoke emitters at chimney caps,
        // phase-gated per building type (bakery mornings, homes evenings, ...)
        const chimneyLocs = chimneyLocsRef.current;
        let chimneyCount = 0;
        for (const loc of locationsRef.current ?? []) {
          if (!SMOKE_PHASES[loc.type]?.includes(dayPhase)) continue;
          let entry = chimneyLocs[chimneyCount];
          if (!entry) {
            entry = { id: loc.id, type: 'chimney', x: 0, y: 0 };
            chimneyLocs[chimneyCount] = entry;
          }
          if (!chimneyAnchor(loc, entry)) continue;
          entry.id = loc.id;
          chimneyCount++;
        }
        chimneyLocs.length = chimneyCount;

        const ctx = particleCtxRef.current;
        ctx.agents = agentData;
        ctx.weather = (worldRef.current as any)?.weather ?? 'sunny';
        ctx.dayPhase = dayPhase;
        ctx.season = (worldRef.current as any)?.time?.season ?? 'spring';
        ctx.locations = chimneyLocs;

        // Camera center for world-space emitters
        const wc = worldContainerRef.current;
        const cameraX = wc ? -wc.x / wc.scale.x + (app.renderer.width / 2) / wc.scale.x : 0;
        const cameraY = wc ? -wc.y / wc.scale.y + (app.renderer.height / 2) / wc.scale.y : 0;

        particleEngine.update(delta / 60, ctx, cameraX, cameraY);
      }

      const systems = systemsRef.current;
      const wc = worldContainerRef.current;
      if (systems.length > 0 && wc) {
        const view = systemViewRef.current;
        view.scale = wc.scale.x || 1;
        view.x = -wc.x / view.scale;
        view.y = -wc.y / view.scale;
        view.w = app.renderer.width / view.scale;
        view.h = app.renderer.height / view.scale;
        let frame = systemFrameRef.current;
        if (!frame) {
          frame = { dt: 0, seconds: 0, now: 0, view, data: systemDataRef.current };
          systemFrameRef.current = frame;
        }
        frame.dt = delta;
        frame.seconds = delta / 60;
        frame.now = performance.now();
        for (const sys of systems) {
          try { sys.update(frame); } catch (err) { console.warn('[canvas systems] update failed:', err); }
        }
      }
    };

    app.ticker.add(tickFn);
    return () => {
      app.ticker?.remove(tickFn);
    };
  }, [app, drawAgentLinks]);

  // Lighting render loop — runs per frame in ticker
  useEffect(() => {
    if (!app || !lightingRef.current) return;
    const lighting = lightingRef.current;
    // Created once, not per frame. The sprite container origin is the agent's
    // interpolated world position (the link lines anchor to it the same way).
    const agentPos = (id: string) => spritePoolRef.current?.getSprite(id)?.container;

    const lightTick = (ticker: { deltaTime: number }) => {
      const wc = worldContainerRef.current;
      if (!wc) return;
      const screenW = app.renderer.width;
      const screenH = app.renderer.height;
      lighting.render(wc.x, wc.y, wc.scale.x, screenW, screenH, ticker.deltaTime, agentPos);
    };

    app.ticker.add(lightTick);
    return () => { app.ticker?.remove(lightTick); };
    // A new `app` rebuilds the subsystems, and this tick captures the
    // instance — without the dep it would keep rendering a destroyed one.
  }, [app]);

  // Update weather effects
  useEffect(() => {
    if (!app || !weatherRef.current) return;
    const weather = world?.weather ?? "sunny";
    const weatherSystem = weatherRef.current;
    // Read the size per-frame: the canvas resizes whenever the agent panel or a
    // resize handle moves, and stale bounds mis-place spawns and the cull test.
    const weatherTick = (ticker: any) => {
      weatherSystem.update(weather, app.renderer.width, app.renderer.height, ticker.deltaTime);
    };
    app.ticker.add(weatherTick);
    return () => {
      app.ticker?.remove(weatherTick);
    };
    // Same as the lighting tick: the captured instance dies with a rebuild.
  }, [world?.weather, app]);

  // The lock belongs to one agent: changing selection must not silently transfer it.
  useEffect(() => {
    setFollow(false);
  }, [selectedAgentId, setFollow]);

  // An agent can drop out of the roster (death, deactivation) while locked. The
  // Follow button unmounts with it, so the lock would be stuck on with no way to
  // release it other than panning.
  useEffect(() => {
    if (!following) return;
    if (!selectedAgentId || !agents.some(a => String(a.id) === selectedAgentId)) {
      setFollow(false);
    }
  }, [following, selectedAgentId, agents, setFollow]);

  // Camera requests from the UI (canvas bus): a world point, or a location's centre.
  // Panning releases the follow lock, the same as a user drag would.
  useEffect(() => onCanvasEvent((e) => {
    const cam = cameraRef.current;
    if (!cam) return;
    if (e.type === 'focus') {
      setFollow(false);
      cam.focusOn(e.x, e.y);
    } else if (e.type === 'focusLocation') {
      const loc = (locationsRef.current ?? []).find((l: any) => l.id === e.locationId) as any;
      if (!loc?.position) return;
      setFollow(false);
      cam.focusOn(loc.position.x + loc.position.width / 2, loc.position.y + loc.position.height / 2);
    }
  }), [setFollow]);

  // Focus camera on selected agent
  useEffect(() => {
    if (!selectedAgentId) return;
    const sprite = spritePoolRef.current?.getSprite(selectedAgentId);
    if (sprite && cameraRef.current) {
      cameraRef.current.focusOn(sprite.container.x, sprite.container.y);
    } else {
      // Sprite (or the whole pool) doesn't exist yet — a feed row can be clicked
      // before pixi finishes initializing. The sprite-pool effect retries.
      pendingFocusRef.current = selectedAgentId;
    }
  }, [selectedAgentId, focusNonce]);

  // Path trail: the A* path is server data in world coordinates, so — unlike the
  // link lines above — it doesn't move between polls and stays on the data tick.
  useEffect(() => {
    const pg = pathTrailRef.current;
    if (!pg) return;
    pg.clear();
    if (!selectedAgentId || !agents) return;

    const agent = agents.find((a: any) => String(a.id) === selectedAgentId);
    if (!agent?.current_path || (agent.current_path as number[][]).length === 0) return;
    const path = agent.current_path as number[][];
    // Draw dashed path
    for (let i = 0; i < path.length - 1; i++) {
      const [x1, y1] = path[i];
      const [x2, y2] = path[i + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / 8));
      for (let j = 0; j < steps; j += 2) {
        const t1 = j / steps;
        const t2 = Math.min((j + 1) / steps, 1);
        pg.moveTo(x1 + dx * t1, y1 + dy * t1);
        pg.lineTo(x1 + dx * t2, y1 + dy * t2);
      }
    }
    pg.stroke({ width: 2, color: 0xffffff, alpha: 0.3 });

    // Destination X marker
    const [destX, destY] = path[path.length - 1];
    pg.moveTo(destX - 4, destY - 4).lineTo(destX + 4, destY + 4);
    pg.moveTo(destX + 4, destY - 4).lineTo(destX - 4, destY + 4);
    pg.stroke({ width: 2, color: 0xffffff, alpha: 0.5 });
  }, [selectedAgentId, agents, app]);

  return (
    <div className="flex-1 min-w-0 h-full overflow-hidden relative">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ imageRendering: "pixelated" }}
      />
      <PlaybackOverlay paused={Boolean(world?.is_paused)} speed={world?.tick_speed ?? 1} />
      {selectedAgentId && agents.some(a => String(a.id) === selectedAgentId) && (
        <button
          type="button"
          onClick={() => setFollow(!following)}
          className={`absolute top-2 left-2 z-20 px-2 py-1 text-[11px] rounded border shadow transition-colors ${
            following
              ? "bg-[#c8a84b] text-[#1a1814] border-[#c8a84b]"
              : "bg-ui-panel/85 text-ui-text border-ui-line hover:bg-ui-hover"
          }`}
          title={following ? "Camera is locked on this agent — drag the map to release" : "Lock the camera on this agent"}
        >
          {following ? "🔒 Following" : "🎥 Follow"}
        </button>
      )}
    </div>
  );
});
