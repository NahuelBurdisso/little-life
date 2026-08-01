import {
  Application, Container, Graphics, RenderTexture, Sprite,
} from 'pixi.js';
import { OUTDOOR_TYPES } from '../../../server/lib/worldgen/buildingTemplates';
import { southWindowXs, WINDOW_CENTER_ABOVE_SOUTH_EDGE } from './BuildingRenderer';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LightSource {
  x: number;
  y: number;
  radius: number;
  color: number;
  intensity: number;
  flicker: number;
}

interface AmbientProfile {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

interface LocationData {
  id: number;
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
  current_occupants: number[];
  operating_hours?: { open: number; close: number } | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SCALE = 8;  // Lightmap at 1/8 resolution

// Radial gradient approximation: concentric circles with decreasing alpha.
// Alphas accumulate additively toward the center, giving a roughly quadratic
// falloff — the old 3-step version produced visible hard rings where pools met
// dark ground (fresh-eyes audit r27). Module scope: `render` walks every light
// every frame, so a literal inside that loop allocated N arrays per frame.
const RING_ALPHAS = [0.35, 0.25, 0.18, 0.12, 0.07, 0.04];

const PHASE_AMBIENT: Record<string, AmbientProfile> = {
  dawn:      { r: 255, g: 212, b: 160, brightness: 0.65 },
  morning:   { r: 255, g: 248, b: 240, brightness: 0.95 },
  afternoon: { r: 255, g: 250, b: 230, brightness: 1.0 },
  evening:   { r: 255, g: 160, b: 96,  brightness: 0.55 },
  night:     { r: 100, g: 110, b: 150, brightness: 0.45 },
};

const SEASON_TINT: Record<string, { r: number; g: number; b: number; mix: number }> = {
  spring: { r: 224, g: 255, b: 224, mix: 0.05 },
  summer: { r: 255, g: 250, b: 224, mix: 0.03 },
  autumn: { r: 255, g: 224, b: 160, mix: 0.08 },
  winter: { r: 208, g: 232, b: 255, mix: 0.10 },
};

const WEATHER_MODS: Record<string, {
  brightnessMul: number;
  radiusMul: number;
  flickerMul: number;
  tintR?: number;
  tintG?: number;
  tintB?: number;
  tintMix?: number;
}> = {
  sunny:  { brightnessMul: 1.0,  radiusMul: 1.0, flickerMul: 1.0 },
  cloudy: { brightnessMul: 0.85, radiusMul: 1.0, flickerMul: 1.0 },
  rainy:  { brightnessMul: 0.7,  radiusMul: 0.9, flickerMul: 1.5, tintR: 180, tintG: 200, tintB: 230, tintMix: 0.06 },
  stormy: { brightnessMul: 0.5,  radiusMul: 0.85, flickerMul: 2.0 },
  foggy:  { brightnessMul: 0.75, radiusMul: 0.6, flickerMul: 0.5, tintR: 200, tintG: 200, tintB: 210, tintMix: 0.1 },
  snowy:  { brightnessMul: 0.8,  radiusMul: 0.8, flickerMul: 0.8, tintR: 220, tintG: 230, tintB: 255, tintMix: 0.08 },
  windy:  { brightnessMul: 0.9,  radiusMul: 1.0, flickerMul: 2.5 },
  hot:    { brightnessMul: 1.0,  radiusMul: 1.0, flickerMul: 1.2, tintR: 255, tintG: 240, tintB: 200, tintMix: 0.04 },
};

const BUILDING_LIGHT: Record<string, {
  color: number; radius: number; intensity: number; flicker: number;
  needsOccupants: boolean; nightOnly: boolean;
}> = {
  home:      { color: 0xFFE0A0, radius: 48, intensity: 0.7, flicker: 0.08, needsOccupants: true,  nightOnly: true },
  tavern:    { color: 0xFFCC66, radius: 72, intensity: 0.9, flicker: 0.12, needsOccupants: false, nightOnly: true },
  shop:      { color: 0xFFF0D0, radius: 56, intensity: 0.6, flicker: 0.04, needsOccupants: true,  nightOnly: false },
  clinic:    { color: 0xF0FFF0, radius: 48, intensity: 0.5, flicker: 0.0,  needsOccupants: false, nightOnly: false },
  bakery:    { color: 0xFFD080, radius: 48, intensity: 0.7, flicker: 0.06, needsOccupants: false, nightOnly: false },
  workshop:  { color: 0xFFE8C0, radius: 40, intensity: 0.5, flicker: 0.1,  needsOccupants: false, nightOnly: false },
  town_hall: { color: 0xFFF8E0, radius: 56, intensity: 0.6, flicker: 0.0,  needsOccupants: false, nightOnly: false },
  prison:    { color: 0xCCDDCC, radius: 32, intensity: 0.3, flicker: 0.0,  needsOccupants: false, nightOnly: false },
  divebar:   { color: 0xFFAA44, radius: 56, intensity: 0.7, flicker: 0.15, needsOccupants: false, nightOnly: true },
  pawnshop:  { color: 0xFFE8C0, radius: 40, intensity: 0.4, flicker: 0.05, needsOccupants: false, nightOnly: false },
};

// Was a hand-maintained local copy that had drifted: it omitted `farmyard` and
// `market_square`, so those got building lights and window glow despite having
// no walls. Shared with the generator and the other renderers now.
const OPEN_AREA_TYPES = OUTDOOR_TYPES;

// ─── Window Glow ─────────────────────────────────────────────────────────────
// Small warm rects flanking the door on building facades.
// Visible only when (occupied OR !needsOccupants) AND night phase.
// Rendered as two small point lights offset left/right of the entry_point.
const WINDOW_GLOW_COLOR = 0xFFD9A0;
const WINDOW_GLOW_RADIUS = 14;
const WINDOW_GLOW_INTENSITY = 0.35;
const WINDOW_GLOW_FLICKER = 0.06;
// Which building types render window glow (all enclosed buildings)
const WINDOW_GLOW_TYPES = new Set([
  'home', 'shop', 'tavern', 'clinic', 'town_hall',
  'bakery', 'workshop', 'prison', 'divebar', 'pawnshop',
]);

// ─── Emissive Lights (forge + oven) ──────────────────────────────────────────
// Strong warm-colored lights emitted at furniture tile positions.
// tile: [col, row] in interior grid — converted to world px as:
//   worldX = building.x + col * TILE_SIZE + TILE_SIZE/2
//   worldY = building.y + row * TILE_SIZE + TILE_SIZE/2
const INTERIOR_TILE_SIZE = 32;

interface EmissiveDef {
  buildingType: string;
  furnitureTile: [number, number]; // [col, row]
  color: number;
  radius: number;
  intensity: number;
  flicker: number;
  /** If true, only active during operating hours (checked against loc.operating_hours) */
  operatingHoursOnly: boolean;
}

const EMISSIVE_DEFS: EmissiveDef[] = [
  // Workshop forge — tile [3,2] — always-on warm red, high flicker
  {
    buildingType: 'workshop',
    furnitureTile: [3, 2],
    color: 0xFF8040,
    radius: 64,
    intensity: 0.7,
    flicker: 0.22,
    operatingHoursOnly: false,
  },
  // Bakery oven — tile [1,1] — warm amber, moderate flicker, operating hours only
  {
    buildingType: 'bakery',
    furnitureTile: [1, 1],
    color: 0xFFA050,
    radius: 48,
    intensity: 0.6,
    flicker: 0.10,
    operatingHoursOnly: true,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rgbToHex(r: number, g: number, b: number): number {
  return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
}

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF];
}

// ─── LightingSystem ──────────────────────────────────────────────────────────

export class LightingSystem {
  private app: Application;
  private lightmapTexture: RenderTexture | null = null;
  private lightmapSprite: Sprite;
  private lightGfx: Graphics;        // Draws lights onto the lightmap
  private ambientGfx: Graphics;      // Fills ambient darkness
  private lightContainer: Container;  // Holds ambient + lights for rendering to texture

