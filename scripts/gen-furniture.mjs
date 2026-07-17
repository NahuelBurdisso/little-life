/**
 * gen-furniture.mjs
 * Generates 32x32 RGBA PNG furniture sprites for Little Life.
 * Source specs: docs/scratch/proposal-visual.md §2.
 * Palette:      24 swatches, max 8 per sprite, hard outlines, no AA.
 * Output:       public/sprites/furniture/<key>.png
 *
 * Usage: node scripts/gen-furniture.mjs
 */

import { PNG } from 'pngjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../public/sprites/furniture');

// ---------------------------------------------------------------------------
// 24-swatch master palette
// ---------------------------------------------------------------------------
const P = {
  OUTLINE:    '#1a1510',
  SHADOW:     '#2e2418',
  DARK_WOOD:  '#4a3020',
  MID_WOOD:   '#7a5030',
  LIGHT_WOOD: '#b07840',
  TAN:        '#d4a870',
  LINEN:      '#e8d5a3',
  STONE_DK:   '#3a3830',
  STONE_MD:   '#5a5850',
  STONE_LT:   '#8a8878',
  MORTAR:     '#6a6858',
  IRON_DK:    '#2a2828',
  IRON_MD:    '#484442',
  IRON_LT:    '#706a60',
  EMBER_DK:   '#6a1800',
  EMBER_MD:   '#c04010',
  EMBER_LT:   '#f07020',
  FORGE_GLW:  '#ffb040',
  GREEN_DK:   '#2a4020',
  GREEN_MD:   '#4a6830',
  CREAM:      '#e0d8c0',
  WHITE_LT:   '#f0ece0',
  BLUE_DARK:  '#1a2840',
  BLUE_MID:   '#2a4870',
  GOLD:       '#c09020',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexToRgba(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
}

function createCanvas() {
  // 32x32 RGBA, all transparent
  return new Uint8Array(32 * 32 * 4).fill(0);
}

function setPixel(buf, x, y, rgba) {
  if (x < 0 || x >= 32 || y < 0 || y >= 32) return;
  const i = (y * 32 + x) * 4;
  buf[i]     = rgba[0];
  buf[i + 1] = rgba[1];
  buf[i + 2] = rgba[2];
  buf[i + 3] = rgba[3];
}

function getPixel(buf, x, y) {
  if (x < 0 || x >= 32 || y < 0 || y >= 32) return [0, 0, 0, 0];
  const i = (y * 32 + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

function fillRect(buf, x, y, w, h, colorHex) {
  const rgba = hexToRgba(colorHex);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(buf, x + dx, y + dy, rgba);
    }
  }
}

// 1px outline pass: any opaque pixel adjacent to transparent gets OUTLINE border
function applyOutline(buf) {
  const outlineRgba = hexToRgba(P.OUTLINE);
  const NEIGHBORS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
  const copy = new Uint8Array(buf);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const [,,,a] = getPixel(copy, x, y);
      if (a === 0) {
        // transparent — check if any neighbor is opaque; if so, paint outline
        for (const [nx, ny] of NEIGHBORS) {
          const [,,,na] = getPixel(copy, x + nx, y + ny);
          if (na > 0) {
            setPixel(buf, x, y, outlineRgba);
            break;
          }
        }
      }
    }
  }
}

