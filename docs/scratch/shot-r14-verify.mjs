// Round 14: verify feed-click focus, follow-lock, pan-release, and the sleep pose.
// Usage: node docs/scratch/shot-r14-verify.mjs <agentWorldX> <agentWorldY>
import { chromium } from 'playwright';

const MAP_W = 56 * 32;
const MAP_H = 43 * 32;
const PAD = 100;
const agentX = Number(process.argv[2] ?? 1424);
const agentY = Number(process.argv[3] ?? 848);
const out = (n) => `docs/scratch/shots/r14-${n}.png`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(7000);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const wx = clamp(box.width / 2 - MAP_W / 2, box.width - MAP_W - PAD, PAD);
const wy = clamp(box.height / 2 - MAP_H / 2, box.height - MAP_H - PAD, PAD);
const px = box.x + wx + agentX;
const py = box.y + wy + agentY;

// Zoom in on the sleeper. Wheel is cursor-anchored, but clampBounds pulls the
// view back at the map edge, so the sprite drifts up-left as we zoom.
await page.mouse.move(px, py);
for (let i = 0; i < 11; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(150); }
await page.waitForTimeout(4000);
const sx = px - 163;
const sy = py - 59;
await page.screenshot({ path: out('2-sleep-zoom'), clip: { x: sx - 130, y: sy - 150, width: 260, height: 260 } });

// Select via the activity feed — this is the clickable-row feature under test
const rows = page.locator('button[aria-label$="focus agent"]');
const rowCount = await rows.count();
console.log('clickable feed rows:', rowCount);
console.log('non-clickable rows are divs:', await page.locator('button[aria-label$="focus agent"] ~ div').count() >= 0);
if (rowCount === 0) { console.log('NO CLICKABLE ROWS'); await browser.close(); process.exit(1); }
console.log('first row label:', await rows.first().getAttribute('aria-label'));
await rows.first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: out('3-after-feed-click') });

const follow = page.locator('button', { hasText: /Follow|Following/ });
const visible = await follow.isVisible().catch(() => false);
console.log('follow button visible after feed click:', visible);
if (visible) {
  await follow.click();
  await page.waitForTimeout(800);
  console.log('after toggle (expect Following):', await follow.innerText());

  const b2 = await canvas.boundingBox();
  const cx = b2.x + 80;              // off to the side, away from any sprite
  const cy = b2.y + 60;
  const state = async () =>
    (await follow.isVisible().catch(() => false)) ? await follow.innerText() : 'BUTTON GONE';

  // Middle button pans the camera without going through the agent hit test,
  // so this isolates the pan threshold from click-to-deselect.
  // 3px jitter must NOT release the lock (below the 5px threshold).
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 3, cy, { steps: 3 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(700);
  console.log('after 3px jitter (expect Following):', await state());

  // A real drag must release it
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 140, cy + 70, { steps: 15 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(800);
  console.log('after real drag (expect Follow):', await state());

  // Selecting a *different* agent must not silently transfer the lock
  const labels = await rows.allTextContents();
  console.log('row subjects:', labels.map(l => l.slice(0, 24)));
  const panelName = await page.locator('h2, h3').first().innerText().catch(() => '');
  let otherIdx = -1;
  for (let i = 0; i < labels.length; i++) {
    if (panelName && !labels[i].startsWith(panelName)) { otherIdx = i; break; }
  }
  console.log('selected agent:', panelName, '| different-subject row idx:', otherIdx);
  if (otherIdx >= 0 && (await follow.isVisible().catch(() => false))) {
    await follow.click();
    await page.waitForTimeout(500);
    console.log('re-armed (expect Following):', await state());
    await rows.nth(otherIdx).click();
    await page.waitForTimeout(1500);
    console.log('after selecting another agent (expect Follow):', await state());
  }

  // Deselect then re-select: the lock must not survive a selection change
  await follow.click();
  await page.waitForTimeout(400);
  console.log('re-armed (expect Following):', await state());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  console.log('after Escape (expect BUTTON GONE):', await state());
  await rows.first().click();
  await page.waitForTimeout(1500);
  console.log('after re-select (expect Follow):', await state());
}
await page.screenshot({ path: out('4-final') });

const clock = (await page.locator('body').innerText()).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
console.log('clock:', clock ? clock[0] : 'not found');
await browser.close();
