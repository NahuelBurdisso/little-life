import { Application, Graphics } from "pixi.js";

export class DayNightCycle {
  private overlay: Graphics;

  constructor(app: Application) {
    this.overlay = new Graphics();
    // Add on top of everything in stage
    app.stage.addChild(this.overlay);
  }

  update(dayPhase: string, width: number, height: number) {
    this.overlay.clear();
    const { color, alpha } = this.getPhaseStyle(dayPhase);
    if (alpha > 0) {
      this.overlay.rect(0, 0, width, height).fill({ color, alpha });
    }
  }

  private getPhaseStyle(phase: string): { color: number; alpha: number } {
    switch (phase) {
      case "dawn":      return { color: 0xFFB347, alpha: 0.08 };
      case "morning":   return { color: 0x000000, alpha: 0 };
      case "afternoon": return { color: 0xFFF5CC, alpha: 0.05 };
      case "evening":   return { color: 0xFF8C42, alpha: 0.12 };
      case "night":     return { color: 0x1A1F3C, alpha: 0.55 };
      default:
        return { color: 0x000000, alpha: 0 };
    }
  }

  destroy() {
    this.overlay.destroy();
  }
}
