import { Application, Container } from "pixi.js";

/**
 * Squared px the pointer must travel from the press origin before it counts as a
 * pan rather than a click. Set to InteractionLayer's click threshold so ordinary
 * hand jitter while clicking an agent doesn't drop the follow-lock. Not identical
 * to it: InteractionLayer measures net down-to-up displacement once, this latches
 * on the running distance — a press that wanders out and back is a click for
 * selection but still a pan for the camera, which did in fact move.
 */
const PAN_THRESHOLD_SQ = 25;

/** How far past the map edge the camera may travel, so the border stays visible. */
const EDGE_PAD = 100;

/**
 * Keeps one axis inside the map plus its padding. Once zoomed out far enough
 * that the map no longer fills the viewport the two bounds cross: naive min/max
 * then collapses to a single legal value and pins the map to one corner, and
 * returning the centred value pins it to the centre — either way the axis stops
 * responding to panning and `focusOn` becomes a no-op on it. Swap the crossed
 * bounds instead, which turns the padding into slack the camera can still move
 * through while keeping the whole map on screen.
 */
function clampAxis(v: number, canvasSize: number, mapSize: number, pad: number): number {
  const a = pad;
  const b = canvasSize - mapSize - pad;
  return Math.min(Math.max(a, b), Math.max(Math.min(a, b), v));
}

export class CameraController {
  private worldContainer: Container;
  private canvas: HTMLCanvasElement;
  /** Stage-space viewport size in CSS pixels — `canvas.width` is the device-pixel buffer. */
  private screen: { width: number; height: number };
  private isDragging = false;
  private lastMouse = { x: 0, y: 0 };
  /** Where the current press started, so a click can be told apart from a pan. */
  private pressOrigin = { x: 0, y: 0 };
  private panFired = false;
  private scale = 1;
  private readonly minScale = 0.5;
  private readonly maxScale = 3;
  /**
   * Focus target in world space, not screen space. Selecting an agent opens the
   * side panel, which shrinks the canvas a frame later — a baked screen-space
   * target would then centre on the old viewport and leave the agent off-centre.
   */
  private focusWorld: { x: number; y: number } | null = null;
  /** Backing store for `focusWorld`. A follow-lock calls `focusOn` every frame,
   *  so allocating a fresh point there would be steady GC churn. */
  private focusPoint = { x: 0, y: 0 };
  private animating = false;
  private mapWidth = 1920;
  private mapHeight = 1440;

  /** Fired when the user pans by hand, so callers can drop any follow-lock. */
  onUserPan: (() => void) | null = null;

  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onWheel: (e: WheelEvent) => void;
  private onTouchStart: (e: TouchEvent) => void;
  private onTouchMove: (e: TouchEvent) => void;
  private onTouchEnd: (e: TouchEvent) => void;