  // Current state
  private currentAmbient: AmbientProfile = { ...PHASE_AMBIENT.morning };
  private targetAmbient: AmbientProfile = { ...PHASE_AMBIENT.morning };
  private lerpProgress = 1.0;

  // Cached light sources (rebuilt on data update, not per frame)
  private buildingLights: LightSource[] = [];
  private streetLights: LightSource[] = [];
  private agentLights: LightSource[] = [];
  private eventLights: LightSource[] = [];
  /** Scratch buffer for `render`'s combined light list — reused every frame. */
  private allLights: LightSource[] = [];

  // Lightning state
  private lightningTimer = 0;
  private lightningIntensity = 0;

  // Dimensions
  private lmW = 1;
  private lmH = 1;

  private lastPhase = '';
  private isNightish = false;

  constructor(app: Application, _worldContainer: Container) {
    this.app = app;

    // Off-screen container for rendering the lightmap
    this.lightContainer = new Container();
    this.ambientGfx = new Graphics();
    this.lightGfx = new Graphics();
    this.lightContainer.addChild(this.ambientGfx);
    this.lightContainer.addChild(this.lightGfx);

    // Sprite that displays the lightmap over the scene
    this.lightmapSprite = new Sprite();
    this.lightmapSprite.blendMode = 'multiply';
    this.lightmapSprite.eventMode = 'none';

    // Add on top of everything in stage (same position as old DayNightCycle)
    app.stage.addChild(this.lightmapSprite);
  }

