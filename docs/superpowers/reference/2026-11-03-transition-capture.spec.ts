import { test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { installLauncherFixture } from "../../../tests/e2e/fixtures";

// Historical capture; the maintained suite is tests/e2e/transitions.spec.ts.
const OUT = path.join("test-results", "reference-transitions");
fs.mkdirSync(OUT, { recursive: true });
const report: Record<string, unknown> = {};
const PAGES = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"];

const RECORDER = () => {
  const w = window as any;
  w.__rec = { frames: [], shifts: [], t0: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) if (w.__rec.t0) w.__rec.shifts.push({ t: Math.round(e.startTime - w.__rec.t0), v: +e.value.toFixed(4) });
    }).observe({ type: "layout-shift", buffered: false });
  } catch {}
  w.__startRec = () => {
    const r = w.__rec; r.frames = []; r.shifts = []; r.t0 = performance.now();
    const sig = () => {
      const main = document.querySelector("#main-content");
      const first = main?.firstElementChild as HTMLElement | null;
      const anims = document.getAnimations().filter((a: any) => a.playState === "running" && !(a.effect?.target?.closest?.(".vx-floating-nav")));
      return {
        t: Math.round(performance.now() - r.t0),
        first: first ? first.className.toString().slice(0, 40) : "",
        op: first ? getComputedStyle(first).opacity : "",
        nodes: main ? main.querySelectorAll("*").length : 0,
        anims: anims.length,
        animNames: [...new Set(anims.map((a: any) => a.animationName || a.transitionProperty || "waapi"))].slice(0, 6),
        dialog: document.querySelectorAll("dialog[open]").length,
      };
    };
    const tick = () => { r.frames.push(sig()); if (performance.now() - r.t0 < 1100) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
};

async function transition(page: any, cdp: any, name: string, act: () => Promise<void>) {
  const dir = path.join(OUT, "trans", name);
  fs.mkdirSync(dir, { recursive: true });
  const shots: { ts: number; data: string }[] = [];
  const onFrame = async (f: any) => {
    shots.push({ ts: f.metadata.timestamp, data: f.data });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  await page.evaluate(() => (window as any).__startRec());
  const started = Date.now() / 1000;
  try {
    await act();
    await page.waitForTimeout(1200);
    const rec = await page.evaluate(() => (window as any).__rec);
    const changed = rec.frames.find((f: any, i: number) => i && (f.first !== rec.frames[i - 1].first || f.nodes !== rec.frames[i - 1].nodes));
    const anyAnim = rec.frames.filter((f: any) => f.anims > 0);
    const gaps = rec.frames.slice(1).map((f: any, i: number) => f.t - rec.frames[i].t);
    report[name] = {
      frames: rec.frames.length,
      domChangeAtMs: changed?.t ?? null,
      contentAnimFrames: anyAnim.length,
      animNames: [...new Set(rec.frames.flatMap((f: any) => f.animNames))],
      opacityValues: [...new Set(rec.frames.map((f: any) => f.op))].slice(0, 8),
      firstClasses: [...new Set(rec.frames.map((f: any) => f.first))],
      maxFrameGapMs: gaps.length ? Math.max(...gaps) : null,
      layoutShift: rec.shifts,
    };
  } catch (e: any) {
    report[name] = { error: String(e.message).slice(0, 200) };
  }
  await cdp.send("Page.stopScreencast");
  cdp.off("Page.screencastFrame", onFrame);
  const relevant = shots.filter((s) => s.ts >= started - 0.05);
  const picks = relevant.length <= 8 ? relevant : Array.from({ length: 8 }, (_, i) => relevant[Math.floor((i * (relevant.length - 1)) / 7)]);
  picks.forEach((s, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(2, "0")}-${Math.round((s.ts - started) * 1000)}ms.jpg`), Buffer.from(s.data, "base64")));
  (report[name] as any).screencastFrames = relevant.length;
}

async function goto(page: any, id: string) {
  await page.locator(`[data-page="${id}"]`).click();
  await page.waitForTimeout(700);
}

for (const [theme, width, height] of [["dark", 1280, 720], ["light", 1280, 720], ["dark", 1050, 720]] as const) {
  test(`stills ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installLauncherFixture(page, { theme });
    await page.goto("/");
    await page.waitForTimeout(3500);
    for (const id of PAGES) {
      await goto(page, id);
      await page.screenshot({ path: path.join(OUT, `still-${theme}-${width}-${id}.png`) });
    }
    report[`world-${theme}-${width}`] = await page.evaluate(() => ({ ...(document.querySelector(".world-scene") as HTMLElement).dataset }));
  });
}

test("transitions", async ({ page }) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await installLauncherFixture(page, { theme: "dark" });
  await page.addInitScript(RECORDER);
  await page.goto("/");
  await page.waitForTimeout(3500);
  const cdp = await page.context().newCDPSession(page);
  report.renderer = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2");
    const e = c?.getExtension("WEBGL_debug_renderer_info");
    return e ? c!.getParameter(e.UNMASKED_RENDERER_WEBGL) : null;
  });
  const nav = (id: string) => page.locator(`[data-page="${id}"]`).click();

  await transition(page, cdp, "page-home-to-library", () => nav("library"));
  await transition(page, cdp, "page-library-to-discover", () => nav("discover"));
  await transition(page, cdp, "page-discover-to-settings", () => nav("settings"));
  await transition(page, cdp, "page-settings-to-downloads", () => nav("downloads"));
  await transition(page, cdp, "page-downloads-to-home", () => nav("home"));

  await goto(page, "library");
  await page.screenshot({ path: path.join(OUT, "state-library-grid.png") });
  await transition(page, cdp, "card-instance-open-detail", () => page.locator(".vx-instance-card__select").first().click({ timeout: 4000 }));
  await page.screenshot({ path: path.join(OUT, "state-instance-detail.png") });
  const tabs = page.locator('[role="tab"]');
  if (await tabs.count() > 1) await transition(page, cdp, "detail-tab-switch", () => tabs.nth(1).click({ timeout: 4000 }));
  await page.screenshot({ path: path.join(OUT, "state-instance-detail-tab2.png") });
  await transition(page, cdp, "detail-back-to-grid", () => page.getByRole("button", { name: /返回|back/i }).first().click({ timeout: 4000 }));
  await transition(page, cdp, "library-view-toggle-list", () => page.locator(".vx-library button[aria-pressed]").last().click({ timeout: 4000 }));
  await page.screenshot({ path: path.join(OUT, "state-library-list.png") });

  await transition(page, cdp, "dialog-create-open", () => page.getByRole("button", { name: /创建/ }).first().click({ timeout: 4000 }));
  await page.screenshot({ path: path.join(OUT, "state-dialog-create.png") });
  await transition(page, cdp, "dialog-create-close", () => page.keyboard.press("Escape"));

  await goto(page, "discover");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "state-discover.png") });
  const project = page.locator('#main-content article button, #main-content [data-visual-owner="lattice"] button').first();
  await transition(page, cdp, "card-project-open-drawer", () => project.click({ timeout: 4000 }));
  await page.screenshot({ path: path.join(OUT, "state-discover-drawer.png") });
  await transition(page, cdp, "drawer-close", () => page.keyboard.press("Escape"));

  await goto(page, "settings");
  const settingsNav = page.locator(".vx-settings-nav button");
  if (await settingsNav.count() > 1) await transition(page, cdp, "settings-section-switch", () => settingsNav.nth(1).click({ timeout: 4000 }));

  await goto(page, "home");
  await page.screenshot({ path: path.join(OUT, "state-home.png") });
  const recent = page.locator(".vx-recent-card").nth(1);
  if (await recent.count()) await transition(page, cdp, "home-recent-card-select", () => recent.click({ timeout: 4000 }));
  const picker = page.locator(".vx-launch-console__selector button").first();
  if (await picker.count()) {
    await transition(page, cdp, "home-instance-picker-open", () => picker.click({ timeout: 4000 }));
    await page.screenshot({ path: path.join(OUT, "state-home-picker.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  await transition(page, cdp, "home-launch-start", () => page.locator(".vx-launch-console button").last().click({ timeout: 4000 }));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "state-home-launching.png") });
});

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
});
