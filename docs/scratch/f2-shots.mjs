// F2 screenshots: palette, empty/loading states, clickable rows, autoplay panel.
// Usage: node docs/scratch/f2-shots.mjs <step>   (needs the verify server on :3062 and vite on :5182)
import { chromium } from 'playwright';

const URL = 'http://localhost:5182/';
const step = process.argv[2] ?? 'main';
const out = (n) => `docs/scratch/shots/F2-${n}.png`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

if (step === 'loading') {
  // A socket that never opens keeps the app on its loading screen.
  await page.addInitScript(() => {
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} removeEventListener() {} };
  });
  await page.goto(URL);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out('loading') });
  await browser.close();
  process.exit(0);
}

await page.goto(URL);
await page.waitForTimeout(6000);

const trpc = (fn) => page.evaluate(async (src) => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  return await (new Function('c', `return (async()=>{${src}})()`))(trpcClient);
}, fn);

// Freeze the sim so shots are stable and the user's Ollama isn't hammered.
await trpc("await c.nudge.execute.mutate({ action: { type: 'change_speed', speed: 0 } }).catch(()=>{})").catch(() => {});

const shots = {
  async main() {
    await page.screenshot({ path: out('main') });
  },
  async agent() {
    await page.locator('button[aria-label$="focus agent"]').first().click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: out('agent-profile') });
    for (const [tab, name] of [['Social', 'social'], ['Mind', 'mind'], ['Thoughts', 'thoughts']]) {
      await page.getByRole('button', { name: new RegExp(tab) }).first().click();
      await page.waitForTimeout(600);
      if (name === 'thoughts') {
        for (const t of ['Goals & Ambition', 'Secrets & Opinions', 'Recent Memories']) {
          await page.getByRole('button', { name: t }).click().catch(() => {});
        }
        await page.waitForTimeout(800);
      }
      await page.screenshot({ path: out('agent-' + name) });
    }
  },
  async autoplay() {
    await page.getByRole('button', { name: /Autoplay/ }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: out('autoplay-off') });
    await page.getByRole('switch', { name: 'Watch the town' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out('autoplay-on') });
  },
  async stats() {
    await page.getByRole('button', { name: /Stats/ }).click();
    await page.waitForTimeout(80);
    await page.screenshot({ path: out('stats-loading') });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out('stats') });
  },
  async graph() {
    await page.getByRole('button', { name: /Relationships/ }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: out('graph') });
  },
  async history() {
    await page.getByRole('button', { name: /History/ }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: out('history') });
    await page.locator('div.cursor-pointer.group').first().click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: out('conv-detail') });
  },
  async memorial() {
    // Lucia knows Elena (killed by f2-kill.mjs): open Lucia, Social tab, click Elena's row.
    await page.getByTitle('Go to Lucia Fernandez').first().click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Social/ }).first().click();
    await page.waitForTimeout(500);
    await page.getByTitle('Go to Elena Voss').first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out('memorial') });
  },
  async clicks() {
    // Conversation-panel name -> agent panel opens on that resident.
    const before = await page.locator('h1, div.font-bold').allInnerTexts().catch(() => []);
    await page.getByTitle(/^Go to /).first().click();
    await page.waitForTimeout(1000);
    const panelName = await page.locator('div.font-bold.text-ui-text').first().innerText().catch(() => '?');
    console.log('clicked conversation name -> panel shows:', panelName);
    await page.getByRole('button', { name: /Social/ }).first().click();
    await page.waitForTimeout(400);
    const rel = page.getByTitle(/^Go to /).first();
    const target = (await rel.getAttribute('title')).replace('Go to ', '');
    await rel.click();
    await page.waitForTimeout(1000);
    console.log('clicked relationship row', target, '-> panel shows:', await page.locator('div.font-bold.text-ui-text').first().innerText());
    await page.screenshot({ path: out('clicks') });
  },
  async report() {
    await trpc("await c.nudge.execute.mutate({ action: { type: 'change_speed', speed: 4 } })");
    await page.getByRole('button', { name: /Autoplay/ }).click();
    await page.waitForTimeout(500);
    const sw = page.getByRole('switch', { name: 'Watch the town' });
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
    // A window is 60 ticks; 4x = ~15 game-minutes per real second.
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(3000);
      if (await page.getByText('What it noticed').count()) break;
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out('autoplay-report') });
    await trpc("await c.nudge.execute.mutate({ action: { type: 'change_speed', speed: 0 } })");
  },
  async tooltip() {
    const box = await page.locator('canvas').first().boundingBox();
    for (let y = box.y + 80; y < box.y + box.height - 40; y += 24) {
      for (let x = box.x + 40; x < box.x + box.width - 40; x += 24) {
        await page.mouse.move(x, y);
        const tip = page.locator('div.fixed.z-50.pointer-events-none');
        if (await tip.count()) {
          await page.screenshot({ path: out('tooltip'), clip: { x: Math.max(0, x - 200), y: Math.max(0, y - 100), width: 420, height: 220 } });
          console.log('tooltip:', (await tip.first().innerText()).replace(/\n/g, ' | '));
          return;
        }
      }
    }
    console.log('no tooltip found');
  },
};

for (const s of step.split(',')) {
  if (!shots[s]) throw new Error('unknown step ' + s);
  await shots[s]();
  // Close any modal between steps.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
console.log('errors:', errors.slice(0, 8));
await browser.close();
