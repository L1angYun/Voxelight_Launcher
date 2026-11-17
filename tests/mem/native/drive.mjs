// Drives the running launcher's WebView2 over CDP (debug port 9333). Usage: node drive.mjs <info|tour|lite|full|home>
import { chromium } from 'playwright';
const mode = process.argv[2] || 'info';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find(p => !p.url().startsWith('devtools')) ;
const nav = async (name) => {
  const target = page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true })).or(page.getByRole('tab', { name, exact: true })).first();
  await target.click({ timeout: 5000 });
  await page.waitForTimeout(2500);
};
const info = () => page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')].map(c => ({ cls: c.className || c.parentElement?.className || '', w: c.width, h: c.height, visible: c.offsetParent !== null }));
  const m = performance.memory;
  const gl = document.createElement('canvas').getContext('webgl2'); const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null; gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return { renderer, url: location.href, effects: document.documentElement.dataset.effects, dpr: devicePixelRatio, inner: [innerWidth, innerHeight],
    jsHeapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null, jsHeapTotalMB: m ? +(m.totalJSHeapSize / 1048576).toFixed(1) : null,
    canvases, imgs: document.images.length, nodes: document.getElementsByTagName('*').length };
});
if (mode === 'tour') {
  for (const n of ['游戏库', '探索', '联机', '下载', '角色', '设置', '开始']) { try { await nav(n); console.log('visited', n); } catch (e) { console.log('skip', n, e.message.split('\n')[0]); } }
}
if (mode === 'lite' || mode === 'full') {
  await nav('设置');
  const label = mode === 'lite' ? '精简 · 保留必要动态' : '完全 · 启用全部特效';
  await page.getByRole('button', { name: '外观', exact: true }).click(); await page.waitForTimeout(1000);
  await page.getByRole('combobox', { name: '特效级别' }).click(); await page.waitForTimeout(500);
  await page.getByRole('option', { name: label }).click({ timeout: 5000 });
  await page.waitForTimeout(800);
  const save = page.getByRole('button', { name: /^保存/ }).first();
  if (await save.isVisible().catch(() => false) && await save.isEnabled().catch(() => false)) { await save.click(); console.log('saved'); }
  await page.waitForTimeout(1000);
  await nav('开始');
}
if (mode === 'home') await nav('开始');
console.log(JSON.stringify(await info(), null, 1));
process.exit(0); // leave the launcher running; just drop the CDP connection
