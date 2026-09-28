// Round 15: re-verify feed-click focus + follow-lock after the round-3 remediation.
// The world was reseeded, so this warms the sim up until agent rows exist rather
// than assuming a pre-baked night-time save like r14 did.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(5000);
await page.locator('button', { hasText: /^4x$/ }).click().catch(() => {});

const rows = page.locator('button[aria-label$="focus agent"]');
for (let i = 0; i < 20 && (await rows.count()) < 2; i++) await page.waitForTimeout(10000);
console.log('clickable feed rows:', await rows.count());
console.log('labels:', (await rows.evaluateAll(ns => ns.map(n => n.getAttribute('aria-label')))).slice(0, 5));
if ((await rows.count()) === 0) { console.log('NO CLICKABLE ROWS'); await browser.close(); process.exit(1); }

await rows.first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/scratch/shots/r15-1-after-feed-click.png' });

const follow = page.locator('button', { hasText: /Follow|Following/ });
const visible = await follow.isVisible().catch(() => false);
console.log('follow button visible after feed click:', visible);
if (!visible) { await browser.close(); process.exit(1); }

const state = async () =>
  (await follow.isVisible().catch(() => false)) ? await follow.innerText() : 'BUTTON GONE';

await follow.click();
await page.waitForTimeout(800);
console.log('after toggle (expect Following):', await state());

const canvas = page.locator('canvas').first();
const b = await canvas.boundingBox();
const cx = b.x + 80;   // off to the side; middle button bypasses the agent hit test
const cy = b.y + 60;

// 3px jitter must NOT release the lock (below the 5px pan threshold)
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

// Selecting a different agent must not transfer the lock
const labels = await rows.allTextContents();
const panelName = await page.locator('h2, h3').first().innerText().catch(() => '');
let otherIdx = -1;
for (let i = 0; i < labels.length; i++) {
  if (panelName && !labels[i].includes(panelName)) { otherIdx = i; break; }
}
console.log('selected agent:', panelName, '| different-subject row idx:', otherIdx);
if (otherIdx >= 0) {
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

await page.screenshot({ path: 'docs/scratch/shots/r15-2-final.png' });
await browser.close();
