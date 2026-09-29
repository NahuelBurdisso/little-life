import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../../../lib/spriteConfig";
import type { CanvasLayers, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import type { ViewRect } from "../view";
import type { MapPx, Rect } from "../townEvents/eventDecor";
import {
  CLOUD_COUNT, STAR_LENGTH, cloudInView, cloudShadowStrength, daylightFactor, easeToward, hasStarryNight,
  makeClouds, newStar, nextStarDelay, planSky, seededRandom, spawnStar, stepCloud, stepStar,
  type Cloud, type SkyPiece, type Star,
} from "./skyModel";
import { createSkyTextures, type SkyTextures } from "./skyTextures";

/** Fade rates (per second, exponential): light effects arrive in a couple of seconds, weather more slowly. */
const EFFECT_RATE = 1.4;
const CLOUD_RATE = 0.6;

const SHAFT_COUNT = 3;
const MIST_COUNT = 6;
const STAR_POOL = 3;

const rectInView = (v: ViewRect, r: Rect, margin: number) =>
  r.x + r.width + margin >= v.x && r.x - margin <= v.x + v.w && r.y + r.height + margin >= v.y && r.y - margin <= v.y + v.h;

interface CloudNode { box: PIXI.Container; lobes: PIXI.Sprite[] }

/**
 * Soft, sky-level light and shade that the pixel atlas can't do:
 *
 * - drifting cloud shadows over the terrain while the weather is cloudy (or, faintly, windy),
 * - a silver halo on the square for a full moon,
 * - slanting shafts of gold light on the square for a blessing,
 * - a cold mist creeping about the mysterious stranger,
 * - the occasional shooting star across the view on a starry night.
 *
 * Everything is a handful of pooled sprites made once in the constructor (the whole system is
 * about 25 sprites, hidden when idle); the per-frame work is easing intensities and moving the
 * few that are visible. `skyModel.ts` holds the numbers.
 */
export class SkyFxSystem implements CanvasSystem {
  private readonly root = new PIXI.Container();
  private readonly tex: SkyTextures | null;
  private readonly rand = seededRandom(Date.now() & 0xffff);
  private warned = false;

  // weather
  private clouds: Cloud[] = [];
  private readonly cloudNodes: CloudNode[] = [];
  private mapKey = "";
  private map: MapPx | null = null;
  private cloudK = 0;
  private cloudTarget = 0;
  private lastCloudAlpha = -1;

  // event light
  private readonly moon: PIXI.Sprite | null;
  private moonK = 0;
  private moonTarget = 0;
  private moonRect: Rect | null = null;
  private readonly shafts: PIXI.Sprite[] = [];
  private shaftK = 0;
  private shaftTarget = 0;
  private shaftRect: Rect | null = null;
  private readonly mist: PIXI.Sprite[] = [];
  private mistBase: { x: number; y: number }[] = [];
  private mistK = 0;
  private mistTarget = 0;
  private mistRect: Rect | null = null;

  // shooting stars
  private readonly starSprites: PIXI.Sprite[] = [];
  private readonly stars: Star[] = [];
  private starsOn = false;
  private nextStarIn = 2;

  private signature = "";

  constructor(layers: CanvasLayers) {
    this.root.eventMode = "none";
    layers.overAgents.addChild(this.root);
    this.tex = createSkyTextures();
    const tex = this.tex;
    if (!tex) { this.moon = null; return; }

    const blob = (tint: number, blend: "normal" | "add") => {
      const s = new PIXI.Sprite(tex.blob);
      s.anchor.set(0.5);
      s.tint = tint;
      s.blendMode = blend;
      s.visible = false;
      this.root.addChild(s);
      return s;
    };

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const box = new PIXI.Container();
      box.visible = false;
      const lobes = [0, 1, 2].map(() => {
        const s = new PIXI.Sprite(tex.blob);
        s.anchor.set(0.5);
        s.tint = 0x0a1224;          // a blue-black: shadow on grass is never neutral grey
        box.addChild(s);
        return s;
      });
      this.root.addChild(box);
      this.cloudNodes.push({ box, lobes });
    }

    this.moon = blob(0xb4c8ff, "add");
    for (let i = 0; i < SHAFT_COUNT; i++) {
      const s = new PIXI.Sprite(tex.beam);
      s.anchor.set(0.5, 0);
      s.tint = 0xffd070;
      s.blendMode = "add";
      s.rotation = -0.32;
      s.visible = false;
      this.root.addChild(s);
      this.shafts.push(s);
    }
    for (let i = 0; i < MIST_COUNT; i++) this.mist.push(blob(0xa4b4d0, "add"));
    for (let i = 0; i < STAR_POOL; i++) {
      const s = new PIXI.Sprite(tex.streak);
      s.anchor.set(1, 0.5);
      s.blendMode = "add";
      s.tint = 0xe8f0ff;
      s.visible = false;
      this.root.addChild(s);
      this.starSprites.push(s);
      this.stars.push(newStar());
    }
  }

  // ── Data → targets ──────────────────────────────────────────────────────────────────────────

  onData(data: DataContext): void {
    if (!this.tex) return;
    const world = data.world as { map_width?: number; map_height?: number; weather?: string; day_phase?: string; road_tiles?: { x: number; y: number }[] } | null;

    const map: MapPx | null = world?.map_width && world?.map_height
      ? { w: world.map_width * TILE_SIZE, h: world.map_height * TILE_SIZE }
      : null;
    const key = map ? `${map.w}x${map.h}` : "";
    if (key !== this.mapKey) {
      this.mapKey = key;
      this.map = map;
      this.clouds = map ? makeClouds(map) : [];
      this.lastCloudAlpha = -1;
      this.clouds.forEach((c, i) => this.shapeCloud(this.cloudNodes[i], c));
    }
    this.cloudTarget = map ? cloudShadowStrength(world?.weather ?? "sunny") * daylightFactor(world?.day_phase ?? "morning") : 0;

    this.starsOn = hasStarryNight(data.events);

    // Rebuild the event pieces only when the set of events (or the places to anchor them) changes.
    let sig = `${data.locations?.length ?? 0}#${world?.road_tiles?.length ?? 0}`;
    for (const e of data.events ?? []) sig += `|${e?.id}:${e?.type}`;
    if (sig === this.signature) return;
    this.signature = sig;
    this.applyPieces(planSky(data.events, data.locations ?? [], map, world?.road_tiles));
  }

  private shapeCloud(node: CloudNode | undefined, c: Cloud): void {
    if (!node) return;
    c.lobes.forEach((l, i) => {
      const s = node.lobes[i];
      s.position.set(l.ox * c.w, l.oy * c.h);
      s.scale.set((l.sx * c.w) / 64, (l.sy * c.h) / 64);
    });
  }

  private applyPieces(pieces: SkyPiece[]): void {
    let moon: Rect | null = null, shafts: Rect | null = null, mist: SkyPiece | null = null;
    for (const p of pieces) {
      if (p.kind === "moon") moon = p.rect;
      else if (p.kind === "shafts") shafts = p.rect;
      else mist = p;
    }
    // A vanished event keeps its last rect while it fades out (k eases down toward its target 0).
    if (moon) {
      this.moonRect = moon;
      if (this.moon) {
        this.moon.position.set(moon.x + moon.width / 2, moon.y + moon.height / 2);
        // The halo overflows the square: light spills onto the streets around it.
        this.moon.scale.set((moon.width * 1.9) / 64, (moon.height * 2.4) / 64);
      }
    }
    this.moonTarget = moon ? 1 : 0;

    if (shafts) {
      this.shaftRect = shafts;
      this.shafts.forEach((s, i) => {
        // Beams enter above the square's north edge and slant across it.
        s.position.set(shafts.x + shafts.width * (0.18 + i * 0.3), shafts.y - 36);
        s.scale.set((44 + i * 12) / 32, (shafts.height * 1.1 + 36) / 128);
      });
    }
    this.shaftTarget = shafts ? 1 : 0;

    if (mist && mist.kind === "mist") {
      this.mistRect = { x: mist.x - 130, y: mist.y - 60, width: 260, height: 90 };
      this.mistBase = this.mist.map((s, i) => {
        const bx = mist.x + (i - (MIST_COUNT - 1) / 2) * 38 + ((i * 37) % 11) - 5;
        const by = mist.y - 8 - ((i * 13) % 9);
        s.position.set(bx, by);
        s.scale.set((110 + ((i * 29) % 50)) / 64, (34 + ((i * 17) % 22)) / 64);
        return { x: bx, y: by };
      });
    }
    this.mistTarget = mist ? 1 : 0;
  }

  // ── Per frame ───────────────────────────────────────────────────────────────────────────────

  update(frame: FrameContext): void {
    if (!this.tex) return;
    try {
      this.step(frame);
    } catch (err) {
      if (!this.warned) { this.warned = true; console.warn("[skyFx] update failed:", err); }
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
    if (this.tex) {
      // The textures are ours (painted from canvases in the constructor), unlike the shared atlases.
      this.tex.blob.destroy(true);
      this.tex.beam.destroy(true);
      this.tex.streak.destroy(true);
    }
  }

  private step(frame: FrameContext): void {
    const { view, seconds } = frame;
    const t = frame.now / 1000;

    this.stepClouds(view, seconds);

    this.moonK = easeToward(this.moonK, this.moonTarget, seconds, EFFECT_RATE);
    this.shaftK = easeToward(this.shaftK, this.shaftTarget, seconds, EFFECT_RATE);
    this.mistK = easeToward(this.mistK, this.mistTarget, seconds, EFFECT_RATE);

    // Moon: a slow breath in the glow.
    const moon = this.moon;
    if (moon) {
      const show = this.moonK > 0.004 && this.moonRect !== null && rectInView(view, this.moonRect, this.moonRect.width);
      moon.visible = show;
      if (show) moon.alpha = this.moonK * (0.3 + 0.04 * Math.sin(t * 0.7));
    }

    // Shafts: each swells and fades on its own beat, as if through moving leaves.
    const shaftsShow = this.shaftK > 0.004 && this.shaftRect !== null && rectInView(view, this.shaftRect, 80);
    for (let i = 0; i < this.shafts.length; i++) {
      const s = this.shafts[i];
      s.visible = shaftsShow;
      if (shaftsShow) s.alpha = this.shaftK * (0.17 + 0.08 * Math.sin(t * 0.5 + i * 2.1));
    }

    // Mist: drifts sideways in slow, unequal swells.
    const mistShow = this.mistK > 0.004 && this.mistRect !== null && rectInView(view, this.mistRect, 40);
    for (let i = 0; i < this.mist.length; i++) {
      const s = this.mist[i];
      s.visible = mistShow;
      if (!mistShow) continue;
      const b = this.mistBase[i];
      if (!b) { s.visible = false; continue; }
      s.position.set(b.x + Math.sin(t * 0.25 + i * 1.7) * 26, b.y + Math.sin(t * 0.4 + i * 2.3) * 4);
      s.alpha = this.mistK * 0.13 * (0.65 + 0.35 * Math.sin(t * 0.6 + i));
    }

    this.stepStars(view, seconds);
  }

  private stepClouds(view: ViewRect, seconds: number): void {
    this.cloudK = easeToward(this.cloudK, this.cloudTarget, seconds, CLOUD_RATE);
    if (this.cloudK < 0.004 || !this.map) {
      if (this.lastCloudAlpha !== 0) {
        this.lastCloudAlpha = 0;
        for (const n of this.cloudNodes) n.box.visible = false;
      }
      return;
    }
    // Three lobes stack up near the middle of a cloud, so each carries a third of its strength.
    const lobeAlpha = this.cloudK / 2.2;
    const alphaChanged = Math.abs(lobeAlpha - this.lastCloudAlpha) > 0.002;
    if (alphaChanged) this.lastCloudAlpha = lobeAlpha;
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      const node = this.cloudNodes[i];
      if (!node) continue;
      stepCloud(c, seconds, this.map);
      const show = cloudInView(c, view);
      node.box.visible = show;
      if (!show) continue;
      node.box.position.set(c.x, c.y);
      if (alphaChanged) for (const l of node.lobes) l.alpha = lobeAlpha;
    }
  }

  private stepStars(view: ViewRect, seconds: number): void {
    if (this.starsOn) {
      this.nextStarIn -= seconds;
      if (this.nextStarIn <= 0) {
        this.nextStarIn = nextStarDelay(this.rand);
        const free = this.stars.find(s => !s.active);
        if (free) spawnStar(view, this.rand, free);
      }
    }
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      const sprite = this.starSprites[i];
      const b = stepStar(star, seconds);
      if (b <= 0) { sprite.visible = false; continue; }
      sprite.visible = true;
      sprite.position.set(star.x, star.y);
      sprite.rotation = star.angle;
      sprite.scale.set((STAR_LENGTH / 128) * star.k, star.k);
      sprite.alpha = b;
    }
  }
}

export const createSkyFxSystem: SystemFactory = (layers) => new SkyFxSystem(layers);
