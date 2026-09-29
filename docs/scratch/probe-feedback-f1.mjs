// F1 probe: keyboard toasts, nudge menu, building click -> LocationPanel, events menu, new agent dialog.
// Run against the verify server (DATABASE_PATH=./data/verify.db SERVER_PORT=3061) + vite on 5261:
//   VITE_WS_URL=ws://localhost:3061 npx vite --port 5261 --strictPort
// Usage: node docs/scratch/probe-feedback-f1.mjs
// Screen coordinates come from the camera's initial framing (centred on the town square,
// scale 1): screen = world + (-16, -258) until something moves the camera.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5261/';
const out = 'docs/scratch/shots';
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: `${out}/f1-${name}.png` });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(BASE);
await page.waitForTimeout(6000);

const trpcQuery = (path) => page.evaluate(async (p) => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  return p.split('.').reduce((o, k) => o[k], trpcClient).query();
}, path);
const locs = await trpcQuery('locations.getAll');
const agents = await trpcQuery('agents.getActive');
const loc = (type) => locs.find((l) => l.type === type);
const OFF = { x: -16, y: -258 };
const toScreen = (p, off = OFF) => ({ x: p.x + off.x, y: p.y + off.y });
const dialogs = () => page.getByRole('dialog').count();

// ── Keyboard: pause first so agents stand still ────────────────────
await page.mouse.move(700, 300);
const wasPaused = (await trpcQuery('world.getState')).is_paused;
if (wasPaused) { await page.keyboard.press('Space'); await page.waitForTimeout(500); } // resume, then pause for the shot
await page.keyboard.press('Space');
await page.waitForTimeout(600);
await shot(page, '01-space-paused-toast');

// ── Agent right-click -> NudgeMenu ─────────────────────────────────
const agents2 = await trpcQuery('agents.getActive');
const inView = (a) => {
  const sp = toScreen(a.position);
  return sp.x > 330 && sp.x < 1500 && sp.y > 90 && sp.y < 820;
};
const yuki = agents2.find((a) => (a.current_action?.type ?? '') !== 'sleeping' && inView(a));
console.log('subject:', yuki.name, yuki.position);
const sleeper = agents2.find((a) => (a.current_action?.type ?? '') === 'sleeping');
const yp = toScreen(yuki.position);
await page.mouse.click(yp.x, yp.y - 4, { button: 'right' });
await page.waitForTimeout(500);
await shot(page, '20-nudge-menu');
await page.getByText('Suggest talk to...').click().catch((e) => console.log('talk item:', e.message));
await page.waitForTimeout(300);
await shot(page, '21-nudge-talk-submenu');
await page.getByText('← Back').click();
await page.getByText('Pair with...').click().catch((e) => console.log('pair item:', e.message));
await page.waitForTimeout(300);
await shot(page, '22-nudge-pair-picker');
await page.getByText(sleeper.name.split(' ')[0]).first().click().catch((e) => console.log('pair pick:', e.message));
await page.waitForTimeout(300);
await shot(page, '23-nudge-pair-menu-asleep');
await page.keyboard.press('Escape');
await page.mouse.click(1100, 120); // outside -> closes
await page.waitForTimeout(300);

// ── Select Yuki, then click buildings ──────────────────────────────
await page.mouse.click(yp.x, yp.y - 4);
await page.waitForTimeout(1800);
// The camera now centres on the subject (clamped at the map edge, so screen positions
// can't be derived from world ones). Coordinates below are read off a screenshot of this
// exact, deterministic view: paused DB copy, first awake in-view agent selected.
await page.mouse.click(400, 690); // the house left of the subject's building
await page.waitForTimeout(600);
await shot(page, '30-building-panel-send-here');
console.log('panel:', (await page.getByRole('dialog').first().innerText().catch(() => 'NO PANEL')).split(String.fromCharCode(10)).join(' | '));
console.log('subject still selected (agent panel present):', (await page.getByText('Personality').count()) > 0);

// Agent wins over building: click the subject's own sprite (inside a building footprint).
await page.mouse.click(792, 462);
await page.waitForTimeout(400);
console.log('panel kept after agent click:', await dialogs());

// Drag must not open/close anything.
const before = await dialogs();
await page.mouse.move(700, 250);
await page.mouse.down();
await page.mouse.move(640, 220, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log('dialogs before/after drag:', before, await dialogs());

// Send Yuki there.
await page.getByRole('button', { name: /Send .* here/ }).click();
await page.waitForTimeout(500);
await shot(page, '31-send-toast');

// Bare ground closes the panel and deselects.
await page.mouse.click(300, 500);
await page.waitForTimeout(300);
console.log('panel after bare-ground click:', await dialogs());
await page.waitForTimeout(300);

// ── Events menu ────────────────────────────────────────────────────
await page.getByRole('button', { name: /events/i }).first().click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Trigger' }).first().click();
await page.waitForTimeout(700);
await shot(page, '41-event-triggered');
await page.getByRole('button', { name: /events/i }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /rainy/i }).click();
await page.waitForTimeout(700);
await shot(page, '43-weather-set');

// ── Speed keys ─────────────────────────────────────────────────────
await page.keyboard.press('Digit3');
await page.waitForTimeout(500);
await shot(page, '51-speed-toast');
await page.keyboard.press('Space');
await page.waitForTimeout(400);
await shot(page, '52-space-again');

// ── New resident ───────────────────────────────────────────────────
await page.getByRole('button', { name: /New Resident/ }).click();
await page.waitForTimeout(300);
await page.getByPlaceholder('Enter name...').fill('Probe Person');
await shot(page, '60-new-agent-filled');
await page.getByRole('button', { name: /Introduce/ }).click();
await page.waitForTimeout(1200);
await shot(page, '61-new-agent-done');

console.log('errors:', errors.slice(0, 8));
await browser.close();
