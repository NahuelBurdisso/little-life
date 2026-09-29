import * as PIXI from "pixi.js";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext } from "../types";
import { onCanvasEvent, type CanvasBusEvent } from "../../../../lib/canvasBus";
import { loadStrip } from "../../stripAtlas";
import { BEATS_FRAME_COUNT, BEATS_FRAME_SIZE, BEATS_URL } from "../beats/beatFrames";
import { FxSpritePool } from "./fxPool";
import {
  DIGITS_FRAME_COUNT, DIGITS_FRAME_SIZE, DIGITS_URL, PFX_FRAME_COUNT, PFX_FRAME_SIZE, PFX_URL,
} from "./playerFxFrames";
import {
  CoinFx, ConfrontFx, EventBurstFx, FarewellFx, FeelingFx, FlashFx, IntroFx, PinFx, PingFx, RumorFx,
  SecretFx, TalkFx, ThoughtFx, fxKey,
  type Env, type Fx,
} from "./effects";

/** At most this many effects at once; a new one evicts the oldest. */
const MAX_FX = 16;

type Intervention = Extract<CanvasBusEvent, { type: "intervention" }>;
type Celebrate = Extract<CanvasBusEvent, { type: "celebrate" }>;

/**
 * The canvas's answer to what the player does. `useNudge` (and the event/weather menus) emit an
 * `intervention` on the canvas bus once the server accepted the action; this system turns each
 * kind into its own little scene — a matchmaker arc, a destination pin, a shower of coins, a
 * travelling whisper, crossed swords, a newcomer's arrival, a farewell, an event burst, a
 * thought falling into a head, a rumor drifting off, a feeling welling up — and
 * falls back to the old gold ring for kinds it does not know.
 *
 * Purely client-side and short-lived: effects are created on the event, driven every frame from
 * `update`, and hand their pooled sprites back when done.
 */
class PlayerFxSystem implements CanvasSystem {
  private readonly pool: FxSpritePool;
  private env: Env | null = null;
  private digits: PIXI.Texture[] | null = null;
  private beats: PIXI.Texture[] | null = null;
  private tex: PIXI.Texture[] | null = null;
  private data: DataContext | null = null;
  private fx: Fx[] = [];
  private destroyed = false;
  private readonly unsubscribe: () => void;

  constructor(layers: CanvasLayers, private readonly services: CanvasServices) {
    this.pool = new FxSpritePool(layers.ground, layers.overAgents);
    // Each strip is independent: a missing digits PNG only costs the "+N" label.
    loadStrip(PFX_URL, PFX_FRAME_COUNT, PFX_FRAME_SIZE).then(t => {
      if (this.destroyed) return;
      this.tex = t;
      this.rebuildEnv();
    }).catch(err => console.warn("[playerFx] atlas failed to load:", err));
    loadStrip(DIGITS_URL, DIGITS_FRAME_COUNT, DIGITS_FRAME_SIZE).then(t => {
      if (this.destroyed) return;
      this.digits = t;
      this.rebuildEnv();
    }).catch(err => console.warn("[playerFx] digits failed to load:", err));
    loadStrip(BEATS_URL, BEATS_FRAME_COUNT, BEATS_FRAME_SIZE).then(t => {
      if (this.destroyed) return;
      this.beats = t;
      this.rebuildEnv();
    }).catch(() => { /* the ping ring is optional; the emote still plays */ });

    this.unsubscribe = onCanvasEvent(e => {
      if (e.type === "intervention") this.handle(e);
      else if (e.type === "celebrate") this.celebrate(e);
    });
  }

  private rebuildEnv(): void {
    if (!this.tex) return;
    // Effects hold the env object they were created with, so mutate in place when possible.
    if (this.env) {
      this.env.digits = this.digits;
      this.env.beats = this.beats;
      return;
    }
    this.env = {
      pool: this.pool, tex: this.tex, digits: this.digits, beats: this.beats,
      sprites: this.services.sprites, bubbles: this.services.bubbles,
    };
  }

  onData(data: DataContext): void {
    this.data = data;
  }

  private handle(e: Intervention): void {
    try {
      this.handleUnsafe(e);
    } catch (err) {
      console.warn("[playerFx] intervention failed:", err);
    }
  }

