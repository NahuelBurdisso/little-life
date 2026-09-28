import { INTERIOR_ZONES, INTERIOR_GRIDS } from '../../server/data/interiors';
const T = 32;
for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
  const grid = INTERIOR_GRIDS[type];
  const gw = grid ? grid[0].length : null;
  const gh = grid ? grid.length : null;
  for (const z of zones) {
    const xs = z.tiles.map(t => t[0]); const ys = z.tiles.map(t => t[1]);
    const bx = Math.min(...xs) * T, by = Math.min(...ys) * T;
    const bw = (Math.max(...xs) - Math.min(...xs) + 1) * T;
    const bh = (Math.max(...ys) - Math.min(...ys) + 1) * T;
    const r = z.relativePosition;
    const dx = r.x - bx, dy = r.y - by;
    const ow = (r.x + r.width) - (bx + bw), oh = (r.y + r.height) - (by + bh);
    const bad = dx < 0 || dy < 0 || ow > 0 || oh > 0 || dx > 12 || dy > 12 || ow < -20 || oh < -20;
    if (bad) {
      console.log(`${type}:${z.id} tiles=${JSON.stringify(z.tiles)} tileBox=(${bx},${by},${bw}x${bh}) rel=(${r.x},${r.y},${r.width}x${r.height}) insetL=${dx} insetT=${dy} overR=${ow} overB=${oh}`);
    }
  }
  if (grid) {
    for (const z of zones) for (const [c, rr] of z.tiles) if (c < 0 || rr < 0 || c >= gw! || rr >= gh!) console.log(`OOB ${type}:${z.id} tile ${c},${rr} grid ${gw}x${gh}`);
  }
}
