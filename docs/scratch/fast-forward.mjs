// Run the verify world at 4x for N seconds, then back to 1x. Usage: node docs/scratch/fast-forward.mjs 100
import { chromium } from 'playwright';
const secs = Number(process.argv[2] ?? 60);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173');
await page.waitForTimeout(6000);
await page.getByRole('button', { name: '4x', exact: true }).click();
await page.waitForTimeout(secs * 1000);
await page.getByRole('button', { name: '1x', exact: true }).click();
console.log('done');
await browser.close();