  constructor(
    app: Application,
    worldContainer: Container,
  ) {
    this.worldContainer = worldContainer;
    this.canvas = app.canvas;
    this.screen = app.screen;

    // Center the world initially
    this.worldContainer.x = this.screen.width / 2 - this.mapWidth / 2;
    this.worldContainer.y = this.screen.height / 2 - this.mapHeight / 2;

    // Mouse pan
    this.onMouseDown = (e: MouseEvent) => {
      if (e.button === 0 || e.button === 1) {
        this.beginPress(e.clientX, e.clientY);
      }
    };

    this.onMouseMove = (e: MouseEvent) => {
      if (!this.isDragging) return;
      // Releasing outside the browser window never delivers a mouseup, and this
      // listener is on `window`, so the camera would then chase the bare cursor.
      if (e.buttons === 0) {
        this.isDragging = false;
        return;
      }
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.notePanDistance(e.clientX, e.clientY);
      this.worldContainer.x += dx;
      this.worldContainer.y += dy;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.clampBounds();
    };

    this.onMouseUp = () => {
      this.isDragging = false;
    };

    // Zoom
    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const direction = e.deltaY < 0 ? 1 : -1;
      const factor = 1 + direction * 0.1;
      const newScale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));

      // Zoom toward mouse position
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const worldX = (mouseX - this.worldContainer.x) / this.scale;
      const worldY = (mouseY - this.worldContainer.y) / this.scale;

      this.scale = newScale;
      this.worldContainer.scale.set(this.scale);

      this.worldContainer.x = mouseX - worldX * this.scale;
      this.worldContainer.y = mouseY - worldY * this.scale;
      // A focus target was computed at the old scale, so leaving it running
      // would immediately undo the zoom-toward-cursor offset.
      this.abortFocus();
      // A follow-lock re-arms `focusOn` on the very next frame, so aborting is
      // not enough on its own — the lock has to be released or the camera snaps
      // straight back and the zoom-toward-cursor offset is lost.
      this.onUserPan?.();
      this.clampBounds();
    };

    // Touch support
    this.onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        this.beginPress(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    this.onTouchMove = (e: TouchEvent) => {
      if (!this.isDragging || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - this.lastMouse.x;
      const dy = e.touches[0].clientY - this.lastMouse.y;
      this.notePanDistance(e.touches[0].clientX, e.touches[0].clientY);
      this.worldContainer.x += dx;
      this.worldContainer.y += dy;
      this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      this.clampBounds();
    };

    this.onTouchEnd = (e: TouchEvent) => {
      // Lifting a second finger must not kill an ongoing one-finger pan; rebase
      // the gesture on the finger that's still down.
      if (e.touches.length === 0) this.isDragging = false;
      else this.beginPress(e.touches[0].clientX, e.touches[0].clientY);
    };

    this.canvas.addEventListener("mousedown", this.onMouseDown);
    // On `window`, not the canvas: dragging out of the canvas and back would
    // otherwise leave `lastMouse` stale and teleport the camera on re-entry.
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.canvas.addEventListener("touchmove", this.onTouchMove, { passive: false });
    this.canvas.addEventListener("touchend", this.onTouchEnd, { passive: true });
  }

  getScale(): number {
    return this.scale;
  }

  private beginPress(x: number, y: number) {
    this.isDragging = true;
    this.lastMouse = { x, y };
    this.pressOrigin = { x, y };
    this.panFired = false;
    this.abortFocus();
  }

  /** Fires `onUserPan` once the press has travelled far enough to be a real pan. */
  private notePanDistance(x: number, y: number) {
    if (this.panFired) return;
    const ox = x - this.pressOrigin.x;
    const oy = y - this.pressOrigin.y;
    if (ox * ox + oy * oy > PAN_THRESHOLD_SQ) {
      this.panFired = true;
      // A follow-lock re-arms `focusOn` every frame, so the press-time abort is
      // already stale by now. Without this the released lock keeps lerping the
      // camera back and undoes the pan the user just made.
      this.abortFocus();
      this.onUserPan?.();
    }
  }

  /** Drops any in-flight focus animation so it can't drag the camera back. */
  private abortFocus() {
    this.focusWorld = null;
    this.animating = false;
  }

  focusOn(worldX: number, worldY: number) {
    this.focusPoint.x = worldX;
    this.focusPoint.y = worldY;
    this.focusWorld = this.focusPoint;
    this.animating = true;
  }

  update(delta: number) {
    // Runs even when idle: the viewport can be resized at any time (agent panel,
    // resize handles), which moves the legal bounds out from under the camera.
    if (!this.animating || !this.focusWorld) {
      this.clampBounds();
      return;
    }

    // Recomputed every frame so a mid-animation resize or zoom still lands centred.
    // Clamped to the same bounds the camera will be held to afterwards — an agent
    // near a map edge can't be centred, and chasing the unreachable target would
    // leave `dist` permanently above the stop threshold.
    const mapW = this.mapWidth * this.scale;
    const mapH = this.mapHeight * this.scale;
    const targetX = clampAxis(
      Math.round(this.screen.width / 2 - this.focusWorld.x * this.scale),
      this.screen.width, mapW, EDGE_PAD,
    );
    const targetY = clampAxis(
      Math.round(this.screen.height / 2 - this.focusWorld.y * this.scale),
      this.screen.height, mapH, EDGE_PAD,
    );

    const lerp = Math.min(1, delta * 0.05);
    this.worldContainer.x += (targetX - this.worldContainer.x) * lerp;
    this.worldContainer.y += (targetY - this.worldContainer.y) * lerp;

    const dist =
      Math.abs(targetX - this.worldContainer.x) +
      Math.abs(targetY - this.worldContainer.y);

    if (dist < 1) {
      this.worldContainer.x = targetX;
      this.worldContainer.y = targetY;
      this.abortFocus();
    }

    this.clampBounds();
  }

  setMapSize(width: number, height: number) {
    this.mapWidth = width;
    this.mapHeight = height;
    this.clampBounds();
  }

  private clampBounds() {
    const mapW = this.mapWidth * this.scale;
    const mapH = this.mapHeight * this.scale;
    this.worldContainer.x = clampAxis(this.worldContainer.x, this.screen.width, mapW, EDGE_PAD);
    this.worldContainer.y = clampAxis(this.worldContainer.y, this.screen.height, mapH, EDGE_PAD);
  }

  destroy() {
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("touchstart", this.onTouchStart);
    this.canvas.removeEventListener("touchmove", this.onTouchMove);
    this.canvas.removeEventListener("touchend", this.onTouchEnd);
  }
}
