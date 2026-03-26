import { useEffect, useRef, useCallback } from "react";
import { Container, Graphics } from "pixi.js";
import { useGameCanvas } from "../../hooks/useGameCanvas";
import { useAssetLoader } from "../../hooks/useAssetLoader";
import { TilemapRenderer } from "./TilemapRenderer";
import { BuildingRenderer } from "./BuildingRenderer";
import { CameraController } from "./CameraController";
import { DayNightCycle } from "./DayNightCycle";
import { WeatherEffects } from "./WeatherEffects";
import { SpritePool } from "./SpritePool";
import { BubbleSystem } from "./BubbleSystem";
import { InteractionLayer } from "./InteractionLayer";

interface GameCanvasProps {
  agents: any[];
  world: any;
  conversations: any[];
  locations?: any[];
  relationships?: any[];
  onAgentSelect: (agentId: string) => void;
  onAgentContextMenu: (agentId: string, pos: { x: number; y: number }) => void;
  onAgentHover: (agentId: string | null, pos?: { x: number; y: number }) => void;
  selectedAgentId: string | null;
}

export function GameCanvas({
  agents,
  world,
  conversations,
  locations,
  relationships,
  onAgentSelect,
  onAgentContextMenu,
  onAgentHover,
  selectedAgentId,
}: GameCanvasProps) {
  const { app, containerRef } = useGameCanvas();
  const assetsLoaded = useAssetLoader();

  // Refs for subsystems
  const tilemapRef = useRef<TilemapRenderer | null>(null);
  const buildingRendererRef = useRef<BuildingRenderer | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const dayNightRef = useRef<DayNightCycle | null>(null);
  const weatherRef = useRef<WeatherEffects | null>(null);
  const spritePoolRef = useRef<SpritePool | null>(null);
  const bubbleSystemRef = useRef<BubbleSystem | null>(null);
  const interactionRef = useRef<InteractionLayer | null>(null);
  const relationshipLinesRef = useRef<Graphics | null>(null);
  const tensionLinesRef = useRef<Graphics | null>(null);
  const pathTrailRef = useRef<Graphics | null>(null);

  // Layer containers
  const worldContainerRef = useRef<Container | null>(null);

  // Stable locations ref so the init effect can read the latest value without re-running
  const locationsRef = useRef(locations);
  locationsRef.current = locations;

  // Stable data refs so the per-frame ticker can access latest conversations/agents
  const conversationsRef = useRef(conversations);
  const agentsRef = useRef(agents);

  // Update refs when data changes
  useEffect(() => {
    conversationsRef.current = conversations;
    agentsRef.current = agents;
  }, [conversations, agents]);

  // Stable callback refs so the interaction layer doesn't go stale
  const callbacksRef = useRef({ onAgentSelect, onAgentContextMenu, onAgentHover });
  callbacksRef.current = { onAgentSelect, onAgentContextMenu, onAgentHover };

  const stableOnSelect = useCallback((id: string) => callbacksRef.current.onAgentSelect(id), []);
  const stableOnHover = useCallback((id: string | null, pos?: { x: number; y: number }) => callbacksRef.current.onAgentHover(id, pos), []);
  const stableOnContext = useCallback((id: string, pos: { x: number; y: number }) => callbacksRef.current.onAgentContextMenu(id, pos), []);

  // Initialize subsystems when app is ready
  useEffect(() => {
    if (!app || !assetsLoaded.loaded) return;

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

    // If location data already arrived before the app was ready, initialize now
    const currentLocations = locationsRef.current;
    if (currentLocations && currentLocations.length > 0) {
      buildingRenderer.init(currentLocations);
    }

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

    // Sprite pool (agent circles) — inside world so it moves with camera
    const spritePool = new SpritePool(worldContainer);
    spritePoolRef.current = spritePool;

    // Relationship lines graphics — between sprites and bubbles
    const relLines = new Graphics();
    relLines.eventMode = 'none'; // transparent to clicks
    worldContainer.addChild(relLines);
    relationshipLinesRef.current = relLines;

    // Bubble system — also inside world container so bubbles track agents
    const bubbleSystem = new BubbleSystem(worldContainer);
    bubbleSystemRef.current = bubbleSystem;

    // Camera — set actual map dimensions from tilemap
    const camera = new CameraController(app, worldContainer);
    const mapSize = tilemap.getMapSize();
    camera.setMapSize(mapSize.width, mapSize.height);
    cameraRef.current = camera;

    // Day/night overlay (on stage, above world)
    const dayNight = new DayNightCycle(app);
    dayNightRef.current = dayNight;

    // Weather (on stage, above world but below day/night)
    const weather = new WeatherEffects(app);
    weatherRef.current = weather;

    // Interaction layer
    const interaction = new InteractionLayer(spritePool, {
      onAgentSelect: stableOnSelect,
      onAgentHover: stableOnHover,
      onAgentContextMenu: stableOnContext,
    });
    interaction.setup(app, worldContainer);
    interactionRef.current = interaction;

    // Animation loop — store ref for cleanup
    const cameraTickFn = (ticker: any) => {
      camera.update(ticker.deltaTime);
    };
    app.ticker.add(cameraTickFn);

    return () => {
      app.ticker.remove(cameraTickFn);
      interaction.destroy();
      camera.destroy();
      dayNight.destroy();
      weather.destroy();
      tilemap.destroy();
      buildingRenderer.destroy();
      spritePool.destroy();
      tensionLines.destroy();
      pathTrail.destroy();
      bubbleSystem.destroy();
      worldContainer.destroy({ children: true });
    };
  }, [app, assetsLoaded.loaded, stableOnSelect, stableOnHover, stableOnContext]);

  // Initialize BuildingRenderer with location data when locations are available
  useEffect(() => {
    if (!buildingRendererRef.current || !locations || locations.length === 0) return;
    buildingRendererRef.current.init(locations);
  }, [locations]);

  // Update sprite targets when server data changes (sets targets, creates/removes sprites)
  useEffect(() => {
    if (!app || !spritePoolRef.current) return;

    const spritePool = spritePoolRef.current;
    // Set target positions on all sprites (they'll lerp toward these per-frame)
    spritePool.update(agents, 1, selectedAgentId);

    // Rebind interaction events for any new sprites
    interactionRef.current?.updateBindings(spritePool.getAllIds());

    // Update occupancy dots on tilemap
    if (tilemapRef.current && locations) {
      tilemapRef.current.updateOccupancy(agents, locations);
    }

    // Update BuildingRenderer with current agent locations
    if (buildingRendererRef.current) {
      const agentLocations = new Map<number, number | null>();
      for (const agent of agents) {
        agentLocations.set(agent.id, agent.current_location ?? null);
      }
      buildingRendererRef.current.update(agentLocations);
    }
  }, [agents, selectedAgentId, conversations, locations, app]);

  // Per-frame rendering loop — lerps sprites toward targets, no data dependency
  useEffect(() => {
    if (!app) return;

    const tickFn = (ticker: any) => {
      const delta = ticker.deltaTime;
      // Lerp all sprites toward their targets each frame
      spritePoolRef.current?.lerpAll(delta);
      // Update bubbles per-frame so expiry and emote float animation run smoothly
      if (bubbleSystemRef.current && spritePoolRef.current) {
        bubbleSystemRef.current.update(
          conversationsRef.current ?? [],
          agentsRef.current ?? [],
          delta / 60, // convert PIXI ticker delta to seconds
          spritePoolRef.current
        );
      }
    };

    app.ticker.add(tickFn);
    return () => {
      app.ticker.remove(tickFn);
    };
  }, [app]);

  // Update day/night cycle
  useEffect(() => {
    if (!app || !dayNightRef.current) return;
    const dayPhase = world?.day_phase ?? "morning";
    const w = app.renderer.width;
    const h = app.renderer.height;
    dayNightRef.current.update(dayPhase, w, h);
  }, [world?.day_phase, app]);

  // Update weather effects
  useEffect(() => {
    if (!app || !weatherRef.current) return;
    const weather = world?.weather ?? "sunny";
    const w = app.renderer.width;
    const h = app.renderer.height;
    const weatherSystem = weatherRef.current;
    const weatherTick = (ticker: any) => {
      weatherSystem.update(weather, w, h, ticker.deltaTime);
    };
    app.ticker.add(weatherTick);
    return () => {
      app.ticker.remove(weatherTick);
    };
  }, [world?.weather, app]);

  // Focus camera on selected agent
  useEffect(() => {
    if (!selectedAgentId || !cameraRef.current || !spritePoolRef.current) return;
    const sprite = spritePoolRef.current.getSprite(selectedAgentId);
    if (sprite) {
      cameraRef.current.focusOn(sprite.container.x, sprite.container.y);
    }
  }, [selectedAgentId]);

  // Draw relationship lines, tension lines, and path trail
  useEffect(() => {
    const g = relationshipLinesRef.current;
    const tg = tensionLinesRef.current;
    const pg = pathTrailRef.current;
    if (!g) return;
    g.clear();
    tg?.clear();
    pg?.clear();

    // --- Tension lines: always-on faint lines for dramatic relationships ---
    if (tg && spritePoolRef.current && relationships && relationships.length > 0) {
      for (const rel of relationships) {
        let color = 0;
        let shouldDraw = false;

        if (rel.status === 'partners') { color = 0xec4899; shouldDraw = true; }
        else if ((rel.tags as string[])?.includes('grudge')) { color = 0x991b1b; shouldDraw = true; }
        else if (rel.status === 'rivals' || rel.status === 'enemies') { color = 0xef4444; shouldDraw = true; }

        if (!shouldDraw) continue;

        const spriteA = spritePoolRef.current.getSprite(String(rel.agent_a));
        const spriteB = spritePoolRef.current.getSprite(String(rel.agent_b));
        if (!spriteA || !spriteB) continue;

        // Brighten if either agent is selected
        const isSelected = String(rel.agent_a) === selectedAgentId || String(rel.agent_b) === selectedAgentId;
        const alpha = isSelected ? 0.6 : 0.15;

        tg.moveTo(spriteA.container.x, spriteA.container.y)
          .lineTo(spriteB.container.x, spriteB.container.y)
          .stroke({ color, alpha, width: 1.5 });
      }
    }

    // --- Path trail: show A* path for selected agent ---
    if (pg && selectedAgentId && agents) {
      const agent = agents.find((a: any) => String(a.id) === selectedAgentId);
      if (agent?.current_path && (agent.current_path as number[][]).length > 0) {
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
      }
    }

    // --- Selected agent relationship lines (detailed, with strength-based alpha) ---
    const agentId = selectedAgentId;
    if (!agentId || !spritePoolRef.current || !relationships || relationships.length === 0) return;

    const rels = relationships.filter((r: any) => String(r.agent_a) === agentId || String(r.agent_b) === agentId);
    for (const rel of rels) {
      const otherId = String(rel.agent_a) === agentId ? String(rel.agent_b) : String(rel.agent_a);
      const fromSprite = spritePoolRef.current.getSprite(agentId);
      const toSprite = spritePoolRef.current.getSprite(otherId);
      if (!fromSprite || !toSprite) continue;
      const strength = Math.max(Math.abs(rel.friendship_ab ?? 0), Math.abs(rel.romance_ab ?? 0));
      const alpha = Math.min((strength / 100) * 0.6, 0.6);
      const color =
        (rel.romance_ab ?? 0) > (rel.friendship_ab ?? 0)
          ? 0xf472b6
          : (rel.friendship_ab ?? 0) < 0
          ? 0xef4444
          : 0x60a5fa;
      g.moveTo(fromSprite.container.x + 16, fromSprite.container.y + 32)
       .lineTo(toSprite.container.x + 16, toSprite.container.y + 32)
       .stroke({ color, alpha, width: 1 });
    }
  }, [selectedAgentId, agents, relationships]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 h-full overflow-hidden relative"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
