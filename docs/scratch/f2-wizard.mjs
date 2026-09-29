// Resets the *verify* world (data/verify.db, never the live DB) back to the wizard and screenshots it.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://localhost:5182/');
await page.waitForTimeout(5000);
await page.evaluate(async () => {
  const { trpcClient } = await import('/src/lib/trpc.ts');
  await trpcClient.setup.resetToWizard.mutate();
});
await page.waitForTimeout(3000);
await page.screenshot({ path: 'docs/scratch/shots/F2-wizard.png' });
const steps = await page.locator('div.w-48 button').allInnerTexts();
console.log('steps:', steps);
for (let i = 1; i < steps.length && i < 4; i++) {
  await page.locator('div.w-48 button').nth(i).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `docs/scratch/shots/F2-wizard-${i}.png` });
}
console.log('errors:', errors);
await browser.close();