  private handleUnsafe(e: Intervention): void {
    const env = this.env;
    const ids = e.agentIds;
    if (!env) {
      // Atlas still loading: at least acknowledge with the emote.
      this.fallbackEmote(ids);
      return;
    }
    const [a, b] = ids;
    switch (e.kind) {
      case "suggest_talk":
        if (a != null && b != null) return this.add(fxKey.talk(a, b), () => new TalkFx(env, a, b));
        break;
      case "suggest_go_to": {
        const loc = e.locationId != null ? this.location(e.locationId) : null;
        const dest = loc ? doorOf(loc) : null;
        if (a != null && dest) return this.add(fxKey.pin(a), () => new PinFx(env, a, loc.id, dest.x, dest.y));
        break;
      }
      case "give_money":
        if (a != null) return this.add(null, () => new CoinFx(env, a, e.amount ?? 0));
        break;
      case "tell_secret":
        if (a != null && b != null) return this.add(fxKey.secret(a, b), () => new SecretFx(env, a, b));
        break;
      case "force_confront":
        if (a != null && b != null) return this.add(fxKey.confront(a, b), () => new ConfrontFx(env, a, b));
        break;
      case "introduce_agent":
        // The sprite does not exist yet; IntroFx waits for it. Without an id there is nothing to wait for.
        if (a != null) this.add(fxKey.intro(a), () => new IntroFx(a));
        return;
      case "remove_agent": {
        if (a == null) return;
        const sp = env.sprites.getSprite(String(a));
        const x = sp ? sp.x : e.x;
        const y = sp ? sp.y : e.y;
        if (x == null || y == null) return;
        const dir = sp && (sp as any).facingDir === -1 ? -1 : 1;
        return this.add(fxKey.farewell(a), () => new FarewellFx(env, a, x, y, dir));
      }
      case "event": {
        const loc = e.locationId != null ? this.location(e.locationId) : null;
        const p = loc?.position;
        if (loc && p?.width) return this.add(fxKey.event(loc.id), () => new EventBurstFx(env, loc.id, p.x, p.y, p.width, p.height));
        return;
      }
      case "weather":
        return this.add(fxKey.flash, () => new FlashFx(env));
      case "whisper_thought":
        if (a != null) return this.add(fxKey.thought(a), () => new ThoughtFx(env, a));
        break;
      case "start_rumor":
        // agentIds = [seeder, subject]; only the seeder shows anything (see RumorFx).
        if (a != null) return this.add(fxKey.rumor(a), () => new RumorFx(env, a));
        break;
      case "stir_feeling":
        if (a != null) return this.add(fxKey.feeling(a), () => new FeelingFx(env, a, e.feeling));
        break;
    }
    // Unknown kind, or a known one missing what it needs: the generic ping on each agent.
    for (const id of ids) this.add(null, () => new PingFx(env, id));
  }

  /**
   * A challenge settled or an achievement unlocked. Reuses the feeling spiral: gold stars
   * rising around the people it was about on a win, grey-blue sweat on a loss. A town-wide
   * win (Guardian, Full house...) has nobody to stand on, so the screen flashes instead.
   */
  private celebrate(e: Celebrate): void {
    try {
      const env = this.env;
      if (!env) {
        if (e.success) this.fallbackEmote(e.agentIds);
        return;
      }
      const feeling = e.success ? "confident" : "stressed";
      let shown = 0;
      for (const id of e.agentIds) {
        if (!env.sprites.getSprite(String(id))) continue;
        this.add(fxKey.feeling(id), () => new FeelingFx(env, id, feeling));
        shown++;
      }
      if (shown === 0 && e.success) this.add(fxKey.flash, () => new FlashFx(env));
    } catch (err) {
      console.warn("[playerFx] celebrate failed:", err);
    }
  }

  private location(id: number): any | null {
    const list = this.data?.locations;
    if (!list) return null;
    for (const l of list) if (l?.id === id) return l;
    return null;
  }

  private fallbackEmote(ids: number[]): void {
    for (const id of ids) {
      const sp = this.services.sprites.getSprite(String(id));
      if (sp) this.services.bubbles.showEmote(String(id), "exclaim", { x: sp.x, y: sp.y });
    }
  }

  private add(key: string | null, make: () => Fx): void {
    const env = this.env!;
    if (key) {
      // Dispose first so the replacement reuses the sprites the old one hands back.
      const i = this.fx.findIndex(o => o.key === key);
      if (i >= 0) { this.fx[i].dispose(env); this.fx.splice(i, 1); }
    }
    while (this.fx.length >= MAX_FX) this.fx.shift()!.dispose(env);
    this.fx.push(make());
  }

  update(frame: FrameContext): void {
    const env = this.env;
    if (!env || this.fx.length === 0) return;
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const fx = this.fx[i];
      let alive = false;
      try {
        alive = fx.update(env, frame);
      } catch (err) {
        console.warn("[playerFx] update failed:", err);
      }
      if (!alive) {
        fx.dispose(env);
        this.fx.splice(i, 1);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    if (this.env) for (const fx of this.fx) fx.dispose(this.env);
    this.fx.length = 0;
    this.pool.destroy();
    this.env = null;
    this.tex = this.digits = this.beats = null;
  }
}

/** Where an agent walking to a location ends up: its entry point, else the middle of its south wall. */
function doorOf(loc: any): { x: number; y: number } | null {
  const e = loc?.entry_point;
  if (e && Number.isFinite(e.x) && Number.isFinite(e.y)) return { x: e.x, y: e.y };
  const p = loc?.position;
  if (p?.width) return { x: p.x + p.width / 2, y: p.y + p.height };
  return null;
}

export function createPlayerFxSystem(layers: CanvasLayers, services: CanvasServices): CanvasSystem {
  return new PlayerFxSystem(layers, services);
}
