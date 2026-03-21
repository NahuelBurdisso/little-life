/**
 * Generate placeholder PNG assets for Little Life.
 *
 * Creates minimal but valid PNG files for every asset path the frontend references.
 * These are simple solid-color rectangles — good enough for PixiJS to load and render.
 *
 * Run: node scripts/generate-placeholders.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PUBLIC = path.join(__dirname, "..", "public");

// ── PNG encoder (no dependencies) ──────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/**
 * Create a valid PNG with a solid color or a grid pattern.
 * @param {number} w - width
 * @param {number} h - height
 * @param {number[]} rgba - [r, g, b, a]
 * @param {object} [opts] - options
 * @param {number} [opts.gridSize] - if set, draw a grid with darker lines every gridSize pixels
 * @param {number[][]} [opts.regions] - colored rectangles: [x, y, w, h, r, g, b, a]
 */
function createPNG(w, h, rgba, opts = {}) {
  // Build raw pixel data (filter byte + RGBA per row)
  const raw = Buffer.alloc(h * (1 + w * 4));
  const [r, g, b, a] = rgba;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * (1 + w * 4);
    raw[rowOffset] = 0; // no filter
    for (let x = 0; x < w; x++) {
      const px = rowOffset + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  // Draw grid lines
  if (opts.gridSize) {
    const gs = opts.gridSize;
    for (let y = 0; y < h; y++) {
      const rowOffset = y * (1 + w * 4);
      for (let x = 0; x < w; x++) {
        if (x % gs === 0 || y % gs === 0) {
          const px = rowOffset + 1 + x * 4;
          // Darken by 40
          raw[px] = Math.max(0, r - 40);
          raw[px + 1] = Math.max(0, g - 40);
          raw[px + 2] = Math.max(0, b - 40);
          raw[px + 3] = a;
        }
      }
    }
  }

  // Draw colored regions
  if (opts.regions) {
    for (const reg of opts.regions) {
      const [rx, ry, rw, rh, rr, rg, rb, ra] = reg;
      for (let y = ry; y < ry + rh && y < h; y++) {
        const rowOffset = y * (1 + w * 4);
        for (let x = rx; x < rx + rw && x < w; x++) {
          const px = rowOffset + 1 + x * 4;
          raw[px] = rr;
          raw[px + 1] = rg;
          raw[px + 2] = rb;
          raw[px + 3] = ra;
        }
      }
    }
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // signature
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function write(relPath, buf) {
  const full = path.join(PUBLIC, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  console.log(`  ${relPath} (${buf.length} bytes)`);
}

// ── Agent colors (12 agents) ───────────────────────────────────────────────

const AGENT_COLORS = [
  [231, 76, 60],   // red
  [46, 204, 113],  // green
  [52, 152, 219],  // blue
  [241, 196, 15],  // yellow
  [155, 89, 182],  // purple
  [230, 126, 34],  // orange
  [26, 188, 156],  // teal
  [236, 112, 160], // pink
  [149, 165, 166], // gray
  [52, 73, 94],    // dark blue
  [211, 84, 0],    // dark orange
  [39, 174, 96],   // emerald
];

// ── Generate assets ────────────────────────────────────────────────────────

console.log("Generating placeholder assets...\n");

// 1. Tilesets — terrain.png: 256x256 green grid (8x8 tiles of 32x32)
console.log("Tilesets:");
write(
  "tilesets/terrain.png",
  createPNG(256, 256, [76, 153, 76, 255], { gridSize: 32 })
);
write(
  "tilesets/buildings.png",
  createPNG(256, 256, [139, 119, 101, 255], { gridSize: 32 })
);

// 2. Agent sprite sheets — 128x128 (4 cols x 4 rows of 32x32 frames)
// Each frame is a solid color with a slightly different shade per direction
console.log("\nAgent sprites:");
for (let i = 0; i < 12; i++) {
  const [cr, cg, cb] = AGENT_COLORS[i];
  const regions = [];
  // 4 directions (rows) x 4 walk frames (cols)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const shade = 1 - row * 0.05 - col * 0.02;
      // Draw a body shape: a filled rectangle in the center of each 32x32 cell
      const ox = col * 32;
      const oy = row * 32;
      // Body (center 20x24 within each 32x32 tile)
      regions.push([
        ox + 6, oy + 4, 20, 24,
        Math.round(cr * shade), Math.round(cg * shade), Math.round(cb * shade), 255,
      ]);
      // Head (smaller rectangle on top)
      regions.push([
        ox + 10, oy + 2, 12, 10,
        Math.min(255, Math.round(cr * shade + 30)),
        Math.min(255, Math.round(cg * shade + 30)),
        Math.min(255, Math.round(cb * shade + 30)),
        255,
      ]);
    }
  }
  const idx = String(i + 1).padStart(2, "0");
  write(
    `sprites/agents/agent-${idx}.png`,
    createPNG(128, 128, [0, 0, 0, 0], { regions })
  );
}

// 3. Portraits — 64x64
console.log("\nPortraits:");
for (let i = 0; i < 12; i++) {
  const [cr, cg, cb] = AGENT_COLORS[i];
  const regions = [
    // Face circle approximation (rounded square)
    [8, 8, 48, 48, cr, cg, cb, 255],
    // Eyes
    [18, 24, 8, 6, 255, 255, 255, 255],
    [38, 24, 8, 6, 255, 255, 255, 255],
    // Pupils
    [20, 26, 4, 4, 40, 40, 40, 255],
    [40, 26, 4, 4, 40, 40, 40, 255],
    // Mouth
    [24, 38, 16, 4, 200, 100, 100, 255],
  ];
  const idx = String(i + 1).padStart(2, "0");
  write(
    `sprites/portraits/portrait-${idx}.png`,
    createPNG(64, 64, [220, 220, 220, 255], { regions })
  );
}

// 4. Emotes — 24x24
console.log("\nEmotes:");
const EMOTE_COLORS = {
  heart: [220, 50, 50, 255],
  anger: [200, 30, 30, 255],
  laugh: [255, 220, 50, 255],
  wave: [100, 180, 255, 255],
  question: [200, 200, 50, 255],
  exclaim: [255, 100, 50, 255],
  zzz: [150, 150, 220, 255],
  cry: [100, 150, 255, 255],
};
for (const [name, color] of Object.entries(EMOTE_COLORS)) {
  write(`sprites/emotes/${name}.png`, createPNG(24, 24, color));
}

// 5. UI bubbles — speech: 128x64 white, thought: 128x64 light gray
console.log("\nUI:");
write(
  "ui/bubble-speech.png",
  createPNG(128, 64, [255, 255, 255, 230], {
    regions: [
      // border
      [0, 0, 128, 2, 180, 180, 180, 255],
      [0, 62, 128, 2, 180, 180, 180, 255],
      [0, 0, 2, 64, 180, 180, 180, 255],
      [126, 0, 2, 64, 180, 180, 180, 255],
    ],
  })
);
write(
  "ui/bubble-thought.png",
  createPNG(128, 64, [240, 240, 255, 200], {
    regions: [
      [0, 0, 128, 2, 200, 200, 220, 255],
      [0, 62, 128, 2, 200, 200, 220, 255],
      [0, 0, 2, 64, 200, 200, 220, 255],
      [126, 0, 2, 64, 200, 200, 220, 255],
    ],
  })
);

console.log("\nDone! All placeholder assets generated.");
