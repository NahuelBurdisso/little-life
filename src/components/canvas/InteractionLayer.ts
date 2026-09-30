import { SpritePool } from "./SpritePool";
import { Container, Application } from "pixi.js";
import { pickAgentAt, type HitCandidate } from "./discretion";

interface InteractionCallbacks {
  onAgentSelect: (agentId: string) => void;
  onAgentHover: (agentId: string | null, screenPos?: { x: number; y: number }) => void;
  onAgentContextMenu: (agentId: string, screenPos: { x: number; y: number }) => void;
  /**
   * Resolves a world-pixel point to the location under it (buildings and open areas),
   * or null on bare ground. Supplied by GameCanvas from the locations query, so this
   * layer stays free of data.
   */
  locationAt?: (worldX: number, worldY: number) => number | null;
  /** A click that hit a location and no agent. `null` = a click on bare ground. */
  onLocationSelect?: (locationId: number | null) => void;
}

/**
 * Handles click/hover/right-click on agent sprites using native DOM events
 * and manual hit testing. This avoids PixiJS v8 event system issues with
 * autoDensity, resolution scaling, and eventMode going stale.
 */
export class InteractionLayer {
  private spritePool: SpritePool;
  private callbacks: InteractionCallbacks;
  private canvas: HTMLCanvasElement | null = null;
  private worldContainer: Container | null = null;
  private hoveredId: string | null = null;

  private onPointerDown: ((e: PointerEvent) => void) | null = null;
  private _onPointerUp: ((e: PointerEvent) => void) | null = null;
  private onPointerMove: ((e: PointerEvent) => void) | null = null;
  private onPointerCancel: (() => void) | null = null;
  private onLostPointerCapture: (() => void) | null = null;
  private onContextMenu: ((e: MouseEvent) => void) | null = null;
  private _clickStart: { x: number; y: number } | null = null;

  constructor(spritePool: SpritePool, callbacks: InteractionCallbacks) {
    this.spritePool = spritePool;
    this.callbacks = callbacks;
  }

  setup(app: Application, worldContainer: Container) {
    this.canvas = app.canvas;
    this.worldContainer = worldContainer;

    this.onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // only left click
      // Capture so the matching pointerup lands here even if the cursor left the
      // canvas. Without it a press released outside leaves `_clickStart` set, and
      // the next unrelated pointerup over the canvas (e.g. finishing a resize-handle
      // drag) is measured against that stale origin and can deselect the agent.
      // Throws `NotFoundError` for a pointerId the browser no longer considers
      // active. Letting that escape skipped the `_clickStart` assignment below
      // and silently swallowed the click, so capture is best-effort.
      try {
        this.canvas!.setPointerCapture(e.pointerId);
      } catch {
        // No capture — a release outside the canvas won't reach us, which
        // `lostpointercapture`/`pointercancel` already have to cover anyway.
      }
      // Record click start position — we'll check on pointerup if it was a click vs drag
      this._clickStart = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0 || !this._clickStart) return;
      // Only treat as click if mouse didn't move much (not a drag)
      const dx = e.clientX - this._clickStart.x;
      const dy = e.clientY - this._clickStart.y;
      this._clickStart = null;
      if (dx * dx + dy * dy > 25) return; // moved more than 5px — it's a drag