function savePNG(key, buf) {
  const png = new PNG({ width: 32, height: 32 });
  png.data = Buffer.from(buf);
  const outPath = path.join(OUT_DIR, `${key}.png`);
  const stream = fs.createWriteStream(outPath);
  png.pack().pipe(stream);
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Sprite specs — one function per sprite
// ---------------------------------------------------------------------------

function drawStove() {
  const b = createCanvas();
  // Body: 20x18 IRON_MD centered
  fillRect(b, 6, 7, 20, 18, P.IRON_MD);
  // Top surface: IRON_DK slab
  fillRect(b, 6, 7, 20, 4, P.IRON_DK);
  // Left burner: 6px circle approximated by 5x5 diamond
  fillRect(b, 9, 4, 6, 6, P.IRON_LT);
  setPixel(b, 9, 4, hexToRgba(P.IRON_MD));
  setPixel(b, 14, 4, hexToRgba(P.IRON_MD));
  setPixel(b, 9, 9, hexToRgba(P.IRON_MD));
  setPixel(b, 14, 9, hexToRgba(P.IRON_MD));
  // Ember dot center left burner
  setPixel(b, 12, 7, hexToRgba(P.EMBER_MD));
  // Right burner
  fillRect(b, 17, 4, 6, 6, P.IRON_LT);
  setPixel(b, 17, 4, hexToRgba(P.IRON_MD));
  setPixel(b, 22, 4, hexToRgba(P.IRON_MD));
  setPixel(b, 17, 9, hexToRgba(P.IRON_MD));
  setPixel(b, 22, 9, hexToRgba(P.IRON_MD));
  setPixel(b, 20, 7, hexToRgba(P.EMBER_MD));
  // Pipe stem: 4x8 IRON_DK top-right
  fillRect(b, 22, 0, 4, 8, P.IRON_DK);
  applyOutline(b);
  return b;
}

function drawCounter() {
  const b = createCanvas();
  // 28x12 MID_WOOD plank across bottom-center
  fillRect(b, 2, 16, 28, 12, P.MID_WOOD);
  // 3 vertical plank lines in DARK_WOOD
  fillRect(b, 9,  16, 1, 12, P.DARK_WOOD);
  fillRect(b, 16, 16, 1, 12, P.DARK_WOOD);
  fillRect(b, 23, 16, 1, 12, P.DARK_WOOD);
  // Lip overhang: 2px SHADOW along top edge
  fillRect(b, 2, 16, 28, 2, P.SHADOW);
  applyOutline(b);
  return b;
}

function drawShelves() {
  const b = createCanvas();
  // 2 vertical supports DARK_WOOD
  fillRect(b, 2, 2, 3, 28, P.DARK_WOOD);
  fillRect(b, 27, 2, 3, 28, P.DARK_WOOD);
  // 3 horizontal shelves TAN, evenly spaced
  fillRect(b, 2, 4,  28, 4, P.TAN);
  fillRect(b, 2, 14, 28, 4, P.TAN);
  fillRect(b, 2, 24, 28, 4, P.TAN);
  // Small colored "items" on middle shelf
  fillRect(b, 6, 15,  3, 3, P.CREAM);
  fillRect(b, 12, 15, 3, 3, P.STONE_LT);
  fillRect(b, 18, 15, 3, 3, P.CREAM);
  applyOutline(b);
  return b;
}

function drawBarCounter() {
  const b = createCanvas();
  // 28x14 DARK_WOOD base
  fillRect(b, 2, 14, 28, 14, P.DARK_WOOD);
  // LIGHT_WOOD top surface strip
  fillRect(b, 2, 14, 28, 4, P.LIGHT_WOOD);
  // Plank texture lines on front face
  fillRect(b, 9,  18, 1, 10, P.MID_WOOD);
  fillRect(b, 16, 18, 1, 10, P.MID_WOOD);
  fillRect(b, 23, 18, 1, 10, P.MID_WOOD);
  // 3 bottle shapes on top surface
  // Bottle 1
  fillRect(b, 5,  7, 4, 8, P.BLUE_DARK);
  fillRect(b, 6,  6, 2, 2, P.BLUE_DARK);
  setPixel(b, 6, 7, hexToRgba(P.CREAM));
  // Bottle 2
  fillRect(b, 13, 7, 4, 8, P.BLUE_DARK);
  fillRect(b, 14, 6, 2, 2, P.BLUE_DARK);
  setPixel(b, 14, 7, hexToRgba(P.CREAM));
  // Bottle 3
  fillRect(b, 21, 7, 4, 8, P.BLUE_DARK);
  fillRect(b, 22, 6, 2, 2, P.BLUE_DARK);
  setPixel(b, 22, 7, hexToRgba(P.CREAM));
  applyOutline(b);
  return b;
}

function drawStage() {
  const b = createCanvas();
  // Raised platform 28x20 MID_WOOD
  fillRect(b, 2, 8, 28, 20, P.MID_WOOD);
  // 3px DARK_WOOD edge shadow (bottom + right)
  fillRect(b, 2, 25, 28, 3, P.DARK_WOOD);
  fillRect(b, 27, 8, 3, 20, P.DARK_WOOD);
  // Stage lip: 2px LIGHT_WOOD highlight strip at top
  fillRect(b, 2, 8, 28, 2, P.LIGHT_WOOD);
  // Music note glyph in GOLD — 3 pixels
  fillRect(b, 14, 15, 3, 6, P.GOLD);  // stem
  fillRect(b, 14, 15, 5, 3, P.GOLD);  // flag
  fillRect(b, 12, 19, 4, 3, P.GOLD);  // note head
  applyOutline(b);
  return b;
}

function drawBoothSeat() {
  const b = createCanvas();
  // Two seat pads, 10x8 DARK_WOOD, flanking center
  fillRect(b, 2,  18, 10, 8, P.DARK_WOOD);
  fillRect(b, 20, 18, 10, 8, P.DARK_WOOD);
  // Back cushion 26x6 across top
  fillRect(b, 3, 10, 26, 6, P.DARK_WOOD);
  // Table surface 12x8 STONE_MD between seats
  fillRect(b, 10, 18, 12, 8, P.STONE_MD);
  applyOutline(b);
  return b;
}

function drawReceptionDesk() {
  const b = createCanvas();
  // 24x16 MID_WOOD base centered
  fillRect(b, 4, 12, 24, 16, P.MID_WOOD);
  // White clipboard rect 8x10 on surface
  fillRect(b, 12, 6, 8, 10, P.WHITE_LT);
  // Clipboard outline
  fillRect(b, 12, 6, 8, 1, P.OUTLINE);
  fillRect(b, 12, 15, 8, 1, P.OUTLINE);
  fillRect(b, 12, 6, 1, 10, P.OUTLINE);
  fillRect(b, 19, 6, 1, 10, P.OUTLINE);
  // Red cross 5x5 EMBER_MD top-left of surface
  fillRect(b, 5, 13, 5, 1, P.EMBER_MD);  // horizontal bar
  fillRect(b, 7, 11, 1, 5, P.EMBER_MD);  // vertical bar
  applyOutline(b);
  return b;
}

function drawPatientBed() {
  const b = createCanvas();
  // Frame: IRON_MD (metal, not wood)
  fillRect(b, 4, 4, 24, 24, P.IRON_MD);
  // Mattress: WHITE_LT
  fillRect(b, 6, 6, 20, 18, P.WHITE_LT);
  // Pillow: CREAM with border
  fillRect(b, 8, 7, 8, 6, P.CREAM);
  // Side rails: 2px IRON_LT strips along long edges
  fillRect(b, 4, 6,  2, 18, P.IRON_LT);
  fillRect(b, 26, 6, 2, 18, P.IRON_LT);
  // Headboard IRON_DK
  fillRect(b, 4, 4, 24, 2, P.IRON_DK);
  applyOutline(b);
  return b;
}

function drawMayorsDesk() {
  const b = createCanvas();
  // 28x16 DARK_WOOD base
  fillRect(b, 2, 12, 28, 16, P.DARK_WOOD);
  // Carved-panel indentations: 4px wide dark lines on front face
  fillRect(b, 5, 20, 4, 6, P.SHADOW);
  fillRect(b, 13, 20, 4, 6, P.SHADOW);
  fillRect(b, 21, 20, 4, 6, P.SHADOW);
  // GOLD nameplate rect 12x4 on surface center
  fillRect(b, 10, 13, 12, 4, P.GOLD);
  // Stack of papers CREAM top-right
  fillRect(b, 20, 8, 8, 6, P.CREAM);
  // Paper lines
  fillRect(b, 21, 10, 6, 1, P.SHADOW);
  fillRect(b, 21, 12, 6, 1, P.SHADOW);
  applyOutline(b);
  return b;
}

function drawMeetingTable() {
  const b = createCanvas();
  // 28x20 MID_WOOD rect (oval approximated with corner notches)
  fillRect(b, 2, 6, 28, 20, P.MID_WOOD);
  // Corner notches
  fillRect(b, 2,  6,  4, 4, P.IRON_MD); // transparent-looking notches via background color
  setPixel(b, 2, 6, [0,0,0,0]);
  setPixel(b, 3, 6, [0,0,0,0]);
  setPixel(b, 2, 7, [0,0,0,0]);
  setPixel(b, 29, 6, [0,0,0,0]);
  setPixel(b, 30, 6, [0,0,0,0]);   // out of range, ignored
  setPixel(b, 29, 7, [0,0,0,0]);
  setPixel(b, 2, 25, [0,0,0,0]);
  setPixel(b, 3, 25, [0,0,0,0]);
  setPixel(b, 2, 24, [0,0,0,0]);
  setPixel(b, 29, 25, [0,0,0,0]);
  setPixel(b, 29, 24, [0,0,0,0]);
  // LIGHT_WOOD center highlight
  fillRect(b, 8, 11, 16, 10, P.LIGHT_WOOD);
  // 6 chair indicators (4x4 DARK_WOOD) around perimeter
  fillRect(b, 2, 8,   4, 4, P.DARK_WOOD);  // left top
  fillRect(b, 2, 18,  4, 4, P.DARK_WOOD);  // left bottom
  fillRect(b, 26, 8,  4, 4, P.DARK_WOOD);  // right top
  fillRect(b, 26, 18, 4, 4, P.DARK_WOOD);  // right bottom
  fillRect(b, 14, 2,  4, 4, P.DARK_WOOD);  // top center
  fillRect(b, 14, 26, 4, 4, P.DARK_WOOD);  // bottom center
  applyOutline(b);
  return b;
}

function drawFilingCabinet() {
  const b = createCanvas();
  // 12x28 IRON_MD tall portrait
  fillRect(b, 10, 2, 12, 28, P.IRON_MD);
  // 3 drawer lines at 8px intervals
  fillRect(b, 10, 11, 12, 1, P.IRON_DK);
  fillRect(b, 10, 20, 12, 1, P.IRON_DK);
  // Drawer pulls: 2px IRON_LT centered per drawer
  fillRect(b, 15, 6, 2, 2, P.IRON_LT);
  fillRect(b, 15, 15, 2, 2, P.IRON_LT);
  fillRect(b, 15, 24, 2, 2, P.IRON_LT);
  applyOutline(b);
  return b;
}

function drawOven() {
  const b = createCanvas();
  // 24x22 STONE_MD body
  fillRect(b, 4, 6, 24, 22, P.STONE_MD);
  // Top surface STONE_LT slab
  fillRect(b, 4, 6, 24, 4, P.STONE_LT);
  // Arched opening 10x8 IRON_DK
  fillRect(b, 11, 14, 10, 8, P.IRON_DK);
  // Arch top: round off with pixels
  setPixel(b, 11, 14, [0,0,0,0]);
  setPixel(b, 20, 14, [0,0,0,0]);
  // EMBER_LT glow inside arch 3x4
  fillRect(b, 14, 17, 3, 4, P.EMBER_LT);
  // Chimney pipe 4x6 IRON_DK top-right
  fillRect(b, 24, 0, 4, 6, P.IRON_DK);
  applyOutline(b);
  return b;
}

function drawPrepTable() {
  const b = createCanvas();
  // 28x14 LIGHT_WOOD surface
  fillRect(b, 2, 14, 28, 14, P.LIGHT_WOOD);
  // Flour scatter: 6 WHITE_LT pixels
  setPixel(b, 6,  17, hexToRgba(P.WHITE_LT));
  setPixel(b, 10, 20, hexToRgba(P.WHITE_LT));
  setPixel(b, 15, 16, hexToRgba(P.WHITE_LT));
  setPixel(b, 20, 22, hexToRgba(P.WHITE_LT));
  setPixel(b, 24, 18, hexToRgba(P.WHITE_LT));
  setPixel(b, 8,  24, hexToRgba(P.WHITE_LT));
  // Rolling pin diagonal 3x12 CREAM with OUTLINE ends
  for (let i = 0; i < 12; i++) {
    fillRect(b, 10 + i, 6 + i, 3, 1, P.CREAM);
  }
  // End caps OUTLINE
  fillRect(b, 10, 6, 3, 1, P.OUTLINE);
  fillRect(b, 21, 17, 3, 1, P.OUTLINE);
  applyOutline(b);
  return b;
}

function drawWorkbench() {
  const b = createCanvas();
  // 28x16 DARK_WOOD base, thick
  fillRect(b, 2, 12, 28, 16, P.DARK_WOOD);
  // Thick legs
  fillRect(b, 2, 24, 6, 4, P.SHADOW);
  fillRect(b, 24, 24, 6, 4, P.SHADOW);
  // Surface: scattered 3px IRON_LT tool shapes
  fillRect(b, 8, 13, 3, 3, P.IRON_LT);
  fillRect(b, 16, 14, 3, 3, P.IRON_LT);
  fillRect(b, 23, 13, 3, 3, P.IRON_LT);
  // Clamp on left edge: 6x6 IRON_MD with 2px screw
  fillRect(b, 2, 14, 6, 6, P.IRON_MD);
  fillRect(b, 4, 16, 2, 2, P.IRON_LT);  // screw circle
  applyOutline(b);
  return b;
}

function drawToolRack() {
  const b = createCanvas();
  // 28x24 DARK_WOOD backing panel
  fillRect(b, 2, 4, 28, 24, P.DARK_WOOD);
  // 4 peg rows: IRON_MD pegs (3px horizontal each)
  for (let row = 0; row < 4; row++) {
    const y = 8 + row * 5;
    fillRect(b, 5, y, 22, 2, P.MID_WOOD);  // peg rail
    // 3 pegs per row
    fillRect(b, 7,  y - 2, 2, 3, P.IRON_MD);
    fillRect(b, 15, y - 2, 2, 3, P.IRON_MD);
    fillRect(b, 23, y - 2, 2, 3, P.IRON_MD);
  }
  // Hammer silhouettes (2): IRON_LT
  fillRect(b, 6,  2, 4, 6, P.IRON_LT);   // hammer head 1
  fillRect(b, 7,  6, 2, 8, P.IRON_LT);   // hammer handle 1
  fillRect(b, 20, 2, 4, 6, P.IRON_LT);   // hammer head 2
  fillRect(b, 21, 6, 2, 8, P.IRON_LT);   // hammer handle 2
  // Saw silhouette: IRON_LT 8px
  fillRect(b, 12, 2, 8, 3, P.IRON_LT);   // saw blade
  // Saw teeth: small notches
  setPixel(b, 13, 2, hexToRgba(P.DARK_WOOD));
  setPixel(b, 15, 2, hexToRgba(P.DARK_WOOD));
  setPixel(b, 17, 2, hexToRgba(P.DARK_WOOD));
  applyOutline(b);
  return b;
}

function drawForge() {
  const b = createCanvas();
  // 20x20 STONE_DK stone base, irregular top edge
  fillRect(b, 6, 8, 20, 20, P.STONE_DK);
  // Irregular top: 2px notch
  setPixel(b, 6,  8, hexToRgba(P.STONE_MD));
  setPixel(b, 8,  8, hexToRgba(P.STONE_MD));
  setPixel(b, 25, 8, hexToRgba(P.STONE_MD));
  // Coal bed: 16x6 IRON_DK
  fillRect(b, 8, 18, 16, 6, P.IRON_DK);
  // EMBER_DK + EMBER_MD scatter on coal
  fillRect(b, 10, 19, 3, 2, P.EMBER_DK);
  fillRect(b, 16, 20, 4, 2, P.EMBER_MD);
  setPixel(b, 21, 19, hexToRgba(P.EMBER_DK));
  // Flame core: 8x6 EMBER_LT
  fillRect(b, 12, 10, 8, 6, P.EMBER_LT);
  // Tip pixel FORGE_GLW
  setPixel(b, 16, 8, hexToRgba(P.FORGE_GLW));
  setPixel(b, 15, 9, hexToRgba(P.FORGE_GLW));
  setPixel(b, 17, 9, hexToRgba(P.FORGE_GLW));
  applyOutline(b);
  return b;
}

function drawGuardDesk() {
  const b = createCanvas();
  // 24x14 DARK_WOOD base
  fillRect(b, 4, 14, 24, 14, P.DARK_WOOD);
  // Iron badge: 8x8 IRON_LT on surface (star: center square + 4 cardinal pixels)
  fillRect(b, 12, 10, 4, 4, P.IRON_LT);   // center square
  setPixel(b, 13, 8,  hexToRgba(P.IRON_LT));  // north
  setPixel(b, 13, 14, hexToRgba(P.IRON_LT));  // south
  setPixel(b, 10, 11, hexToRgba(P.IRON_LT));  // west
  setPixel(b, 16, 11, hexToRgba(P.IRON_LT));  // east
  // Badge center accent
  setPixel(b, 13, 11, hexToRgba(P.GOLD));
  // Key ring: 3px circle IRON_MD bottom-right corner
  fillRect(b, 22, 24, 4, 4, P.IRON_MD);
  setPixel(b, 23, 25, hexToRgba(P.IRON_LT)); // ring highlight
  applyOutline(b);
  return b;
}

// ---------------------------------------------------------------------------
// Sprite registry — bed is NOT regenerated (existing bed.png kept)
// ---------------------------------------------------------------------------
const SPRITES = [
  { key: 'stove',         draw: drawStove },
  { key: 'counter',       draw: drawCounter },
  { key: 'shelves',       draw: drawShelves },
  { key: 'bar_counter',   draw: drawBarCounter },
  { key: 'stage',         draw: drawStage },
  { key: 'booth_seat',    draw: drawBoothSeat },
  { key: 'reception_desk', draw: drawReceptionDesk },
  { key: 'patient_bed',   draw: drawPatientBed },
  { key: 'mayors_desk',   draw: drawMayorsDesk },
  { key: 'meeting_table', draw: drawMeetingTable },
  { key: 'filing_cabinet', draw: drawFilingCabinet },
  { key: 'oven',          draw: drawOven },
  { key: 'prep_table',    draw: drawPrepTable },
  { key: 'workbench',     draw: drawWorkbench },
  { key: 'tool_rack',     draw: drawToolRack },
  { key: 'forge',         draw: drawForge },
  { key: 'guard_desk',    draw: drawGuardDesk },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let ok = 0;
  let fail = 0;

  for (const { key, draw } of SPRITES) {
    try {
      const buf = draw();
      await savePNG(key, buf);
      console.log(`  wrote ${key}.png`);
      ok++;
    } catch (err) {
      console.error(`  FAILED ${key}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} sprites written, ${fail} failed.`);
  console.log(`Output: ${OUT_DIR}`);
  if (fail > 0) process.exit(1);
}

main();