  setRoadTiles(roads: Array<{ x: number; y: number }>) {
    // Place street lamps at road tiles that are spaced apart
    this.streetLights = [];
    if (roads.length === 0) return;

    // Sample every ~6 tiles along roads for lamp placement
    const placed = new Set<string>();
    for (let i = 0; i < roads.length; i += 6) {
      const tile = roads[i];
      const key = `${Math.floor(tile.x / 6)},${Math.floor(tile.y / 6)}`;
      if (placed.has(key)) continue;
      placed.add(key);
      this.streetLights.push({
        x: tile.x * 32 + 16,
        y: tile.y * 32 + 16,
        radius: 64,
        color: 0xFFE0A0,
        intensity: 0.38,
        flicker: 0.06,
      });
    }
  }

  /**
   * Called per data tick (when agents/world state changes).
   * Rebuilds light source lists from current state.
   */
  update(
    agents: Array<{ id: number; position: { x: number; y: number }; current_location: number | null; activeStates?: Array<{ type: string }> }>,
    world: { day_phase: string; weather: string; time: { season: string; hour: number } },
    locations: LocationData[],
    activeEvents: string[],
  ) {
    const phase = world.day_phase || 'morning';
    const hour = world.time?.hour ?? 12;
    this.isNightish = phase === 'night' || phase === 'evening' || phase === 'dawn';

    // `locations.getAll` is fetched once and never invalidated, so
    // `loc.current_occupants` is a permanently empty snapshot — gating on it
    // meant homes never lit up and never showed window glow. The agent list is
    // live, so derive occupancy from it.
    const occupiedLocations = new Set<number>();
    for (const a of agents) {
      if (a.current_location != null) occupiedLocations.add(a.current_location);
    }

    // Ambient transition
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.targetAmbient = { ...(PHASE_AMBIENT[phase] ?? PHASE_AMBIENT.morning) };

      // Apply season tint
      const season = world.time?.season ?? 'spring';
      const st = SEASON_TINT[season];
      if (st) {
        this.targetAmbient.r = lerp(this.targetAmbient.r, st.r, st.mix);
        this.targetAmbient.g = lerp(this.targetAmbient.g, st.g, st.mix);
        this.targetAmbient.b = lerp(this.targetAmbient.b, st.b, st.mix);
      }

      // Apply weather brightness + tint
      const wm = WEATHER_MODS[world.weather] ?? WEATHER_MODS.sunny;
      this.targetAmbient.brightness *= wm.brightnessMul;
      if (wm.tintR != null && wm.tintMix != null) {
        this.targetAmbient.r = lerp(this.targetAmbient.r, wm.tintR!, wm.tintMix!);
        this.targetAmbient.g = lerp(this.targetAmbient.g, wm.tintG!, wm.tintMix!);
        this.targetAmbient.b = lerp(this.targetAmbient.b, wm.tintB!, wm.tintMix!);
      }

      this.lerpProgress = 0;
    }

