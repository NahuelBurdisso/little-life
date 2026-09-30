/**
 * A tiny RGBA raster for the resident art generator. Pure — no DOM, no PixiJS — so the
 * generator runs (and is unit tested) under Node, and the client only has to copy the finished
 * bytes into a canvas (`ImageData` takes the same layout).
 *
 * Colours are packed `0xRRGGBBAA` numbers: comparing two pixels is `===`, which is how the
 * Aseprite scripts reason about line work too (`isInk` tests the exact outline colour).
 */
export type RGBA = number;

export interface PixelImage {
  readonly w: number;
  readonly h: number;
  /** Row-major RGBA bytes, `ImageData`-compatible. */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

const TRANSPARENT: RGBA = 0;

/** `hex("1a1510")` → opaque colour; `hex("0a0806", 0x6e)` → translucent (drop shadows). */
export function hex(rgb: string, alpha = 255): RGBA {
  return ((parseInt(rgb, 16) << 8) | (alpha & 255)) >>> 0;
}

function channels(c: RGBA): [number, number, number, number] {
  return [(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255];
}

function pack(r: number, g: number, b: number, a: number): RGBA {
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return ((cl(r) << 24) | (cl(g) << 16) | (cl(b) << 8) | cl(a)) >>> 0;
}

/** Perceived brightness 0..255 (the Lua scripts' `luma`). */
export function luma(c: RGBA): number {
  const [r, g, b] = channels(c);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Scale the RGB of a colour (k < 1 darkens), keeping its alpha. */
export function shade(c: RGBA, k: number): RGBA {
  const [r, g, b, a] = channels(c);
  return pack(r * k, g * k, b * k, a);
}

/** Blend `c` toward `toward` by `k` (0 = c, 1 = toward), keeping c's alpha. */
export function mix(c: RGBA, toward: RGBA, k: number): RGBA {
  const [r, g, b, a] = channels(c);
  const [tr, tg, tb] = channels(toward);
  return pack(r + (tr - r) * k, g + (tg - g) * k, b + (tb - b) * k, a);
}

export function createImage(w: number, h: number): PixelImage {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneImage(img: PixelImage): PixelImage {
  return { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
}

/** Outside the image reads as transparent, like the Lua scripts' `get`. */
export function getPixel(img: PixelImage, x: number, y: number): RGBA {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return TRANSPARENT;
  const i = (y * img.w + x) * 4;
  const d = img.data;
  return ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
}

/** Writes are clipped, so drawing code can overshoot an edge without bounds checks. */
export function setPixel(img: PixelImage, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 4;
  img.data[i] = (c >>> 24) & 255;
  img.data[i + 1] = (c >>> 16) & 255;
  img.data[i + 2] = (c >>> 8) & 255;
  img.data[i + 3] = c & 255;
}

/** Copy `src` into `dst` at (dx, dy), transparent pixels included (a straight replace). */
export function blit(dst: PixelImage, src: PixelImage, dx: number, dy: number): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) setPixel(dst, dx + x, dy + y, getPixel(src, x, y));
  }
}

/**
 * Paint one row from a "pixel string", the way the base sprites read when dumped as text:
 * each character is looked up in `pal`, `.` and characters missing from `pal` leave the pixel
 * alone. Keeps the body templates legible — a row of code looks like the row of pixels.
 */
export function paintRow(
  img: PixelImage,
  y: number,
  x0: number,
  row: string,
  pal: Readonly<Record<string, RGBA>>,
): void {
  for (let i = 0; i < row.length; i++) {
    const c = pal[row[i]];
    if (c !== undefined) setPixel(img, x0 + i, y, c);
  }
}
