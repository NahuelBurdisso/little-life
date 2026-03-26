import { Application, Container } from "pixi.js";

export class CameraController {
  private worldContainer: Container;
  private canvas: HTMLCanvasElement;
  private isDragging = false;
  private lastMouse = { x: 0, y: 0 };
  private scale = 1;
  private readonly minScale = 0.5;
  private readonly maxScale = 3;
  private targetX: number | null = null;
  private targetY: number | null = null;
  private animating = false;
  private mapWidth = 1280;
  private mapHeight = 960;

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

    // Center the world initially
    this.worldContainer.x = this.canvas.width / 2 - 640;
    this.worldContainer.y = this.canvas.height / 2 - 480;

    // Mouse pan
    this.onMouseDown = (e: MouseEvent) => {
      if (e.button === 0 || e.button === 1) {
        this.isDragging = true;
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this.targetX = null;
        this.targetY = null;
      }
    };

    this.onMouseMove = (e: MouseEvent) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
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
      this.clampBounds();
    };

    // Touch support
    this.onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.targetX = null;
        this.targetY = null;
      }
    };

    this.onTouchMove = (e: TouchEvent) => {
      if (!this.isDragging || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - this.lastMouse.x;
      const dy = e.touches[0].clientY - this.lastMouse.y;
      this.worldContainer.x += dx;
      this.worldContainer.y += dy;
      this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      this.clampBounds();
    };

    this.onTouchEnd = () => {
      this.isDragging = false;
    };

    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.canvas.addEventListener("touchmove", this.onTouchMove, { passive: false });
    this.canvas.addEventListener("touchend", this.onTouchEnd, { passive: true });
  }

  focusOn(worldX: number, worldY: number) {
    this.targetX = this.canvas.width / 2 - worldX * this.scale;
    this.targetY = this.canvas.height / 2 - worldY * this.scale;
    this.animating = true;
  }

  update(delta: number) {
    if (!this.animating || this.targetX === null || this.targetY === null) return;

    const lerp = Math.min(1, delta * 0.05);
    this.worldContainer.x += (this.targetX - this.worldContainer.x) * lerp;
    this.worldContainer.y += (this.targetY - this.worldContainer.y) * lerp;

    const dist =
      Math.abs(this.targetX - this.worldContainer.x) +
      Math.abs(this.targetY - this.worldContainer.y);

    if (dist < 1) {
      this.worldContainer.x = this.targetX;
      this.worldContainer.y = this.targetY;
      this.animating = false;
      this.targetX = null;
      this.targetY = null;
    }

    this.clampBounds();
  }

  setMapSize(width: number, height: number) {
    this.mapWidth = width;
    this.mapHeight = height;
  }

  private clampBounds() {
    const mapW = this.mapWidth * this.scale;
    const mapH = this.mapHeight * this.scale;
    // Use displayed size (CSS pixels), not canvas buffer size
    const rect = this.canvas.getBoundingClientRect();
    const canvasW = rect.width;
    const canvasH = rect.height;

    // Allow some padding so you can see the edges
    const pad = 100;

    this.worldContainer.x = Math.min(pad, Math.max(canvasW - mapW - pad, this.worldContainer.x));
    this.worldContainer.y = Math.min(pad, Math.max(canvasH - mapH - pad, this.worldContainer.y));
  }

  destroy() {
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("touchstart", this.onTouchStart);
    this.canvas.removeEventListener("touchmove", this.onTouchMove);
    this.canvas.removeEventListener("touchend", this.onTouchEnd);
  }
}
