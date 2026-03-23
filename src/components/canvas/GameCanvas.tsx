import { useEffect, useRef, useCallback } from "react";
import { Container } from "pixi.js";
import { useGameCanvas } from "../../hooks/useGameCanvas";
import { useAssetLoader } from "../../hooks/useAssetLoader";
import { TilemapRenderer } from "./TilemapRenderer";
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
  onAgentSelect: (agentId: string) => void;
  onAgentContextMenu: (agentId: string, pos: { x: number; y: number }) => void;
  onAgentHover: (agentId: string | null, pos?: { x: number; y: number }) => void;
  selectedAgentId: string | null;
}

export function GameCanvas({
  agents,
  world,
  conversations,
  onAgentSelect,
  onAgentContextMenu,
  onAgentHover,
  selectedAgentId,
}: GameCanvasProps) {
  const { app, containerRef } = useGameCanvas();
  const assetsLoaded = useAssetLoader(app);

  // Refs for subsystems
  const tilemapRef = useRef<TilemapRenderer | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const dayNightRef = useRef<DayNightCycle | null>(null);
  const weatherRef = useRef<WeatherEffects | null>(null);
  const spritePoolRef = useRef<SpritePool | null>(null);
  const bubbleSystemRef = useRef<BubbleSystem | null>(null);
  const interactionRef = useRef<InteractionLayer | null>(null);

  // Layer containers
  const worldContainerRef = useRef<Container | null>(null);

  // Stable callback refs so the interaction layer doesn't go stale
  const callbacksRef = useRef({ onAgentSelect, onAgentContextMenu, onAgentHover });
  callbacksRef.current = { onAgentSelect, onAgentContextMenu, onAgentHover };

  const stableOnSelect = useCallback((id: string) => callbacksRef.current.onAgentSelect(id), []);
  const stableOnHover = useCallback((id: string | null, pos?: { x: number; y: number }) => callbacksRef.current.onAgentHover(id, pos), []);
  const stableOnContext = useCallback((id: string, pos: { x: number; y: number }) => callbacksRef.current.onAgentContextMenu(id, pos), []);

  // Initialize subsystems when app is ready
  useEffect(() => {
    if (!app || !assetsLoaded) return;

    // Create layer hierarchy
    const worldContainer = new Container();
    worldContainer.eventMode = "passive";
    worldContainer.interactiveChildren = true;
    worldContainerRef.current = worldContainer;
    app.stage.addChild(worldContainer);

    // Tilemap
    const tilemap = new TilemapRenderer(app);
    worldContainer.addChild(tilemap.container);
    tilemapRef.current = tilemap;

    // Sprite pool (agent sprites) — inside world so it moves with camera
    const spritePool = new SpritePool(worldContainer);
    spritePoolRef.current = spritePool;

    // Bubble system — also inside world container so bubbles track agents
    const bubbleSystem = new BubbleSystem(worldContainer);
    bubbleSystemRef.current = bubbleSystem;

    // Camera
    const camera = new CameraController(app, worldContainer);
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
    interaction.setup(app);
    interactionRef.current = interaction;

    // Animation loop
    app.ticker.add((ticker) => {
      const delta = ticker.deltaTime;
      camera.update(delta);
    });

    return () => {
      interaction.destroy();
      camera.destroy();
      dayNight.destroy();
      weather.destroy();
      tilemap.destroy();
      spritePool.destroy();
      bubbleSystem.destroy();
      worldContainer.destroy({ children: true });
    };
  }, [app, assetsLoaded, stableOnSelect, stableOnHover, stableOnContext]);

  // Update sprite targets when Convex data changes (sets targets, creates/removes sprites)
  useEffect(() => {
    if (!app || !spritePoolRef.current) return;

    const spritePool = spritePoolRef.current;
    // Set target positions on all sprites (they'll lerp toward these per-frame)
    spritePool.update(agents, 1, selectedAgentId);

    // Rebind interaction events for any new sprites
    interactionRef.current?.updateBindings(spritePool.getAllIds());

    // Update bubbles with latest data
    if (bubbleSystemRef.current) {
      bubbleSystemRef.current.update(conversations ?? [], agents, 1);
    }
  }, [agents, selectedAgentId, conversations, app]);

  // Per-frame rendering loop — lerps sprites toward targets, no data dependency
  useEffect(() => {
    if (!app) return;

    const tickFn = (ticker: any) => {
      const delta = ticker.deltaTime;
      // Lerp all sprites toward their targets each frame
      spritePoolRef.current?.lerpAll(delta);
    };

    app.ticker.add(tickFn);
    return () => {
      app.ticker.remove(tickFn);
    };
  }, [app]);

  // Update day/night cycle
  useEffect(() => {
    if (!app || !dayNightRef.current) return;
    const dayPhase = world?.dayPhase ?? "morning";
    const w = app.renderer.width;
    const h = app.renderer.height;
    dayNightRef.current.update(dayPhase, w, h);
  }, [world?.dayPhase, app]);

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

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 h-full overflow-hidden relative"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
