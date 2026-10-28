import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, sep } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.REVIEW_OUTPUT
  ? pathToFileURL(resolve(process.env.REVIEW_OUTPUT) + sep)
  : new URL("../../tmp/voxelight-ui-rework/", import.meta.url);
const baseURL = process.env.VITE_URL ?? "http://127.0.0.1:1420";
await mkdir(output, { recursive: true });

let server;
async function ensureServer() {
  const existing = await fetch(baseURL).catch(() => null);
  if (existing?.ok) {
    const html = await existing.text();
    if (!html.includes("Voxelight") || !html.includes("/src/main.tsx")) throw new Error(`Unexpected app at ${baseURL}`);
    return;
  }
  server = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
    cwd: root,
    stdio: "ignore",
    shell: true,
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if ((await fetch(baseURL).catch(() => null))?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Vite did not start within 60 seconds");
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const selectors = {
  home: ".vx-home__scene",
  library: ".vx-library-page,.vx-detail-page",
  discover: ".vx-discover-page",
  multiplayer: ".vx-multiplayer-page",
  downloads: ".vx-downloads-page",
  accounts: ".vx-accounts-page",
  settings: ".vx-settings-page",
};

async function installFixture(page, scenario) {
  await page.addInitScript((scenario) => {
    const texture = (color, cape = false) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = cape ? 32 : 64;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 64, canvas.height);
      if (!cape) {
        context.clearRect(32, 0, 32, 16);
        context.fillStyle = "#122638";
        context.fillRect(9, 10, 2, 2);
        context.fillRect(13, 10, 2, 2);
      }
      return canvas.toDataURL("image/png");
    };
    const skins = {
      classic: texture("#18d8ed"),
      cape: texture("#ec29b7", true),
      default: texture("#478b48"),
    };
    const empty = scenario.empty;
    const stress = scenario.stress;
    const accounts = empty ? [] : [{
      id: "fixture-classic",
      username: stress ? "LongPlayer_12345" : "CyanFixture",
      uuid: "11111111111111111111111111111111",
      type: "microsoft",
      isSelected: true,
      skinUrl: null,
      skinModel: "classic",
    }];
    const config = {
      gameDirectory: "C:\\SyntheticFixture",
      javaPath: "",
      maxMemoryMb: 4096,
      jvmArguments: "-XX:+UseG1GC",
      versionIsolation: true,
      theme: scenario.theme,
      downloadConcurrency: 6,
      microsoftClientId: "",
      downloadLimitKib: 0,
      downloadSource: "official",
      screenWidth: 1280,
      screenHeight: 720,
      language: scenario.locale,
      accentColor: "#b4f17a",
      effects: scenario.effects,
      accentSource: "voxelight",
      soundEnabled: false,
      customBackground: null,
      javaAutoDownload: true,
      defaultSkin: "steve",
    };
    const installedVersions = [{ id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 }];
    const instances = empty ? [] : stress ? [{
      id: "long-instance",
      name: "Christopher Alexander Montgomery III's Shared Fabric Survival World With An Exceptionally Long But Plausible Name",
      versionId: "1.21.1",
      gameDirectory: "C:\\SyntheticFixture\\instances\\christopher-alexander-montgomery-shared-survival-world-with-a-long-directory-name",
      createdAt: "2026-10-25T08:00:00Z",
      category: "Long-term multiplayer building and automation",
      notes: "",
      totalPlayTime: 0,
      loader: "fabric",
      loaderVersion: "0.16.9",
    }, {
      id: "short-instance",
      name: "Jo",
      versionId: "1.21.1",
      gameDirectory: "C:\\SyntheticFixture\\jo",
      createdAt: "2026-10-24T08:00:00Z",
      category: "",
      notes: "",
      totalPlayTime: 0,
      loader: "vanilla",
      loaderVersion: "",
    }] : [{
      id: "fixture-world",
      name: "合成测试世界",
      versionId: "1.21.1",
      gameDirectory: "C:\\SyntheticFixture\\world",
      createdAt: "2026-10-25T08:00:00Z",
      category: "",
      notes: "",
      totalPlayTime: 0,
      loader: "vanilla",
      loaderVersion: "",
    }];
    const history = stress ? Array.from({ length: 198 }, (_, index) => ({
      id: `history-${index}`,
      kind: "install",
      target: `1.20.${(index % 4) + 1}`,
      label: "Legacy task label",
      status: "completed",
      stage: "complete",
      completed: 64,
      total: 64,
      bytesCompleted: 81000000,
      bytesTotal: 81000000,
      message: "等待执行",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    })) : [];
    const tasks = empty ? [] : stress ? [{
      id: "task-long",
      kind: "resource",
      target: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf",
      label: "Legacy task label",
      status: "running",
      stage: "download",
      completed: 642,
      total: 1284,
      bytesCompleted: 6172839,
      bytesTotal: 12345678,
      message: "等待执行",
      createdAt: "2026-10-25T08:00:00Z",
      updatedAt: "2026-10-25T08:12:00Z",
    }, ...history] : [{
      id: "task-running",
      kind: "install",
      target: "1.21.1",
      label: "Minecraft 1.21.1",
      status: "running",
      stage: "download",
      completed: 65,
      total: 130,
      bytesCompleted: 1024,
      bytesTotal: 2048,
      message: "等待执行",
      createdAt: "2026-10-25T08:00:00Z",
      updatedAt: "2026-10-25T08:12:00Z",
    }, {
      id: "task-complete",
      kind: "install",
      target: "1.20.1",
      label: "Minecraft 1.20.1",
      status: "completed",
      stage: "complete",
      completed: 64,
      total: 64,
      bytesCompleted: 81000000,
      bytesTotal: 81000000,
      message: "等待执行",
      createdAt: "2026-10-24T08:00:00Z",
      updatedAt: "2026-10-24T08:18:00Z",
    }];
    const managed = {
      id: "fixture-server",
      name: stress ? "Community Survival & Creative Building Server — Europe West With A Very Long But Valid Name" : "合成测试服务端",
      versionId: "1.21.1",
      createdAt: "2026-01-01T00:00:00Z",
      directory: "C:\\SyntheticFixture\\server",
      settings: { port: 25565, maxPlayers: 20, onlineMode: true, whitelist: false, motd: "Synthetic server", difficulty: "normal", gamemode: "survival", viewDistance: 10, maxMemoryMb: 2048, bindAddress: "" },
      eulaAccepted: false,
      eulaUrl: "https://aka.ms/MinecraftEULA",
      installed: true,
      status: "stopped",
      pid: null,
      exitCode: null,
      error: null,
      javaMajor: 21,
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
        invoke: async (name, args) => {
          if (name === "plugin:event|listen") return 1;
          if (name === "get_system_appearance") return {
            accentColor: "#ff7fb5",
            animationsEnabled: !scenario.accessibility?.reducedMotion,
            advancedEffectsEnabled: !scenario.accessibility?.reducedTransparency,
            locale: scenario.locale,
          };
          if (name === "bootstrap") return { config, accounts, instances, installedVersions, capabilities: {} };
          if (name === "get_default_skin") {
            const id = args?.skin === "alex" ? "alex" : "steve";
            return { id, name: id === "alex" ? "Alex" : "Steve", dataUrl: skins.default, model: id === "alex" ? "slim" : "classic", description: "Synthetic default preview" };
          }
          if (name === "get_player_profile") return {
            id: "11111111111111111111111111111111",
            name: accounts[0]?.username ?? "CyanFixture",
            skins: [{ id: "active", state: "ACTIVE", url: skins.classic, variant: "classic" }],
            capes: [{ id: "fixture-cape", state: "ACTIVE", url: skins.cape, alias: "Synthetic cape" }],
          };
          if (name === "list_versions") return { latestRelease: "1.21.1", latestSnapshot: "", versions: [] };
          if (name === "list_running_games") return [];
          if (name === "list_download_tasks") return tasks;
          if (name === "list_managed_servers") return empty ? [] : [managed];
          if (name === "read_managed_server_logs") return [{ serverId: managed.id, timestamp: "2026-01-01T00:00:00Z", stream: "stdout", message: "Synthetic server log" }];
          if (name === "list_servers") return empty ? [] : [{ index: 0, name: managed.name, address: "play.example.invalid:25565", hideAddress: false }];
          if (name === "get_service_status") return { curseforgeConfigured: false };
          if (name === "get_crash_diagnosis") return null;
          if (name === "save_config") return config;
          if (name.startsWith("list_")) return [];
          return null;
        },
      },
    });
    if (scenario.accessibility) {
      const original = window.matchMedia;
      window.matchMedia = (query) => {
        const media = original(query);
        const reducedMotion = query === "(prefers-reduced-motion: reduce)" && scenario.accessibility.reducedMotion;
        const reducedTransparency = query === "(prefers-reduced-transparency: reduce)" && scenario.accessibility.reducedTransparency;
        const highContrast = (query === "(forced-colors: active)" || query === "(prefers-contrast: more)") && scenario.accessibility.highContrast;
        if (!reducedMotion && !reducedTransparency && !highContrast) return media;
        return new Proxy(media, {
          get(target, property, receiver) {
            if (property === "matches") return true;
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
    }
    if (scenario.noWebgl) {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (type === "webgl2") return null;
        return original.call(this, type, ...args);
      };
    }
  }, scenario);

  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hits: scenario.empty ? [] : [{
          project_id: "advanced-rendering",
          slug: "advanced-rendering",
          title: scenario.stress ? "Advanced Rendering Performance and Compatibility Toolkit for Community Modpacks" : "Sodium",
          description: "A rendering toolkit for community worlds and predictable frame pacing.",
          icon_url: null,
          downloads: 12345678,
          author: "Fixture Author",
          project_type: "mod",
          versions: ["1.21.1"],
        }],
      }),
    });
  });
}

