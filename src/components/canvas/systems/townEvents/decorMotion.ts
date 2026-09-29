import type { DecorMotion } from "./eventDecor";

/**
 * Per-frame offset of a moving decoration, from time alone. Pure and allocation-free: the caller
 * owns one `MotionOut` and reuses it for every placement, every frame.
 */
export interface MotionOut {
  /** Offset from the placement's rest position, in world px. */
  dx: number;
  dy: number;
  /** 0..1, multiplied into the sprite's alpha (particles fade in and out of their fall). */
  alpha: number;
  /** False once an `arrive` has come to rest: the renderer stops the wheel animation. */
  moving: boolean;
}

export function newMotionOut(): MotionOut {
  return { dx: 0, dy: 0, alpha: 1, moving: true };
}

/** Fraction of each fall spent fading in and out. */
const FALL_FADE = 0.2;

/**
 * @param t     seconds on a steady clock (drives the looping motions)
 * @param phase 0..1, the placement's stagger
 * @param age   seconds since the decoration appeared (drives `arrive`)
 */
export function motionAt(m: DecorMotion, t: number, phase: number, age: number, out: MotionOut): void {
  out.alpha = 1;
  out.moving = true;
  switch (m.kind) {
    case "fall": {
      const x = t / m.period + phase;
      const u = x - Math.floor(x);
      out.dx = m.dx * u;
      out.dy = m.dy * u;
      out.alpha = Math.min(1, u / FALL_FADE, (1 - u) / FALL_FADE);
      return;
    }
    case "wander": {
      const a = (t / m.period + phase) * Math.PI * 2;
      // Two incommensurate sines: the path never reads as a circle.
      out.dx = m.rx * Math.sin(a);
      out.dy = m.ry * Math.sin(a * 2 + 1.3);
      return;
    }
    case "arrive": {
      const u = Math.max(0, Math.min(1, age / m.period));
      // Ease-out cubic: a cart pulling up brakes as it reaches the door.
      const rest = (1 - u) * (1 - u) * (1 - u);
      out.dx = m.dx * rest;
      out.dy = m.dy * rest;
      out.moving = u < 1;
      return;
    }
  }
}

/** World-space extent a motion adds around the rest position, for the whole-group view cull. */
export function motionExtent(m: DecorMotion): { x0: number; x1: number; y0: number; y1: number } {
  switch (m.kind) {
    case "fall": return { x0: Math.min(0, m.dx), x1: Math.max(0, m.dx), y0: Math.min(0, m.dy), y1: Math.max(0, m.dy) };
    case "wander": return { x0: -m.rx, x1: m.rx, y0: -m.ry, y1: m.ry };
    case "arrive": return { x0: Math.min(0, m.dx), x1: Math.max(0, m.dx), y0: Math.min(0, m.dy), y1: Math.max(0, m.dy) };
  }
}
