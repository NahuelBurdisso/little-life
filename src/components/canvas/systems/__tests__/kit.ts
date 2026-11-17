import type { CanvasServices, DataContext } from '../types';

/**
 * Shared pieces for the canvas systems' tests.
 *
 * A system test hands its system a fake of what GameCanvas gives it: a sprite pool that
 * answers `getSprite`, a bubble system that records `showEmote`. Those fakes implement a
 * method or two of large classes, so somewhere a cast has to say "this stands in for the
 * real one". It lives here, once, instead of as `as any` in every file, which also turned
 * off type checking for everything else on the same line.
 */

/** Services built from the few members a test implements. */
export function fakeServices(sprites: object, bubbles: object = {}): CanvasServices {
  return { sprites, bubbles } as unknown as CanvasServices;
}

/** `frame.data` before the first server poll: systems must not touch it in `update`. */
export const NO_DATA = null as unknown as DataContext;

/**
 * A value the code under test must survive but its types rule out (a `null` row from a
 * bad save, a string where a number goes). Typed as whatever the callee expects.
 */
export function invalid<T>(value: unknown): T {
  return value as T;
}

/**
 * A display object as the headless PixiJS stand-ins expose it (the `vi.mock('pixi.js')`
 * classes in the system tests): just the fields the assertions read. Textures there are
 * plain `{ frame }` records, which is what lets a test ask "which frame is showing".
 */
export interface FakeNode {
  visible: boolean;
  alpha: number;
  tint?: number;
  blendMode?: string;
  destroyed?: boolean;
  texture: { frame: number; url?: string };
  position: { x: number; y: number };
  /** The fake container holding it; compared against the test's own (mocked) containers. */
  parent: object | null;
  children: FakeNode[];
}

/** Read a (mocked) PIXI container as the fake it is at runtime. */
export function fakeOf(node: object): FakeNode {
  return node as unknown as FakeNode;
}

/** The visible children of a (mocked) container. */
export function visibleIn(container: object): FakeNode[] {
  return fakeOf(container).children.filter((s) => s.visible);
}
