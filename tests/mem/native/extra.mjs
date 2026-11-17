// node extra.mjs <noblur|blank|canvases>
import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = b.contexts()[0].pages()[0];
const mode = process.argv[2];
if (mode === 'noblur') await page.addStyleTag({ content: '*,*::before,*::after,::backdrop{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important}' });
if (mode === 'blank') await page.goto('about:blank');
const info = await page.evaluate(() => ({ url: location.href, effects: document.documentElement.dataset.effects, glassMode: document.documentElement.dataset.glassMode ?? document.querySelector('[data-glass-mode]')?.getAttribute('data-glass-mode') ?? null,
  canvases: [...document.querySelectorAll('canvas')].map(c => `${(c.className || c.parentElement?.className || '?').toString().slice(0, 40)} ${c.width}x${c.height} ${getComputedStyle(c).visibility}`),
  blurred: [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return s.backdropFilter && s.backdropFilter !== 'none'; }).length }));
console.log(JSON.stringify(info));
process.exit(0);