      // Agents win over buildings: sprites stand inside the footprints, and a click
      // on someone in a bakery must select them, not open the bakery.
      const hit = this.hitTest(e);
      if (hit) {
        this.callbacks.onAgentSelect(hit);
        return;
      }
      const world = this.toWorld(e);
      const locationId = world ? (this.callbacks.locationAt?.(world.x, world.y) ?? null) : null;
      if (locationId != null) {
        // Keep the current agent selected: the location panel offers "Send <agent> here".
        this.callbacks.onLocationSelect?.(locationId);
      } else {
        // Bare ground: deselect the agent as before, and close the location panel.
        this.callbacks.onAgentSelect("");
        this.callbacks.onLocationSelect?.(null);
      }
    };
    this._onPointerUp = onPointerUp;

    this.onPointerMove = (e: PointerEvent) => {
      // `pointerdown` takes pointer capture, so while a button is held every
      // move is routed here even when the cursor is over the sidebars — the
      // hit test would then keep raising agent tooltips off-canvas. Drop the
      // current hover once and stay quiet until the press ends.
      if (this._clickStart) {
        if (this.hoveredId !== null) {
          this.hoveredId = null;
          this.callbacks.onAgentHover(null);
          this.canvas!.style.cursor = "";
        }
        return;
      }

      const hit = this.hitTest(e);
      if (hit !== this.hoveredId) {
        if (hit) {
          this.callbacks.onAgentHover(hit, { x: e.clientX, y: e.clientY });
          this.canvas!.style.cursor = "pointer";
        } else {
          this.callbacks.onAgentHover(null);
          this.canvas!.style.cursor = "";
        }
        this.hoveredId = hit;
      } else if (hit) {
        // Update position even if same agent (mouse moved)
        this.callbacks.onAgentHover(hit, { x: e.clientX, y: e.clientY });
      }
    };

    // A cancelled pointer (system gesture, touch turned into a scroll) never
    // delivers pointerup, so drop the origin rather than measure the next
    // unrelated release against it.
    this.onPointerCancel = () => { this._clickStart = null; };

    // `pointerup` early-returns on a non-left button, and a press can end without
    // any pointerup at all (capture released because the node moved, tab switch,
    // a system dialog stealing the pointer). `_clickStart` would then stay set
    // forever, and the hover-suppression branch in `pointermove` would kill agent
    // tooltips and the pointer cursor for the rest of the layer's life.
    this.onLostPointerCapture = () => { this._clickStart = null; };

    this.onContextMenu = (e: MouseEvent) => {
      const hit = this.hitTest(e);
      if (hit) {
        e.preventDefault();
        this.callbacks.onAgentContextMenu(hit, { x: e.clientX, y: e.clientY });
      }
    };

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this._onPointerUp!);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("lostpointercapture", this.onLostPointerCapture);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  /** Screen mouse position to world pixels, accounting for pan (container position) and zoom (scale). */
  private toWorld(e: MouseEvent | PointerEvent): { x: number; y: number } | null {
    if (!this.canvas || !this.worldContainer) return null;
    const rect = this.canvas.getBoundingClientRect();
    const wc = this.worldContainer;
    return {
      x: (e.clientX - rect.left - wc.x) / wc.scale.x,
      y: (e.clientY - rect.top - wc.y) / wc.scale.y,
    };
  }

  /** Convert screen mouse position to world coordinates and find the closest agent. */
  private hitTest(e: MouseEvent | PointerEvent): string | null {
    const world = this.toWorld(e);
    if (!world) return null;
    const { x: worldX, y: worldY } = world;

    // Closest sprite within the hit radius; veiled ones (a couple's private evening) are not hittable.
    const HIT_RADIUS = 20; // pixels in world space
    const candidates: HitCandidate[] = [];
    for (const id of this.spritePool.getAllIds()) {
      const sprite = this.spritePool.getSprite(id);
      if (!sprite) continue;
      candidates.push({ id, x: sprite.container.x, y: sprite.container.y, veiled: sprite.isVeiled });
    }
    return pickAgentAt(candidates, worldX, worldY, HIT_RADIUS);
  }

  /** No-op — native events don't need per-sprite rebinding. */
  updateBindings(_agentIds: string[]) {
    // Intentionally empty — hit testing is done via coordinate math,
    // not PixiJS event bindings on containers.
  }

  destroy() {
    if (this.canvas) {
      if (this.onPointerDown) this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      if (this._onPointerUp) this.canvas.removeEventListener("pointerup", this._onPointerUp);
      if (this.onPointerMove) this.canvas.removeEventListener("pointermove", this.onPointerMove);
      if (this.onPointerCancel) this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
      if (this.onLostPointerCapture) this.canvas.removeEventListener("lostpointercapture", this.onLostPointerCapture);
      if (this.onContextMenu) this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    }
    this.canvas = null;
    this.worldContainer = null;
    this.hoveredId = null;
  }
}
