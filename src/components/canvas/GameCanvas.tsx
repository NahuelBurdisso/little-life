import { useEffect, useRef } from "react";
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { useGameCanvas } from "../../hooks/useGameCanvas";
import { TilemapRenderer } from "./TilemapRenderer";
import { CameraController } from "./CameraController";
import { DayNightCycle } from "./DayNightCycle";
import { WeatherEffects } from "./WeatherEffects";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";

interface GameCanvasProps {
  agents: any[];
  world: any;
  conversations: any[];
  onAgentSelect: (agentId: string) => void;
  onAgentContextMenu: (agentId: string, pos: { x: number; y: number }) => void;
  onAgentHover: (agentId: string | null, pos?: { x: number; y: number }) => void;
  selectedAgentId: string | null;
}

const AGENT_LABEL_STYLE = new TextStyle({
  fontFamily: "monospace",
  fontSize: 9,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: "center",
});

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

  // Refs for subsystems
  const tilemapRef = useRef<TilemapRenderer | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const dayNightRef = useRef<DayNightCycle | null>(null);
  const weatherRef = useRef<WeatherEffects | null>(null);

  // Layer containers
  const worldContainerRef = useRef<Container | null>(null);
  const agentContainerRef = useRef<Container | null>(null);

  // Agent sprite tracking
  const agentSpritesRef = useRef<
    Map<string, { container: Container; highlight: Graphics; bubble: Graphics | null; targetX: number; targetY: number }>
  >(new Map());

  // Initialize subsystems when app is ready
  useEffect(() => {
    if (!app) return;

    // Create layer hierarchy
    const worldContainer = new Container();
    const agentContainer = new Container();

    worldContainerRef.current = worldContainer;
    agentContainerRef.current = agentContainer;

    app.stage.addChild(worldContainer);

    // Tilemap
    const tilemap = new TilemapRenderer(app);
    worldContainer.addChild(tilemap.container);
    tilemapRef.current = tilemap;

    // Agent container goes inside world so it moves with camera
    worldContainer.addChild(agentContainer);

    // Camera
    const camera = new CameraController(app, worldContainer);
    cameraRef.current = camera;

    // Day/night overlay (on stage, above world)
    const dayNight = new DayNightCycle(app);
    dayNightRef.current = dayNight;

    // Weather (on stage, above world but below day/night)
    const weather = new WeatherEffects(app);
    weatherRef.current = weather;

    // Animation loop
    app.ticker.add((ticker) => {
      const delta = ticker.deltaTime;

      // Smooth camera
      camera.update(delta);

      // Interpolate agent positions
      const sprites = agentSpritesRef.current;
      for (const [, entry] of sprites) {
        const lerp = Math.min(1, delta * 0.08);
        entry.container.x += (entry.targetX - entry.container.x) * lerp;
        entry.container.y += (entry.targetY - entry.container.y) * lerp;
      }
    });

    return () => {
      camera.destroy();
      dayNight.destroy();
      weather.destroy();
      tilemap.destroy();
      agentSpritesRef.current.clear();
      worldContainer.destroy({ children: true });
    };
  }, [app]);

  // Update agent positions
  useEffect(() => {
    if (!app || !agentContainerRef.current) return;

    const agentContainer = agentContainerRef.current;
    const sprites = agentSpritesRef.current;
    const activeIds = new Set<string>();

    for (const agent of agents) {
      const id = agent._id ?? agent.id;
      if (!id) continue;
      activeIds.add(id);

      const px = (agent.position?.x ?? 0) * SPRITE_CONFIG.TILE_SIZE;
      const py = (agent.position?.y ?? 0) * SPRITE_CONFIG.TILE_SIZE;

      if (sprites.has(id)) {
        // Update target for interpolation
        const entry = sprites.get(id)!;
        entry.targetX = px;
        entry.targetY = py;

        // Update selection highlight
        entry.highlight.visible = id === selectedAgentId;
      } else {
        // Create new agent sprite placeholder
        const agentGroup = new Container();
        agentGroup.x = px;
        agentGroup.y = py;
        agentGroup.eventMode = "static";
        agentGroup.cursor = "pointer";

        // Selection highlight ring
        const highlight = new Graphics();
        highlight.circle(SPRITE_CONFIG.AGENT_SIZE / 2, SPRITE_CONFIG.AGENT_SIZE / 2, SPRITE_CONFIG.AGENT_SIZE / 2 + 4)
          .stroke({ color: 0xffdd44, width: 2, alpha: 0.8 });
        highlight.visible = id === selectedAgentId;
        agentGroup.addChild(highlight);

        // Agent body (colored circle placeholder - Task 20 replaces with real sprites)
        const body = new Graphics();
        const hue = hashStringToHue(agent.name ?? id);
        const bodyColor = hslToHex(hue, 0.6, 0.5);
        body
          .circle(SPRITE_CONFIG.AGENT_SIZE / 2, SPRITE_CONFIG.AGENT_SIZE / 2, SPRITE_CONFIG.AGENT_SIZE / 2 - 2)
          .fill(bodyColor);
        body
          .circle(SPRITE_CONFIG.AGENT_SIZE / 2, SPRITE_CONFIG.AGENT_SIZE / 2, SPRITE_CONFIG.AGENT_SIZE / 2 - 2)
          .stroke({ color: 0x000000, width: 1, alpha: 0.3 });
        agentGroup.addChild(body);

        // Name label
        const name = agent.name ?? "Agent";
        const label = new Text({ text: name, style: AGENT_LABEL_STYLE });
        label.anchor.set(0.5, 0);
        label.x = SPRITE_CONFIG.AGENT_SIZE / 2;
        label.y = SPRITE_CONFIG.AGENT_SIZE + 2;
        agentGroup.addChild(label);

        // Click handler
        agentGroup.on("pointertap", () => onAgentSelect(id));
        agentGroup.on("pointerover", (e) => {
          onAgentHover(id, { x: e.global.x, y: e.global.y });
        });
        agentGroup.on("pointerout", () => {
          onAgentHover(null);
        });
        agentGroup.on("rightclick", (e) => {
          e.preventDefault?.();
          onAgentContextMenu(id, { x: e.global.x, y: e.global.y });
        });

        agentContainer.addChild(agentGroup);
        sprites.set(id, { container: agentGroup, highlight, bubble: null, targetX: px, targetY: py });
      }
    }

    // Remove agents that are no longer active
    for (const [id, entry] of sprites) {
      if (!activeIds.has(id)) {
        entry.container.destroy({ children: true });
        sprites.delete(id);
      }
    }
  }, [agents, selectedAgentId, app, onAgentSelect, onAgentContextMenu, onAgentHover]);

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
    // Weather update runs in ticker, but we update state here
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
    if (!selectedAgentId || !cameraRef.current) return;
    const entry = agentSpritesRef.current.get(selectedAgentId);
    if (entry) {
      cameraRef.current.focusOn(entry.targetX, entry.targetY);
    }
  }, [selectedAgentId]);

  // Conversation bubbles (simple text indicators above agents)
  useEffect(() => {
    if (!app || !agentContainerRef.current) return;

    // Clear old bubbles
    const sprites = agentSpritesRef.current;
    for (const [, entry] of sprites) {
      if (entry.bubble) {
        entry.bubble.destroy();
        entry.bubble = null;
      }
    }

    // Add bubbles for agents in conversations
    if (!conversations) return;
    const agentsInConvo = new Set<string>();
    for (const convo of conversations) {
      for (const participant of convo.participants ?? []) {
        const pid = typeof participant === "string" ? participant : participant?.agentId;
        if (pid) agentsInConvo.add(pid);
      }
    }

    for (const id of agentsInConvo) {
      const entry = sprites.get(id);
      if (!entry) continue;

      const bubble = new Graphics();
      // Speech bubble indicator
      bubble
        .roundRect(-12, -22, 24, 16, 4)
        .fill({ color: 0xffffff, alpha: 0.9 });
      bubble
        .roundRect(-12, -22, 24, 16, 4)
        .stroke({ color: 0x000000, width: 1, alpha: 0.3 });
      // Dots to indicate talking
      bubble.circle(-4, -14, 2).fill(0x666666);
      bubble.circle(0, -14, 2).fill(0x666666);
      bubble.circle(4, -14, 2).fill(0x666666);
      bubble.x = SPRITE_CONFIG.AGENT_SIZE / 2;
      bubble.y = 0;
      entry.container.addChild(bubble);
      entry.bubble = bubble;
    }
  }, [conversations, app]);

  return (
    <div
      ref={containerRef}
      className="flex-1 w-full h-full"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// Utility: hash a string to a hue value (0-360)
function hashStringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

// Utility: HSL to hex color number
function hslToHex(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);

  return (ri << 16) | (gi << 8) | bi;
}
