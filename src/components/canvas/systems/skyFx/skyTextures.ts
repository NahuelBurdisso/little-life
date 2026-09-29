import * as PIXI from "pixi.js";

/**
 * The three soft shapes the sky system tints and stretches: a radial blob (cloud shadow, moon
 * halo, mist), a vertical beam (a shaft of light) and a streak (a shooting star). They are painted
 * with a 2D canvas gradient once and shared, because a smooth falloff is exactly what a 32-colour
 * pixel atlas cannot do: the hard alpha steps would show as rings once scaled up 10x.
 *
 * Returns null when there is no DOM (tests), and the system then simply draws nothing.
 */
export interface SkyTextures {
  blob: PIXI.Texture;
  beam: PIXI.Texture;
  streak: PIXI.Texture;
}

function paint(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): PIXI.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return null;
  draw(g);
  return PIXI.Texture.from(canvas);
}

export function createSkyTextures(): SkyTextures | null {
  const blob = paint(64, 64, g => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    // Several stops approximate a smoothstep: a plain two-stop gradient leaves a visible rim.
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.78)");
    grad.addColorStop(0.65, "rgba(255,255,255,0.26)");
    grad.addColorStop(0.88, "rgba(255,255,255,0.05)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
  const beam = paint(32, 128, g => {
    // Soft across, fading out along its length; the top is the brightest, where the light enters.
    const across = g.createLinearGradient(0, 0, 32, 0);
    across.addColorStop(0, "rgba(255,255,255,0)");
    across.addColorStop(0.5, "rgba(255,255,255,1)");
    across.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = across;
    g.fillRect(0, 0, 32, 128);
    g.globalCompositeOperation = "destination-in";
    const along = g.createLinearGradient(0, 0, 0, 128);
    along.addColorStop(0, "rgba(0,0,0,0.9)");
    along.addColorStop(0.6, "rgba(0,0,0,0.35)");
    along.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = along;
    g.fillRect(0, 0, 32, 128);
  });
  const streak = paint(128, 8, g => {
    // A tapering tail (transparent, thin) into a bright head on the right.
    const grad = g.createLinearGradient(0, 0, 128, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.7, "rgba(255,255,255,0.45)");
    grad.addColorStop(1, "rgba(255,255,255,1)");
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 4);
    g.lineTo(120, 2);
    g.lineTo(128, 4);
    g.lineTo(120, 6);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(255,255,255,1)";
    g.beginPath();
    g.arc(122, 4, 2.2, 0, Math.PI * 2);
    g.fill();
  });
  if (!blob || !beam || !streak) {
    blob?.destroy(true); beam?.destroy(true); streak?.destroy(true);
    return null;
  }
  return { blob, beam, streak };
}