    const weatherMod = WEATHER_MODS[world.weather] ?? WEATHER_MODS.sunny;

    // ── Building lights ────────────────────────────────────────────────
    this.buildingLights = [];
    for (const loc of locations) {
      if (OPEN_AREA_TYPES.has(loc.type)) {
        // Town square gets ambient light at night
        if (loc.type === 'town_square' && this.isNightish) {
          const cx = loc.position.x + loc.position.width / 2;
          const cy = loc.position.y + loc.position.height / 2;
          this.buildingLights.push({
            x: cx, y: cy,
            radius: 80 * weatherMod.radiusMul,
            color: 0xFFE8B0,
            intensity: 0.4,
            flicker: 0.08 * weatherMod.flickerMul,
          });
        }
        continue;
      }

      const def = BUILDING_LIGHT[loc.type];
      if (!def) continue;

      // Check conditions
      if (def.nightOnly && !this.isNightish) continue;
      if (def.needsOccupants && !occupiedLocations.has(loc.id)) continue;

      // Non-nightOnly lights: gate by operating hours AND require it to be
      // dark enough (evening/dawn/night) to avoid visible blobs at full
      // daytime brightness (morning/afternoon ~1.0 multiply overlay means
      // additive light circles show as warm spots — the "day blob" bug).
      if (!def.nightOnly) {
        // Only draw during low-light phases
        if (!this.isNightish && phase !== 'evening' && phase !== 'dawn') continue;
        if (loc.operating_hours) {
          const { open, close } = loc.operating_hours;
          if (hour < open || hour >= close) continue;
        }
      }

      this.buildingLights.push({
        x: loc.entry_point.x,
        y: loc.entry_point.y,
        radius: def.radius * weatherMod.radiusMul,
        color: def.color,
        intensity: def.intensity,
        flicker: def.flicker * weatherMod.flickerMul,
      });
    }

    // ── Window glow: two small warm lights flanking door, night only ────
    if (this.isNightish) {
      for (const loc of locations) {
        if (OPEN_AREA_TYPES.has(loc.type)) continue;
        if (!WINDOW_GLOW_TYPES.has(loc.type)) continue;

        // Gate: home requires occupants; all others always glow at night
        const bgDef = BUILDING_LIGHT[loc.type];
        const needsOcc = bgDef?.needsOccupants ?? false;
        if (needsOcc && !occupiedLocations.has(loc.id)) continue;

        // Also respect operating hours for non-residential types that have them
        if (loc.operating_hours && loc.type !== 'home') {
          const { open, close } = loc.operating_hours;
          if (hour < open || hour >= close) continue;
        }

        // Glow sits on the window rects BuildingRenderer actually drew, including
        // dropping the ones it suppressed for colliding with the door.
        const ey =
          loc.position.y + loc.position.height - WINDOW_CENTER_ABOVE_SOUTH_EDGE;

        for (const wx of southWindowXs(loc)) {
          this.buildingLights.push({
            x: wx,
            y: ey,
            radius: WINDOW_GLOW_RADIUS * weatherMod.radiusMul,
            color: WINDOW_GLOW_COLOR,
            intensity: WINDOW_GLOW_INTENSITY,
            flicker: WINDOW_GLOW_FLICKER * weatherMod.flickerMul,
          });
        }
      }
    }