async function openScenario(scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 930 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await installFixture(page, scenario);
  await page.goto(`${baseURL}/${scenario.pseudoLocale ? "?stress-locale" : ""}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".vx-glass-provider")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

async function navigate(page, id) {
  await page.locator(`button[data-page="${id}"]`).click();
  await expect(page.locator(selectors[id])).toBeVisible();
  if (id === "accounts" && await page.locator(".vx-character-canvas").count()) {
    await expect(page.locator(".vx-character-canvas").first()).toHaveAttribute("data-character-state", "ready");
  }
}

// Spring-driven shell, Overture moments and Lattice frames must be at rest, with the pointer outside the shell, before a frame is judged.
async function settle(page) {
  await page.mouse.move(2, 2);
  try {
    await page.waitForFunction(() => {
      const nav = document.querySelector(".vx-floating-nav");
      const playing = document.querySelector('.vx-overture-scene[data-playing="true"]');
      return (!nav || nav.dataset.motionSettled === "true") && !playing;
    }, undefined, { timeout: 8000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      nav: document.querySelector(".vx-floating-nav")?.getAttribute("data-motion-settled"),
      playing: [...document.querySelectorAll(".vx-overture-scene")].map((scene) => scene.getAttribute("data-playing")),
      indicator: document.querySelector(".vx-floating-nav__indicator-slot")?.getAttribute("style"),
    }));
    throw new Error(`Motion did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
  await page.waitForTimeout(800);
}

async function capture(page, name, viewportOnly = false) {
  await settle(page);
  await page.evaluate(() => document.querySelector("main")?.scrollTo({ top: 0 }));
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    missingImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.src),
    legacy: Boolean(document.querySelector(".sidebar,.home-hero")),
    offenders: [...document.querySelectorAll("button,input,select,h1,h2,h3,p,strong,small,article,section,div")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -2 || rect.right > window.innerWidth + 2);
      })
      .slice(0, 8)
      .map((element) => ({
        tag: `${element.tagName}.${element.className}`,
        text: element.textContent?.trim().slice(0, 80),
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      })),
  }));
  if (metrics.scrollWidth > metrics.viewport) throw new Error(`${name}: horizontal overflow ${metrics.scrollWidth}/${metrics.viewport} ${JSON.stringify(metrics.offenders)}`);
  if (metrics.missingImages.length) throw new Error(`${name}: missing images ${metrics.missingImages.join(", ")}`);
  if (metrics.legacy) throw new Error(`${name}: legacy UI remains`);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: !viewportOnly });
  console.log(name, JSON.stringify(metrics));
}

