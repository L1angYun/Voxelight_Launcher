import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const buildRoot = join(tmpdir(), "voxelight-lattice-build-check");
const output = "E:\\CodeX\\tmp\\voxelight-revision\\deepseek";
const port = 1437;
await mkdir(output, { recursive: true });

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const site = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(buildRoot, relative));
  try {
    const file = (await stat(candidate)).isDirectory() ? join(candidate, "index.html") : candidate;
    response.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(await readFile(join(buildRoot, "index.html")));
  }
});
await new Promise((resolve) => site.listen(port, "127.0.0.1", resolve));

const instances = [
  {
    id: "long-instance",
    name: "Christopher Alexander Montgomery III's Shared Fabric Survival World With An Exceptionally Long But Plausible Name",
    versionId: "1.21.1",
    gameDirectory: "C:\\SyntheticFixture\\instances\\christopher-alexander-montgomery-shared-survival-world-with-a-long-directory-name",
    createdAt: "2026-10-25T08:00:00Z",
    lastPlayed: "2026-10-26T09:30:00Z",
    category: "Long-term multiplayer building and automation",
    iconPath: null,
    notes: "",
    maxMemoryMb: null,
    javaPath: null,
    jvmArguments: null,
    screenWidth: null,
    screenHeight: null,
    totalPlayTime: 0,
    loader: "fabric",
    loaderVersion: "0.16.9",
  },
  {
    id: "short-instance",
    name: "Jo",
    versionId: "1.21.1",
    gameDirectory: "C:\\SyntheticFixture\\jo",
    createdAt: "2026-10-24T08:00:00Z",
    category: "",
    iconPath: null,
    notes: "",
    maxMemoryMb: null,
    javaPath: null,
    jvmArguments: null,
    screenWidth: null,
    screenHeight: null,
    totalPlayTime: 0,
    loader: "vanilla",
    loaderVersion: "",
  },
];

const tasks = [
  {
    id: "task-running",
    kind: "install",
    target: "1.21.1",
    label: "legacy",
    status: "running",
    stage: "download",
    completed: 642,
    total: 1284,
    bytesCompleted: 6172839,
    bytesTotal: 12345678,
    message: "",
    createdAt: "2026-10-25T08:00:00Z",
    updatedAt: "2026-10-25T08:12:00Z",
  },
  {
    id: "task-unknown",
    kind: "resource",
    target: "Sodium 0.6.13",
    label: "legacy",
    status: "paused",
    stage: "download",
    completed: 3,
    total: 0,
    bytesCompleted: 49152,
    bytesTotal: 0,
    message: "",
    createdAt: "2026-10-25T07:00:00Z",
    updatedAt: "2026-10-25T08:03:00Z",
  },
  {
    id: "task-complete",
    kind: "install",
    target: "1.20.1",
    label: "legacy",
    status: "completed",
    stage: "complete",
    completed: 64,
    total: 64,
    bytesCompleted: 81000000,
    bytesTotal: 81000000,
    message: "",
    createdAt: "2026-10-24T08:00:00Z",
    updatedAt: "2026-10-24T18:18:00Z",
  },
];

function fixture(theme) {
  const config = {
    gameDirectory: "C:\\SyntheticFixture",
    javaPath: "",
    maxMemoryMb: 4096,
    jvmArguments: "",
    versionIsolation: true,
    theme,
    downloadConcurrency: 6,
    microsoftClientId: "",
    downloadLimitKib: 0,
    downloadSource: "official",
    screenWidth: 1280,
    screenHeight: 720,
    language: "en-US",
    accentColor: "#b4f17a",
    effects: "full",
    accentSource: "voxelight",
    soundEnabled: false,
    customBackground: null,
    javaAutoDownload: true,
    defaultSkin: "steve",
  };
  return `
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
        invoke: async (name) => {
          if (name === "plugin:event|listen") return 1;
          if (name === "get_system_appearance") return {
            accentColor: "#b4f17a",
            animationsEnabled: true,
            advancedEffectsEnabled: true,
            locale: "en-US",
          };
          if (name === "bootstrap") return {
            config: ${JSON.stringify(config)},
            accounts: [],
            instances: ${JSON.stringify(instances)},
            installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 }],
            capabilities: {},
          };
          if (name === "list_versions") return { latestRelease: "1.21.1", latestSnapshot: "", versions: [] };
          if (name === "list_running_games") return [];
          if (name === "list_download_tasks") return ${JSON.stringify(tasks)};
          if (name === "get_service_status") return { curseforgeConfigured: false };
          if (name.startsWith("list_")) return [];
          return null;
        },
      },
    });
  `;
}