    // ── Emissive lights (forge + oven) at furniture tile positions ───────
    for (const emDef of EMISSIVE_DEFS) {
      // Find matching location(s) of the correct building type
      for (const loc of locations) {
        if (loc.type !== emDef.buildingType) continue;

        // Operating hours gate (oven only; forge is always-on)
        if (emDef.operatingHoursOnly) {
          if (!this.isNightish && phase !== 'evening' && phase !== 'dawn') continue;
          if (loc.operating_hours) {
            const { open, close } = loc.operating_hours;
            if (hour < open || hour >= close) continue;
          }
        }

        // Compute world position from building origin + tile coords
        const [col, row] = emDef.furnitureTile;
        const wx = loc.position.x + col * INTERIOR_TILE_SIZE + INTERIOR_TILE_SIZE / 2;
        const wy = loc.position.y + row * INTERIOR_TILE_SIZE + INTERIOR_TILE_SIZE / 2;

        this.buildingLights.push({
          x: wx,
          y: wy,
          radius: emDef.radius * weatherMod.radiusMul,
          color: emDef.color,
          intensity: emDef.intensity,
          flicker: emDef.flicker * weatherMod.flickerMul,
        });
      }
    }

    // ── Agent lights (lanterns at night) ────────────────────────────────
    this.agentLights = [];
    if (this.isNightish) {
      for (const agent of agents) {
        const baseRadius = 24;
        let color = 0xFFE0A0;
        let intensity = 0.3;
        let flicker = 0.1;

        // State modifications
        const states = (agent.activeStates ?? []).map(s => typeof s === 'string' ? s : s.type);
        if (states.includes('drunk')) {
          intensity = 0.4;
          flicker = 0.2;
        }
        if (states.includes('angry')) {
          color = 0xFF8060;
          intensity = 0.25;
        }

        this.agentLights.push({
          x: agent.position.x,
          y: agent.position.y,
          radius: baseRadius * weatherMod.radiusMul,
          color,
          intensity,
          flicker: flicker * weatherMod.flickerMul,
        });
      }
    }

    // ── Event lights ───────────────────────────────────────────────────
    this.eventLights = [];
    if (activeEvents.includes('festival')) {
      // Find town square for extra festival glow
      const sq = locations.find(l => l.type === 'town_square');
      if (sq) {
        const cx = sq.position.x + sq.position.width / 2;
        const cy = sq.position.y + sq.position.height / 2;
        this.eventLights.push({
          x: cx, y: cy,
          radius: 120 * weatherMod.radiusMul,
          color: 0xFFDD88,
          intensity: 0.8,
          flicker: 0.15 * weatherMod.flickerMul,
        });
      }
    }

    // Storm lightning tracking
    if (world.weather === 'stormy' && this.isNightish) {
      this.lightningTimer += 1;
      if (this.lightningTimer > 180 && Math.random() < 0.02) {
        this.lightningIntensity = 1.0;
        this.lightningTimer = 0;
      }
    }
  }

