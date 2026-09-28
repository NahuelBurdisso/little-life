// Round 16: visual check of the two round-4 camera fixes.
//  A) releasing a follow-lock by panning must not rubber-band the camera back
//  B) zoomed out far enough that the map no longer fills the viewport, focusing
//     an agent must centre them instead of pinning the map to the top-left
import { chromium } from 'playwright';

const shot = (n) => `docs/scratch/shots/r16-${n}.png`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(5000);
await page.locator('button', { hasText: /^4x$/ }).click().catch(() => {});

const rows = page.locator('button[aria-label$="focus agent"]');
for (let i = 0; i < 20 && (await rows.count()) === 0; i++) await page.waitForTimeout(10000);
if ((await rows.count()) === 0) { console.log('NO ROWS'); await browser.close(); process.exit(1); }

// --- A) pan-release must not rubber-band -------------------------------------
await rows.first().click();
await page.waitForTimeout(2500);
const follow = page.locator('button', { hasText: /Follow|Following/ });
await follow.click();
await page.waitForTimeout(1000);

const canvas = page.locator('canvas').first();
const b = await canvas.boundingBox();
const clip = { x: b.x, y: b.y, width: Math.min(900, b.width), height: Math.min(600, b.height) };

await page.mouse.move(b.x + 400, b.y + 400);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(b.x + 700, b.y + 250, { steps: 20 });
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(120);
const a1 = await page.screenshot({ path: shot('a1-just-after-drag'), clip });
await page.waitForTimeout(2500);
const a2 = await page.screenshot({ path: shot('a2-2s-after-drag'), clip });
console.log('follow state after drag (expect Follow):', await follow.innerText());
console.log('identical bytes just-after vs 2s-after (agents animate, so expect false):', a1.equals(a2));

// --- B) focus while zoomed out far enough that the map is smaller than the view
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
await page.waitForTimeout(1500);
await page.screenshot({ path: shot('b1-zoomed-out'), clip });
await rows.first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: shot('b2-zoomed-out-after-focus'), clip });

await browser.close();