function overlap(a, b) {
  if (!a || !b) return false;
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
}

async function inspect(page, pageName) {
  return page.evaluate(({ pageName }) => {
    const rect = (element) => element?.getBoundingClientRect().toJSON() ?? null;
    const main = document.querySelector(".vx-app-main");
    const card = document.querySelector(".vx-instance-card");
    const information = card?.querySelector(".vx-instance-card__information");
    const name = card?.querySelector(".vx-instance-card__name");
    const technical = card?.querySelector(".vx-instance-card__technical");
    const path = card?.querySelector(".vx-instance-card__path");
    const footer = card?.querySelector(".vx-instance-card__footer");
    const siblings = [name, technical, path].filter(Boolean).map((element) => ({
      className: element.className,
      rect: element.getBoundingClientRect().toJSON(),
    }));
    const intersections = [];
    for (let index = 0; index < siblings.length; index += 1) {
      for (let other = index + 1; other < siblings.length; other += 1) {
        const a = siblings[index].rect;
        const b = siblings[other].rect;
        if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
          intersections.push([siblings[index].className, siblings[other].className]);
        }
      }
    }
    return {
      pageName,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
      main: main ? { clientWidth: main.clientWidth, scrollWidth: main.scrollWidth } : null,
      card: rect(card),
      information: rect(information),
      name: rect(name),
      technical: rect(technical),
      path: rect(path),
      footer: rect(footer),
      cardName: card ? {
        title: name?.getAttribute("title"),
        truncated: name ? name.scrollWidth > name.clientWidth : null,
      } : null,
      latticeState: card?.querySelector(".vx-lattice-frame")?.getAttribute("data-state"),
      dotCount: card?.querySelectorAll(".vx-lattice-frame__dot").length ?? 0,
      intersections,
    };
  }, { pageName });
}

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const captures = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const viewport of [{ width: 1440, height: 930 }, { width: 1050, height: 720 }]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      await page.addInitScript(fixture(theme));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
      await page.waitForSelector(".vx-glass-provider");
      await page.evaluate(() => document.fonts.ready);

      await page.locator('button[data-page="library"]').click();
      await page.waitForSelector('[data-instance-id="long-instance"]');
      await page.locator('[data-instance-id="long-instance"] [data-launch]').click();
      await page.locator('[data-instance-id="long-instance"] .vx-instance-card__select').focus();
      await page.waitForTimeout(350);
      const libraryName = `library-${theme}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: join(output, libraryName), fullPage: false });
      const library = await inspect(page, "library");

      await page.locator('button[data-page="downloads"]').click();
      await page.waitForSelector('[data-task-id="task-running"]');
      await page.waitForTimeout(350);
      const downloadsName = `downloads-${theme}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: join(output, downloadsName), fullPage: false });
      const downloads = await page.evaluate(() => {
        const rect = (element) => element?.getBoundingClientRect().toJSON() ?? null;
        const main = document.querySelector(".vx-app-main");
        const rows = [...document.querySelectorAll(".vx-task-row")];
        const progress = document.querySelector(".vx-lattice-progress");
        return {
          pageName: "downloads",
          viewport: { width: window.innerWidth, height: window.innerHeight },
          document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
          main: main ? { clientWidth: main.clientWidth, scrollWidth: main.scrollWidth } : null,
          rows: rows.map((row) => ({ id: row.getAttribute("data-task-id"), rect: rect(row) })),
          progress: rect(progress),
          progressUnit: progress?.getAttribute("data-unit"),
          progressTotal: progress?.getAttribute("data-total"),
          progressAriaNow: progress?.getAttribute("aria-valuenow"),
          unknownPercent: document.querySelector('[data-task-id="task-unknown"] .vx-task-row__percent'),
          activeSection: Boolean(document.querySelector(".vx-task-section--active")),
          historySection: Boolean(document.querySelector(".vx-task-section--history")),
        };
      });
      captures.push({ theme, viewport, libraryPath: join(output, libraryName), downloadsPath: join(output, downloadsName), library, downloads });
      await context.close();
    }
  }
  await writeFile(join(output, "capture-results.json"), JSON.stringify({ captures }, null, 2));
  console.log(JSON.stringify({ output, captures }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => site.close(resolve));
}