  /**
   * Called per animation frame in the ticker.
   * Renders the lightmap and composites it over the scene.
   */
  render(
    cameraX: number,
    cameraY: number,
    cameraScale: number,
    screenW: number,
    screenH: number,
  ) {
    if (screenW < 1 || screenH < 1) return;

    // Ensure lightmap texture matches screen size
    const targetW = Math.ceil(screenW / SCALE);
    const targetH = Math.ceil(screenH / SCALE);

    if (!this.lightmapTexture || this.lmW !== targetW || this.lmH !== targetH) {
      this.lightmapTexture?.destroy(true);
      this.lightmapTexture = RenderTexture.create({
        width: targetW,
        height: targetH,
        antialias: false,
      });
      this.lmW = targetW;
      this.lmH = targetH;
      this.lightmapSprite.texture = this.lightmapTexture;
      this.lightmapSprite.width = screenW;
      this.lightmapSprite.height = screenH;
    }

    // Lerp ambient toward target
    if (this.lerpProgress < 1) {
      this.lerpProgress = Math.min(1, this.lerpProgress + 0.016); // ~60 frames
      this.currentAmbient.r = lerp(this.currentAmbient.r, this.targetAmbient.r, this.lerpProgress);
      this.currentAmbient.g = lerp(this.currentAmbient.g, this.targetAmbient.g, this.lerpProgress);
      this.currentAmbient.b = lerp(this.currentAmbient.b, this.targetAmbient.b, this.lerpProgress);
      this.currentAmbient.brightness = lerp(this.currentAmbient.brightness, this.targetAmbient.brightness, this.lerpProgress);
    }

    // Compute final ambient color
    const b = this.currentAmbient.brightness;
    let aR = Math.round(this.currentAmbient.r * b);
    let aG = Math.round(this.currentAmbient.g * b);
    let aB = Math.round(this.currentAmbient.b * b);

    // Lightning flash
    if (this.lightningIntensity > 0) {
      const li = this.lightningIntensity;
      aR = Math.round(lerp(aR, 255, li));
      aG = Math.round(lerp(aG, 255, li));
      aB = Math.round(lerp(aB, 255, li));
      this.lightningIntensity = Math.max(0, this.lightningIntensity - 0.35);
    }

    const ambientHex = rgbToHex(
      Math.min(255, aR),
      Math.min(255, aG),
      Math.min(255, aB),
    );

    // ── Draw ambient fill ────────────────────────────────────────────
    this.ambientGfx.clear();
    this.ambientGfx.rect(0, 0, targetW, targetH).fill({ color: ambientHex });

    // ── Draw light sources ───────────────────────────────────────────
    this.lightGfx.clear();
    this.lightGfx.blendMode = 'add';

    // Camera transform: world → lightmap coords
    const toLmX = (wx: number) => (wx * cameraScale + cameraX) / SCALE;
    const toLmY = (wy: number) => (wy * cameraScale + cameraY) / SCALE;
    const toRadius = (r: number) => (r * cameraScale) / SCALE;

    // Cull: only draw lights visible on screen
    const pad = 100 / SCALE;
    const isVisible = (lmx: number, lmy: number, lmr: number) =>
      lmx + lmr > -pad && lmx - lmr < targetW + pad &&
      lmy + lmr > -pad && lmy - lmr < targetH + pad;

    // Refilled in place rather than spread into a fresh array: this runs every
    // frame and the light lists can be hundreds of entries long.
    const allLights = this.allLights;
    allLights.length = 0;
    for (const l of this.buildingLights) allLights.push(l);
    for (const l of this.agentLights) allLights.push(l);
    for (const l of this.eventLights) allLights.push(l);
    if (this.isNightish) for (const l of this.streetLights) allLights.push(l);

    for (const light of allLights) {
      const lx = toLmX(light.x);
      const ly = toLmY(light.y);
      const lr = toRadius(light.radius);

      if (!isVisible(lx, ly, lr)) continue;

      // Apply flicker
      let intensity = light.intensity;
      if (light.flicker > 0) {
        intensity *= 1 + (Math.random() - 0.5) * light.flicker;
      }
      intensity = Math.max(0, Math.min(1, intensity));

      // Decompose light color and scale by intensity
      const [cr, cg, cb] = hexToRgb(light.color);
      const fr = Math.round(cr * intensity);
      const fg = Math.round(cg * intensity);
      const fb = Math.round(cb * intensity);
      const fillColor = rgbToHex(fr, fg, fb);

      for (let i = 0; i < RING_ALPHAS.length; i++) {
        this.lightGfx.circle(lx, ly, (lr * (i + 1)) / RING_ALPHAS.length)
          .fill({ color: fillColor, alpha: RING_ALPHAS[i] });
      }
    }

    // ── Render to texture ────────────────────────────────────────────
    this.app.renderer.render({
      container: this.lightContainer,
      target: this.lightmapTexture!,
      clear: true,
    });
  }

  destroy() {
    this.lightmapTexture?.destroy(true);
    this.lightmapSprite.destroy();
    this.lightContainer.destroy({ children: true });
  }
}
