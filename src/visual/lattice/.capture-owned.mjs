import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";

const output = join(tmpdir(), "voxelight-owned-captures");
const buildRoot = join(tmpdir(), "voxelight-lattice-build-check");
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
await new Promise((resolve) => site.listen(1421, "127.0.0.1", resolve));

const version = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
};

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const instance = {
  id: "fixture-world",
  name: "合成测试世界",
  versionId: "1.21.1",
  gameDirectory: "C:\\SyntheticFixture\\world",
  createdAt: "2026-10-25T08:00:00Z",
  lastPlayed: "2026-10-26T09:30:00Z",
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
};

const tasks = [
  {
    id: "task-running",
    kind: "install",
    target: "1.21.1",
    label: "legacy",
    status: "running",
    stage: "download",
    completed: 65,
    total: 130,
    bytesCompleted: 1024,
    bytesTotal: 2048,
    message: "",
    createdAt: "2026-10-25T08:00:00Z",
    updatedAt: "2026-10-25T08:12:00Z",
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
    language: "zh-CN",
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
            locale: "zh-CN",
          };
          if (name === "bootstrap") return {
            config: ${JSON.stringify(config)},
            accounts: [],
            instances: [${JSON.stringify(instance)}],
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

async function evaluate(target, expression, awaitPromise = false) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  }, target.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(target, expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(target, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function capture(target, name) {
  const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, target.sessionId);
  const path = join(output, `${name}.png`);
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  return path;
}

async function openScenario(theme, width) {
  const created = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const target = { targetId: created.targetId, sessionId: attached.sessionId };
  await send("Page.enable", {}, target.sessionId);
  await send("Runtime.enable", {}, target.sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: width === 1440 ? 930 : 720,
    deviceScaleFactor: 1,
    mobile: false,
  }, target.sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fixture(theme) }, target.sessionId);
  await send("Page.navigate", { url: "http://127.0.0.1:1421/" }, target.sessionId);
  await waitFor(target, "document.querySelector('.vx-glass-provider')");
  await evaluate(target, "document.fonts.ready.then(() => true)", true);
  return target;
}

async function closeTarget(target) {
  await send("Target.closeTarget", { targetId: target.targetId });
}

const results = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 1050]) {
      const target = await openScenario(theme, width);
      await evaluate(target, `document.querySelector('button[data-page="library"]').click()`);
      await waitFor(target, "document.querySelector('.vx-instance-card')");
      await new Promise((resolve) => setTimeout(resolve, 450));
      const library = await evaluate(target, `(() => {
        const card = document.querySelector('.vx-instance-card');
        const information = card?.querySelector('.vx-instance-card__information');
        const name = card?.querySelector('.vx-instance-card__name');
        const meta = card?.querySelector('.vx-instance-card__meta');
        const path = card?.querySelector('.vx-instance-card__path');
        const rect = (element) => element ? element.getBoundingClientRect().toJSON() : null;
        return {
          viewport: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          card: rect(card),
          information: rect(information),
          name: rect(name),
          meta: rect(meta),
          path: rect(path),
          informationDisplay: information ? getComputedStyle(information).display : null,
          latticeDots: card?.querySelectorAll('.vx-lattice-frame__dot').length ?? 0,
        };
      })()`);
      const libraryPath = await capture(target, `library-${theme}-${width}`);
      await evaluate(target, `document.querySelector('.vx-instance-card__select').focus()`);
      const outline = await evaluate(target, `getComputedStyle(document.querySelector('.vx-instance-card__select')).outlineStyle`);

      await evaluate(target, `document.querySelector('button[data-page="downloads"]').click()`);
      await waitFor(target, "document.querySelector('.vx-task-row')");
      await new Promise((resolve) => setTimeout(resolve, 450));
      const downloads = await evaluate(target, `(() => {
        const task = document.querySelector('.vx-task-row');
        const progress = task?.querySelector('.vx-lattice-progress');
        return {
          viewport: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          task: task?.getBoundingClientRect().toJSON() ?? null,
          progress: progress?.getBoundingClientRect().toJSON() ?? null,
          progressCanvas: progress?.tagName === 'CANVAS' ? 1 : 0,
          progressCells: 0,
          filledCells: 0,
          ariaNow: progress?.getAttribute('aria-valuenow'),
          ariaMax: progress?.getAttribute('aria-valuemax'),
        };
      })()`);
      const downloadsPath = await capture(target, `downloads-${theme}-${width}`);
      results.push({ theme, width, outline, library, downloads, libraryPath, downloadsPath });
      await closeTarget(target);
    }
  }
} finally {
  socket.close();
  await new Promise((resolve) => site.close(resolve));
}

console.log(JSON.stringify({ output, results }, null, 2));