async function verifyFocus(page) {
  await page.keyboard.press("Tab");
  const result = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return { name: "", outline: "none" };
    const labels = "labels" in element && element.labels ? Array.from(element.labels).map((label) => label.textContent).join(" ") : "";
    return {
      name: element.getAttribute("aria-label") || element.textContent || element.getAttribute("title") || labels || element.getAttribute("placeholder") || "",
      outline: getComputedStyle(element).outlineStyle,
    };
  });
  if (!result.name.trim() || result.outline === "none") throw new Error(`Invisible or unnamed focus: ${JSON.stringify(result)}`);
}

async function measurePerformance(page, scenario) {
  await navigate(page, "home");
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const before = await session.send("Performance.getMetrics");
  const sampling = page.evaluate(async () => {
    const longTasks = [];
    let observer;
    if (typeof PerformanceObserver !== "undefined") {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      });
      try {
        observer.observe({ type: "longtask" });
      } catch {}
    }
    const intervals = [];
    const started = performance.now();
    let previous;
    await new Promise((resolve) => {
      const frame = (now) => {
        if (previous !== undefined) intervals.push(now - previous);
        previous = now;
        if (now - started < 2400) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    observer?.disconnect();
    return {
      intervals,
      longTasks,
      sampleMs: performance.now() - started,
      animations: document.getAnimations().length,
      canvases: document.querySelectorAll("canvas").length,
      glassMode: document.querySelector(".vx-glass-provider")?.getAttribute("data-glass-mode"),
    };
  });
  await navigate(page, "settings");
  await navigate(page, "accounts");
  await navigate(page, "home");
  const sample = await sampling;
  const after = await session.send("Performance.getMetrics");
  await session.detach();
  const metric = (report, name) => report.metrics.find((entry) => entry.name === name)?.value ?? 0;
  const sorted = [...sample.intervals].sort((a, b) => a - b);
  const percentile = (ratio) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] : null;
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  const delta = (name) => (metric(after, name) - metric(before, name)) * 1000;
  return {
    ...scenario,
    renderer: "Playwright Chromium / SwiftShader",
    sampleMs: Math.round(sample.sampleMs),
    frames: {
      count: sorted.length,
      meanMs: mean,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: sorted.at(-1) ?? null,
    },
    longTasks: {
      count: sample.longTasks.length,
      totalMs: sample.longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      maxMs: Math.max(0, ...sample.longTasks.map((entry) => entry.duration)),
    },
    cdp: {
      taskDurationMs: delta("TaskDuration"),
      scriptDurationMs: delta("ScriptDuration"),
      layoutDurationMs: delta("LayoutDuration"),
      recalcStyleDurationMs: delta("RecalcStyleDuration"),
      jsHeapUsedBytes: metric(after, "JSHeapUsedSize"),
      jsHeapTotalBytes: metric(after, "JSHeapTotalSize"),
      domNodes: metric(after, "Nodes"),
    },
    animations: sample.animations,
    canvases: sample.canvases,
    glassMode: sample.glassMode,
  };
}

