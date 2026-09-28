// Fresh-eyes visual audit: fast-forward to daylight, then capture a wide shot,
// a mid-zoom street, and a hovered building interior.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });

await page.goto('http://localhost:5173');
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(5000);

await page.locator('button', { hasText: /^4x$/ }).click().catch(() => {});

const clockText = async () =>
  (await page.locator('body').innerText()).match(/\b([0-2]?\d):([0-5]\d)\s*(AM|PM)?/i)?.[0] ?? '?';

const targetHours = Number(process.env.WAIT_S ?? 90);
console.log('clock before wait:', await clockText());
await page.waitForTimeout(targetHours * 1000);
console.log('clock after wait:', await clockText());

const canvas = page.locator('canvas').first();
const b = await canvas.boundingBox();
const cx = b.x + b.width / 2;
const cy = b.y + b.height / 2;
const clip = { x: b.x, y: b.y, width: b.width, height: b.height };

// Escape any lingering selection so the side panel does not cover the map.
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// 1. Wide overview — zoom all the way out.
await page.mouse.move(cx, cy);
for (let z = 0; z < 14; z++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/scratch/shots/audit-day-1-wide.png', clip });

// 2. Mid zoom on the town centre.
for (let z = 0; z < 6; z++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/scratch/shots/audit-day-2-mid.png', clip });

// 3. Close on whoever the feed is talking about, interior hovered.
const rows = page.locator('button[aria-label$="focus agent"]');
for (let z = 0; z < 6; z++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
if (await rows.count()) { await rows.first().click(); await page.waitForTimeout(2000); }
await page.mouse.move(cx + 2, cy + 2);
await page.mouse.move(cx, cy);
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/scratch/shots/audit-day-3-close.png', clip });

await browser.close();
console.log('done');
