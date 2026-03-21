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
      case "dawn":
        return { color: 0xffa050, alpha: 0.15 };
      case "morning":
        return { color: 0x000000, alpha: 0 };
      case "afternoon":
        return { color: 0x000000, alpha: 0 };
      case "evening":
        return { color: 0xff8c00, alpha: 0.2 };
      case "night":
        return { color: 0x1a1a4e, alpha: 0.4 };
      default:
        return { color: 0x000000, alpha: 0 };
    }
  }

  destroy() {
    this.overlay.destroy();
  }
}