const performanceReports = [];

try {
  await ensureServer();
  if (!process.env.REVIEW_ONLY || process.env.REVIEW_ONLY === "base") for (const locale of ["zh-CN", "en-US"]) {
    for (const theme of ["dark", "light"]) {
      for (const effects of ["lite", "full"]) {
        const { page, errors } = await openScenario({ locale, theme, effects });
        for (const id of ["library", "discover", "multiplayer", "downloads", "accounts", "settings"]) {
          await navigate(page, id);
          await capture(page, `${id}-${locale}-${theme}-${effects}-1440`);
        }
        for (const width of [1050, 1440, 1920]) {
          await page.setViewportSize({ width, height: width === 1050 ? 720 : width === 1440 ? 930 : 1080 });
          await navigate(page, "home");
          await capture(page, `home-${locale}-${theme}-${effects}-${width}`);
        }
        await verifyFocus(page);
        await page.setViewportSize({ width: 1440, height: 930 });
        performanceReports.push(await measurePerformance(page, { locale, theme, effects }));
        if (errors.length) throw new Error(errors.join("; "));
        await page.close();
      }
    }
  }
  await writeFile(
    new URL("performance.json", output),
    JSON.stringify({ generatedAt: new Date().toISOString(), reports: performanceReports }, null, 2),
  );

  if (!process.env.REVIEW_ONLY || process.env.REVIEW_ONLY === "empty") for (const locale of ["zh-CN", "en-US"]) {
    const { page, errors } = await openScenario({ locale, theme: "dark", effects: "full", empty: true });
    await page.setViewportSize({ width: 1050, height: 720 });
    for (const id of ["home", "library", "discover", "downloads", "accounts"]) {
      await navigate(page, id);
      await capture(page, `empty-${id}-${locale}-1050`, true);
    }
    if (errors.length) throw new Error(errors.join("; "));
    await page.close();
  }

  if (!process.env.REVIEW_ONLY || process.env.REVIEW_ONLY === "stress") for (const locale of ["zh-CN", "en-US"]) {
    for (const effects of ["lite", "full"]) {
      for (const width of [1050, 1920]) {
        const { page, errors } = await openScenario({ locale, theme: "dark", effects, stress: true, pseudoLocale: true });
        await page.setViewportSize({ width, height: width === 1050 ? 720 : 1080 });
        await navigate(page, "library");
        await capture(page, `stress-library-${locale}-${effects}-${width}`, true);
        await navigate(page, "downloads");
        await capture(page, `stress-downloads-${locale}-${effects}-${width}`, true);
        if (errors.length) throw new Error(errors.join("; "));
        await page.close();
      }
    }
  }

  if (!process.env.REVIEW_ONLY || process.env.REVIEW_ONLY === "accessibility") for (const accessibility of [
    { reducedMotion: true },
    { reducedTransparency: true },
    { highContrast: true },
  ]) {
    const { page, errors } = await openScenario({ locale: "zh-CN", theme: "dark", effects: "full", accessibility });
    await navigate(page, "home");
    await capture(page, `accessibility-home-${Object.keys(accessibility)[0]}-1440`, true);
    await navigate(page, "accounts");
    await capture(page, `accessibility-accounts-${Object.keys(accessibility)[0]}-1440`, true);
    if (errors.length) throw new Error(errors.join("; "));
    await page.close();
  }

  if (!process.env.REVIEW_ONLY || process.env.REVIEW_ONLY === "fallback") {
    const fallback = await openScenario({ locale: "zh-CN", theme: "dark", effects: "full", noWebgl: true });
    await expect(fallback.page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", "fallback");
    await capture(fallback.page, "fallback-home-no-webgl-1440", true);
    if (fallback.errors.length) throw new Error(fallback.errors.join("; "));
    await fallback.page.close();
  }
} finally {
  await browser.close();
  if (server) server.kill();
}

console.log(`Saved visual matrix to ${fileURLToPath(output)}`);
