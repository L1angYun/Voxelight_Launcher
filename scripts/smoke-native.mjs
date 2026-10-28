// Native, isolated integration checks. Run only after building the current Rust core.
// Reads only immutable user 1.20.1 client/library/assets files; never copies worlds or credentials.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  stat,
  readdir,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

async function verifyLoader(
  loader,
  gameVersion = loader === "neoforge" ? "1.21.1" : baseVersion,
) {
  const versions = await invoke("list_loader_versions", {
    loader,
    gameVersion,
  });
  const selected =
    versions.find((version) => version.recommended && version.stable) ||
    versions.find((version) => version.stable);
  assert(selected, `Official ${loader} API returned no stable loader`);
  const installed = await invoke("install_loader", {
    loader,
    gameVersion,
    loaderVersion: selected.id,
  });
  const scanned = await invoke("scan_versions");
  assert(
    scanned.some(
      (version) => version.id === installed.versionId && version.launchable,
    ),
  );
  const profile = JSON.parse(
    await readFile(
      path.join(
        game,
        "versions",
        installed.versionId,
        `${installed.versionId}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(profile.inheritsFrom, gameVersion);
  assert.equal(profile.launcherMetadata.loader, loader);
  assert(profile.libraries.length > 0);
  const instance = await invoke("create_instance", {
    name: `Voxelight actual ${loader}`,
    versionId: installed.versionId,
  });
  assert.equal(instance.loader, loader);
  assert.equal(instance.loaderVersion, selected.id);
  const launched = await invoke("launch_game", {
    versionId: installed.versionId,
    instanceId: instance.id,
  });
  gamePid = launched.pid;
  assert(gamePid > 0);
  await assert.rejects(
    () =>
      invoke("launch_game", {
        versionId: installed.versionId,
        instanceId: instance.id,
      }),
    /instance\.running|此实例已在运行，请勿重复启动/,
  );
  const sameInstance = (await invoke("list_running_games")).filter(
    (game) => game.instanceId === instance.id,
  );
  assert.equal(sameInstance.length, 1);
  assert.equal(sameInstance[0].pid, launched.pid);
  const logStart = (await launcherLogs()).length;
  const renderEvidence = await eventually(async () => {
    const logs = (await launcherLogs()).slice(logStart);
    try {
      process.kill(gamePid, 0);
    } catch {
      const diagnostic = logs
        .split("\n")
        .filter((line) => /Caused by:|Exception|\[ERROR\]/.test(line))
        .slice(-4)
        .map((line) => line.slice(0, 800))
        .join("\n");
      throw new Error(`${loader} exited before rendering\n${diagnostic}`);
    }
    return logs.match(
      /[^\n]*(?:OpenAL initialized|Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas|Backend library: LWJGL)[^\n]*/,
    )?.[0];
  }, 120000);
  for (const [command, args] of [
    ["backup_instance", { instanceId: instance.id }],
    [
      "clone_instance",
      { instanceId: instance.id, name: "Must not clone a running instance" },
    ],
    [
      "restore_instance_backup",
      { instanceId: instance.id, backupId: randomUUID() },
    ],
    [
      "export_instance_zip",
      {
        instanceId: instance.id,
        outputPath: path.join(work, "must-not-export-running.zip"),
      },
    ],
    ["remove_instance", { instanceId: instance.id }],
  ])
    await assert.rejects(
      () => invoke(command, args),
      /instance\.running|仍在运行/,
      `${command} must protect a running instance`,
    );
  assert(
    (await invoke("bootstrap")).instances.some(
      (value) => value.id === instance.id,
    ),
  );
  await wait(5000);
  process.kill(gamePid, 0);
  const result = {
    loader,
    loaderVersion: selected.id,
    versionId: installed.versionId,
    pid: gamePid,
    gameDirectory: launched.gameDirectory,
    renderEvidence,
    runningInstanceGuards: 6,
  };
  report.loaders.push(result);
  await invoke("stop_game", { pid: gamePid });
  gamePid = undefined;
  await eventually(
    async () =>
      !(await invoke("list_running_games")).some(
        (game) => game.instanceId === instance.id,
      ),
  );
  const saved = await invoke("bootstrap");
  assert(
    saved.instances.find((value) => value.id === instance.id).totalPlayTime > 0,
  );
  const restarted = await invoke("launch_game", {
    versionId: installed.versionId,
    instanceId: instance.id,
  });
  gamePid = restarted.pid;
  assert.notEqual(restarted.pid, launched.pid);
  await invoke("stop_game", { pid: restarted.pid });
  gamePid = undefined;
  await eventually(
    async () =>
      !(await invoke("list_running_games")).some(
        (game) => game.instanceId === instance.id,
      ),
  );
  result.restartedAfterExit = true;
  report.realNetworkChecks.push(
    `official ${loader} installation and real Java rendering; running-instance mutations rejected`,
  );
  return installed;
}

async function modrinth(endpoint) {
  const response = await fetch(`https://api.modrinth.com/v2/${endpoint}`, {
    headers: { "User-Agent": "VoxelightLauncher/0.5.0 integration-test" },
  });
  if (!response.ok) throw new Error(`Modrinth HTTP ${response.status}`);
  return response.json();
}

async function seedMod(directory, version) {
  const file = version.files.find((item) => item.primary) || version.files[0];
  assert(file);
  const url = new URL(file.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "cdn.modrinth.com");
  assert(!/[<>:"/\\|?*]/.test(file.filename));
  const response = await fetch(url);
  assert(response.ok, `Modrinth CDN HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, file.size);
  assert.equal(
    createHash("sha512").update(bytes).digest("hex"),
    file.hashes.sha512,
  );
  await mkdir(directory, { recursive: true });
  const target = contained(directory, path.join(directory, file.filename));
  await writeFile(target, bytes, { flag: "wx" });
  return { file, bytes };
}
import { gzipSync } from "node:zlib";
import net from "node:net";
import assert from "node:assert/strict";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const work = path.join(
  project,
  "src-tauri",
  "target",
  `native-${randomUUID()}`,
);
const game = path.join(work, "game"),
  storage = path.join(work, "data");
const binary =
  process.env.SMOKE_BINARY ||
  path.join(project, "src-tauri", "target", "debug", "voxelight-launcher.exe");
const baseVersion = "1.20.1";
const port = Number(process.env.SMOKE_CDP_PORT || 9333);
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const report = {
  work,
  binary,
  startedAt: new Date().toISOString(),
  checks: [],
  failures: [],
  fixtureOnlyChecks: [],
  realNetworkChecks: [],
};
let browser,
  child,
  page,
  invoke,
  gamePid,
  mockServer,
  output = "";
let fixtureInstance;

function contained(root, target) {
  const relative = path.relative(root, target);
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `Unsafe target ${target}`,
  );
  return target;
}
async function put(relative, bytes) {
  const target = contained(work, path.resolve(work, relative));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}
const checkFilters = (process.env.SMOKE_CHECKS || "")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
async function check(name, action) {
  if (
    checkFilters.length > 0 &&
    !checkFilters.some((filter) => name.toLowerCase().includes(filter))
  )
    return;
  try {
    await action();
    report.checks.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    report.failures.push({ name, error: String(error) });
    console.error(`FAIL ${name}: ${error}`);
    if (page) {
      try {
        const context = {
          check: name,
          url: page.url(),
          body: (await page.locator("body").innerText({ timeout: 5000 })).slice(
            0,
            6000,
          ),
        };
        const screenshot = path.join(
          work,
          `failure-${report.failures.length}.png`,
        );
        await page.screenshot({ path: screenshot, fullPage: true });
        (report.failureContexts ||= []).push({ ...context, screenshot });
      } catch (captureError) {
        console.error(`Unable to capture native UI failure: ${captureError}`);
      }
    }
  }
}
async function eventually(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Condition timed out after ${timeout} ms`, {
    cause: lastError,
  });
}

async function copyImmutableCache() {
  const source =
    process.env.SMOKE_CACHE ||
    path.join(process.env.APPDATA || "", ".minecraft");
  const official = await (
    await fetch(
      "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    )
  ).json();
  const entry = official.versions.find((version) => version.id === baseVersion);
  assert(entry);
  const metadata = await (await fetch(entry.url)).json();
  await put(
    `game/versions/${baseVersion}/${baseVersion}.json`,
    JSON.stringify(metadata),
  );
  const files = new Set([`versions/${baseVersion}/${baseVersion}.jar`]);
  for (const library of metadata.libraries || []) {
    if (library.downloads?.artifact?.path)
      files.add(`libraries/${library.downloads.artifact.path}`);
    for (const native of Object.values(library.downloads?.classifiers || {}))
      if (native.path) files.add(`libraries/${native.path}`);
  }
  const assetId = metadata.assetIndex?.id;
  if (assetId) {
    files.add(`assets/indexes/${assetId}.json`);
    try {
      const index = JSON.parse(
        await readFile(
          path.join(source, "assets", "indexes", `${assetId}.json`),
          "utf8",
        ),
      );
      for (const object of Object.values(index.objects)) {
        assert(
          typeof object.hash === "string" &&
            /^[a-f0-9]{40}$/i.test(object.hash),
          "Cached asset index contains an invalid content hash",
        );
        files.add(`assets/objects/${object.hash.slice(0, 2)}/${object.hash}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  let copied = 0,
    missing = 0;
  for (const relative of files) {
    const target = contained(game, path.resolve(game, relative));
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.resolve(source, relative), target);
      copied++;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing++;
    }
  }
  report.immutableCache = {
    copied,
    missing,
    source,
    worldsCopied: 0,
    credentialsCopied: 0,
  };
}

// A small deterministic ZIP writer keeps fixture creation independent of external archivers.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let i = 0; i < 8; i++)
    result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});
function crc32(bytes) {
  let result = 0xffffffff;
  for (const value of bytes)
    result = crcTable[(result ^ value) & 255] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  let offset = 0;
  const local = [],
    central = [];
  for (const [name, value] of entries) {
    const filename = Buffer.from(name),
      data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
function nbtString(value) {
  const text = Buffer.from(value),
    size = Buffer.alloc(2);
  size.writeUInt16BE(text.length);
  return Buffer.concat([size, text]);
}
function nbtTag(type, name, value) {
  return Buffer.concat([Buffer.from([type]), nbtString(name), value]);
}
function levelDat() {
  const last = Buffer.alloc(8);
  last.writeBigInt64BE(BigInt(Date.now()));
  const mode = Buffer.alloc(4);
  return gzipSync(
    Buffer.concat([
      Buffer.from([10, 0, 0]),
      nbtTag(
        10,
        "Data",
        Buffer.concat([
          nbtTag(8, "LevelName", nbtString("Codex fixture world")),
          nbtTag(4, "LastPlayed", last),
          nbtTag(3, "GameType", mode),
          nbtTag(1, "hardcore", Buffer.from([0])),
          Buffer.from([0]),
        ]),
      ),
      Buffer.from([0]),
    ]),
  );
}
function varint(number) {
  let value = number >>> 0;
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
function readVarint(bytes) {
  let value = 0;
  for (let i = 0; i < Math.min(5, bytes.length); i++) {
    value |= (bytes[i] & 127) << (7 * i);
    if (!(bytes[i] & 128)) return { value: value >>> 0, size: i + 1 };
  }
  return null;
}
async function startMockServer() {
  mockServer = net.createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length) {
        const length = readVarint(bytes);
        if (!length || bytes.length < length.size + length.value) return;
        const packet = bytes.subarray(length.size, length.size + length.value);
        bytes = bytes.subarray(length.size + length.value);
        if (packet.length === 1 && packet[0] === 0) {
          const json = Buffer.from(
            JSON.stringify({
              version: { name: "Codex protocol fixture", protocol: 763 },
              players: { max: 20, online: 3 },
              description: { text: "Local smoke server" },
            }),
          );
          const payload = Buffer.concat([
            Buffer.from([0]),
            varint(json.length),
            json,
          ]);
          socket.end(Buffer.concat([varint(payload.length), payload]));
        }
      }
    });
  });
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  return `127.0.0.1:${mockServer.address().port}`;
}
async function launcherLogs() {
  try {
    let text = "";
    for (const name of await readdir(path.join(storage, "logs")))
      if (name.endsWith(".log"))
        text += await readFile(path.join(storage, "logs", name), "utf8");
    return text;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

await mkdir(game, { recursive: true });
await mkdir(storage, { recursive: true });
try {
  if (process.platform === "win32") {
    const { spawnSync } = await import("node:child_process");
    const integrity = spawnSync("icacls.exe", [binary], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(
      integrity.status,
      0,
      `Cannot inspect the test executable: ${integrity.stderr || integrity.stdout}`,
    );
    assert(
      !/Low Mandatory Level/i.test(integrity.stdout),
      `The test executable has a Windows Low integrity label. Use SMOKE_BINARY with the normally installed executable or another output location that does not inherit that label; do not weaken ACLs or system security settings: ${binary}`,
    );
  }
  report.version = JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  ).version;
  report.binarySha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  report.suite = checkFilters.length ? "focused" : "full";
  report.filters = checkFilters;
  await copyImmutableCache();
  child = spawn(binary, [], {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      VOXELIGHT_LAUNCHER_DATA_DIR: storage,
      VOXELIGHT_LAUNCHER_GAME_DIR: game,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(work, "webview"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => {
    output += String(error);
  });
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  await eventually(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, 60000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await eventually(() => browser.contexts()[0]?.pages()[0]);
  report.webRuntimeErrors = [];
  page.on("pageerror", (error) => report.webRuntimeErrors.push(String(error)));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  invoke = async (name, args = {}) => {
    const outcome = await page.evaluate(
      async ({ name, args }) => {
        try {
          return {
            ok: true,
            value: await window.__TAURI_INTERNALS__.invoke(name, args),
          };
        } catch (error) {
          return {
            ok: false,
            error:
              error && typeof error === "object"
                ? Object.fromEntries(
                    Object.getOwnPropertyNames(error).map((key) => [
                      key,
                      error[key],
                    ]),
                  )
                : String(error),
          };
        }
      },
      { name, args },
    );
    if (!outcome.ok)
      throw new Error(`${name}: ${JSON.stringify(outcome.error)}`);
    return outcome.value;
  };
  const initial = await invoke("bootstrap");
  assert.equal(initial.config.gameDirectory, game);
  assert.equal(initial.accounts.length, 0);
  await check(
    "native v0.5 configuration and DPAPI service secret remain private",
    async () => {
      for (const field of [
        "javaAutoDownload",
        "screenWidth",
        "screenHeight",
        "downloadLimitKib",
        "microsoftClientId",
        "defaultSkin",
        "downloadSource",
      ])
        assert(field in initial.config, `Missing ${field}`);
      const secret = `Codex-Smoke-Only-${randomUUID()}`;
      assert.equal(
        await invoke("set_service_secret", { service: "curseforge", secret }),
        true,
      );
      assert.equal(
        (await invoke("get_service_status")).curseforgeConfigured,
        true,
      );
      assert(!JSON.stringify(await invoke("bootstrap")).includes(secret));
      assert(
        !(await readFile(path.join(storage, "state.json"), "utf8")).includes(
          secret,
        ),
      );
      const files = await readdir(path.join(storage, "secrets"));
      assert(files.length > 0);
      for (const file of files) {
        const bytes = await readFile(path.join(storage, "secrets", file));
        assert(!bytes.includes(Buffer.from(secret)));
      }
      await invoke("set_service_secret", { service: "curseforge", secret: "" });
    },
  );
  await check(
    "Steve and Alex use the selected verified client resources",
    async () => {
      assert.equal(initial.config.defaultSkin, "steve");
      await assert.rejects(
        () =>
          invoke("get_default_skin", {
            skin: "unknown",
            versionId: baseVersion,
          }),
        /仅支持/,
      );
      report.defaultSkins = [];
      await page
        .getByRole("button", { name: "角色", exact: true })
        .click();
      for (const [id, name, model] of [
        ["steve", "Steve", "classic"],
        ["alex", "Alex", "slim"],
      ]) {
        const character = await invoke("get_default_skin", {
          skin: id,
          versionId: baseVersion,
        });
        assert.equal(character.id, id);
        assert.equal(character.model, model);
        assert.equal(character.sourceVersion, baseVersion);
        assert.match(
          character.sourceUrl,
          /^https:\/\/piston-data\.mojang\.com\//,
        );
        const image = Buffer.from(
          character.dataUrl.replace(/^data:image\/png;base64,/, ""),
          "base64",
        );
        assert.equal(image.subarray(1, 4).toString(), "PNG");
        assert.equal(image.readUInt32BE(16), 64);
        assert.equal(image.readUInt32BE(20), 64);
        const choice = page.getByRole("radio", {
          name: new RegExp(`^${name}`),
        });
        await choice.click();
        await expect(choice).toBeChecked({ timeout: 60000 });
        await page
          .getByText(`来源：已校验的 Minecraft ${baseVersion} 客户端。`, {
            exact: true,
          })
          .waitFor({ state: "visible", timeout: 60000 });
        await page
          .locator('.vx-character-canvas[data-character-state="ready"]')
          .waitFor({ state: "visible", timeout: 60000 });
        assert.equal(
          await page.locator('.vx-character-canvas[data-character-state="error"]').count(),
          0,
        );
        assert.equal((await invoke("bootstrap")).config.defaultSkin, id);
        report.defaultSkins.push({
          id,
          model,
          sourceVersion: character.sourceVersion,
          sourceUrl: character.sourceUrl,
          dimensions: "64x64",
        });
      }
      assert.equal(await page.getByRole("radio", { name: "Lumen" }).count(), 0);
      report.realNetworkChecks.push(
        "Steve/Alex runtime extraction from official hash-verified Minecraft client; no bundled proprietary texture",
      );
    },
  );
  await eventually(async () => {
    const jobs = await invoke("list_download_tasks");
    return jobs.every(
      (job) => !["running", "queued", "paused"].includes(job.status),
    );
  }, 60000);
  await invoke("add_offline_account", { username: "CodexSmoke" });
  await invoke("save_config", {
    config: {
      ...initial.config,
      maxMemoryMb: 2048,
      downloadConcurrency: 8,
      javaPath: "",
      javaAutoDownload: true,
    },
  });
  await check(
    "BMCLAPI v2 metadata and verified client installation preserve official hashes",
    async () => {
      const previous = await invoke("get_config");
      const manifestResponse = await fetch(
        "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
        { signal: AbortSignal.timeout(30000) },
      );
      assert(
        manifestResponse.ok,
        `BMCLAPI manifest HTTP ${manifestResponse.status}`,
      );
      const remote = await manifestResponse.json();
      const entry = remote.versions.find(
        (version) => version.id === baseVersion,
      );
      assert(
        entry?.sha1 && entry.url.startsWith("https://piston-meta.mojang.com/"),
      );
      const metadata = JSON.parse(
        await readFile(
          path.join(game, "versions", baseVersion, `${baseVersion}.json`),
          "utf8",
        ),
      );
      const client = metadata.downloads.client;
      const clientPath = path.join(
        game,
        "versions",
        baseVersion,
        `${baseVersion}.jar`,
      );
      const preserved = path.join(work, "client-before-mirror-check.jar");
      let hadClient = false;
      try {
        await invoke("save_config", {
          config: { ...previous, downloadSource: "bmclapi" },
        });
        const listed = await invoke("list_versions");
        const listedEntry = listed.versions.find(
          (version) => version.id === baseVersion,
        );
        assert.equal(listedEntry.url, entry.url);
        const cached = await Promise.all(
          ["version-manifest-mojang.json", "version-manifest-bmclapi.json"].map(
            async (name) => {
              try {
                return JSON.parse(
                  await readFile(path.join(storage, name), "utf8"),
                );
              } catch (error) {
                if (error.code === "ENOENT") return null;
                throw error;
              }
            },
          ),
        );
        assert(
          cached.some(
            (manifest) =>
              manifest?.versions.find((version) => version.id === baseVersion)
                ?.sha1 === entry.sha1,
          ),
          "A source-tagged v2 cache must retain the expected metadata hash",
        );
        try {
          await rename(clientPath, preserved);
          hadClient = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await invoke("install_version", { versionId: baseVersion });
        const bytes = await readFile(clientPath);
        assert.equal(bytes.length, client.size);
        assert.equal(
          createHash("sha1").update(bytes).digest("hex"),
          client.sha1,
        );
        report.downloadSource = {
          requested: "bmclapi",
          manifest: "version_manifest_v2.json",
          versionId: baseVersion,
          officialMetadataUrl: entry.url,
          expectedSha1: client.sha1,
          verifiedBytes: bytes.length,
          officialFallbackRetained: true,
        };
        report.realNetworkChecks.push(
          "BMCLAPI v2 manifest and verified client installation with BMCLAPI preferred; official fallback retained",
        );
      } finally {
        await invoke("save_config", { config: previous });
        if (hadClient) await copyFile(preserved, clientPath);
      }
    },
  );
  fixtureInstance = await invoke("create_instance", {
    name: "Voxelight isolated fixture",
    versionId: baseVersion,
  });
  await mkdir(path.join(fixtureInstance.gameDirectory, "config"), {
    recursive: true,
  });
  await writeFile(
    path.join(fixtureInstance.gameDirectory, "config", "smoke.txt"),
    "fixture-version-one",
  );

  await check(
    "instance clone copies fixture bytes without changing source",
    async () => {
      const clone = await invoke("clone_instance", {
        instanceId: fixtureInstance.id,
        name: "Codex copied fixture",
      });
      assert.notEqual(clone.gameDirectory, fixtureInstance.gameDirectory);
      assert.equal(
        await readFile(
          path.join(clone.gameDirectory, "config", "smoke.txt"),
          "utf8",
        ),
        "fixture-version-one",
      );
      assert.equal(
        await readFile(
          path.join(fixtureInstance.gameDirectory, "config", "smoke.txt"),
          "utf8",
        ),
        "fixture-version-one",
      );
      report.fixtureOnlyChecks.push("instance clone");
    },
  );
  await check(
    "instance backup and reversible restoration recover fixture bytes",
    async () => {
      const backup = await invoke("backup_instance", {
        instanceId: fixtureInstance.id,
      });
      assert((await stat(backup.path)).size > 0);
      await writeFile(
        path.join(fixtureInstance.gameDirectory, "config", "smoke.txt"),
        "fixture-version-two",
      );
      const restored = await invoke("restore_instance_backup", {
        instanceId: fixtureInstance.id,
        backupId: backup.id,
      });
      fixtureInstance = restored.instance;
      assert.equal(
        await readFile(
          path.join(fixtureInstance.gameDirectory, "config", "smoke.txt"),
          "utf8",
        ),
        "fixture-version-one",
      );
      assert(
        restored.previousBackup || restored.previousDirectory,
        "Prior version must be preserved",
      );
      report.fixtureOnlyChecks.push("instance backup/restore");
    },
  );
  await check(
    "minimal mrpack export and import install real vanilla dependencies",
    async () => {
      const outputPath = path.join(work, "fixture-export.mrpack");
      await invoke("export_modrinth_modpack", {
        instanceId: fixtureInstance.id,
        outputPath,
        name: "Codex export fixture",
        includeConfigs: true,
        includeResourcePacks: false,
        includeShaderPacks: false,
        includeSaves: false,
        includeOwnedAssets: false,
      });
      const imported = await invoke("import_modpack", {
        path: outputPath,
        name: "Codex imported export",
        includeOptional: false,
      });
      assert.equal(imported.instance.versionId, baseVersion);
      assert.equal(
        await readFile(
          path.join(imported.instance.gameDirectory, "config", "smoke.txt"),
          "utf8",
        ),
        "fixture-version-one",
      );
      const manual = await put(
        "fixture-minimal.mrpack",
        zip([
          [
            "modrinth.index.json",
            JSON.stringify({
              formatVersion: 1,
              game: "minecraft",
              versionId: "fixture-1",
              name: "Codex minimal fixture",
              files: [],
              dependencies: { minecraft: baseVersion },
            }),
          ],
          ["overrides/config/import.txt", "minimal-pack-data"],
        ]),
      );
      const minimal = await invoke("import_modpack", {
        path: manual,
        name: "Codex minimal pack",
        includeOptional: false,
      });
      assert.equal(
        await readFile(
          path.join(minimal.instance.gameDirectory, "config", "import.txt"),
          "utf8",
        ),
        "minimal-pack-data",
      );
      report.fixtureOnlyChecks.push(
        "mrpack archive/overrides; vanilla dependency files are authentic Mojang files",
      );
    },
  );
  await check(
    "world NBT, world ZIP backup/import and PNG preview use isolated fixture files",
    async () => {
      const root = fixtureInstance.gameDirectory;
      const args = { versionId: baseVersion, instanceId: fixtureInstance.id };
      await mkdir(path.join(root, "saves", "WorldFixture"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, "saves", "WorldFixture", "level.dat"),
        levelDat(),
      );
      const worlds = await invoke("list_worlds", args);
      assert.equal(
        worlds.find((world) => world.folderName === "WorldFixture").name,
        "Codex fixture world",
      );
      const outputPath = path.join(work, "world-fixture.zip");
      await invoke("backup_world", {
        ...args,
        worldFolder: "WorldFixture",
        outputPath,
      });
      const imported = await invoke("import_world", {
        ...args,
        path: outputPath,
        name: "ImportedWorldFixture",
      });
      assert.equal(imported.folderName, "ImportedWorldFixture");
      await mkdir(path.join(root, "screenshots"), { recursive: true });
      await writeFile(
        path.join(root, "screenshots", "smoke.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ14AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      assert(
        (await invoke("list_screenshots", args)).some(
          (item) => item.fileName === "smoke.png",
        ),
      );
      assert(
        (
          await invoke("read_screenshot", { ...args, fileName: "smoke.png" })
        ).dataUrl.startsWith("data:image/png;base64,"),
      );
      await assert.rejects(() =>
        invoke("read_screenshot", { ...args, fileName: "../../state.json" }),
      );
      const resource = await put(
        "local-pack.zip",
        zip([
          [
            "pack.mcmeta",
            JSON.stringify({
              pack: { pack_format: 15, description: "Codex local fixture" },
            }),
          ],
        ]),
      );
      const importedFiles = await invoke("import_local_resources", {
        ...args,
        paths: [resource],
        resourceType: "resourcepack",
      });
      assert.equal(importedFiles.length, 1);
      assert((await stat(importedFiles[0].path)).size > 0);
      report.fixtureOnlyChecks.push(
        "world metadata/archive, screenshot and local resource fixture",
      );
    },
  );
  await check(
    "servers.dat preserves a real NBT entry and native TCP status talks to a local protocol fixture",
    async () => {
      const address = await startMockServer();
      const args = { versionId: baseVersion, instanceId: fixtureInstance.id };
      await invoke("save_server", {
        ...args,
        entry: {
          index: 0,
          name: "Codex local protocol fixture",
          address,
          icon: null,
          hideAddress: false,
        },
      });
      assert(
        (await invoke("list_servers", args)).some(
          (server) => server.address === address,
        ),
      );
      const status = await invoke("ping_server", { address });
      assert.equal(status.online, true);
      assert.equal(status.playersOnline, 3);
      assert.match(status.description, /Local smoke/);
      report.fixtureOnlyChecks.push(
        "local Minecraft status TCP fixture; no external game server",
      );
      await new Promise((resolve) => mockServer.close(resolve));
      mockServer = undefined;
    },
  );
  report.loaders = [];
  let fabricVersion, managedServer;
  await check(
    "same-version independent instances can run concurrently without duplicate PIDs",
    async () => {
      const installed = (await invoke("scan_versions")).find(
        (version) => version.id === baseVersion && version.launchable,
      );
      assert(installed, "The isolated vanilla version must be launchable");
      const first = await invoke("create_instance", {
        name: "Voxelight concurrent A",
        versionId: baseVersion,
      });
      const second = await invoke("create_instance", {
        name: "Voxelight concurrent B",
        versionId: baseVersion,
      });
      const pids = [];
      try {
        pids.push(
          (
            await invoke("launch_game", {
              versionId: baseVersion,
              instanceId: first.id,
            })
          ).pid,
        );
        pids.push(
          (
            await invoke("launch_game", {
              versionId: baseVersion,
              instanceId: second.id,
            })
          ).pid,
        );
        assert.equal(new Set(pids).size, 2);
        assert.notEqual(first.gameDirectory, second.gameDirectory);
        const games = await invoke("list_running_games");
        assert(
          games.some(
            (game) => game.instanceId === first.id && game.pid === pids[0],
          ),
        );
        assert(
          games.some(
            (game) => game.instanceId === second.id && game.pid === pids[1],
          ),
        );
        report.concurrentInstances = {
          versionId: baseVersion,
          distinctPids: pids.length,
          independentDirectories: true,
        };
      } finally {
        for (const pid of pids)
          await invoke("stop_game", { pid }).catch(() => {});
        await eventually(async () =>
          (await invoke("list_running_games")).every(
            (game) =>
              game.instanceId !== first.id && game.instanceId !== second.id,
          ),
        );
      }
    },
  );
  await check(
    "official Fabric installation, real rendering and running-instance guards",
    async () => {
      fabricVersion = (await verifyLoader("fabric")).versionId;
    },
  );
  await check(
    "official Quilt installation, real rendering and running-instance guards",
    async () => {
      await verifyLoader("quilt");
    },
  );
  await check(
    "official NeoForge installer, real rendering and running-instance guards",
    async () => {
      await verifyLoader("neoforge");
    },
  );
  await check(
    "official legacy NeoForge installer, real rendering and running-instance guards",
    async () => {
      await verifyLoader("neoforge", baseVersion);
    },
  );
  await check(
    "official Forge installer, real rendering and running-instance guards",
    async () => {
      await verifyLoader("forge");
    },
  );
  await check(
    "real Modrinth dependency resolution, targeted UI update and reversible rollback",
    async () => {
      if (!fabricVersion)
        fabricVersion = (await verifyLoader("fabric")).versionId;
      const instance = await invoke("create_instance", {
        name: "Voxelight Modrinth transaction",
        versionId: fabricVersion,
      });
      const directory = path.join(instance.gameDirectory, "mods");
      const params = new URLSearchParams({
        game_versions: JSON.stringify([baseVersion]),
        loaders: JSON.stringify(["fabric"]),
        include_changelog: "false",
      });
      const versions = await modrinth(`project/sodium-extra/version?${params}`);
      assert(
        versions.length > 1,
        "A previous compatible version is required for update testing",
      );
      const seeded = await seedMod(directory, versions[1]);
      const unknown = path.join(directory, "unknown-user.jar");
      await writeFile(unknown, "private local fixture");
      const args = {
        versionId: fabricVersion,
        instanceId: instance.id,
        resourceType: "mod",
      };
      const candidates = await invoke("check_resource_updates", args);
      assert(candidates.length > 0);
      assert(candidates.every((item) => item.fileName !== "unknown-user.jar"));
      const candidate = candidates.find(
        (item) => item.fileName === seeded.file.filename,
      );
      assert(candidate, "The older authentic Modrinth file must be identified");
      const updateArgs = {
        ...args,
        fileName: candidate.fileName,
        newVersionId: candidate.newVersionId,
      };
      console.log(`Refreshing native UI at ${page.url()}`);
      await page.reload();
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
      console.log(`Reloaded native UI at ${page.url()}`);
      await page.getByRole("button", { name: "游戏库", exact: true }).click();
      const instanceRow = page
        .locator(".vx-instance-card")
        .filter({ hasText: "Voxelight Modrinth transaction" });
      await instanceRow.locator(".vx-instance-card__select").click();
      await page.getByRole("tab", { name: "内容", exact: true }).click();
      await page.getByLabel("资源类型", { exact: true }).selectOption("mod");
      await page.getByRole("button", { name: "检查更新", exact: true }).click();
      const updateButton = page
        .getByRole("button", { name: "更新", exact: true })
        .first();
      await updateButton.waitFor({ state: "visible", timeout: 120000 });
      assert.equal(
        await page.getByRole("button", { name: "更新", exact: true }).count(),
        1,
        "The isolated fixture should expose exactly one actionable resource update",
      );
      await updateButton.click();
      await page
        .getByText("资源及必需前置已更新。", { exact: true })
        .waitFor({ state: "visible", timeout: 120000 });
      assert.equal(await readFile(unknown, "utf8"), "private local fixture");
      const history = await invoke("list_resource_update_history", args);
      const journal = history.find((item) => item.status === "committed");
      assert(
        journal,
        "The UI-driven update must create a committed transaction",
      );
      assert(
        journal.projects.length >= 3,
        "Both required dependencies must be in the transaction",
      );
      await page.getByRole("button", { name: "更新历史", exact: true }).click();
      const rollbackButton = page
        .locator(".vx-resource-row")
        .filter({ hasText: journal.name })
        .getByRole("button", { name: "回滚", exact: true });
      await rollbackButton.waitFor({ state: "visible" });
      page.once("dialog", (dialog) => dialog.accept());
      await rollbackButton.click();
      await page
        .getByText("回滚已完成。", { exact: true })
        .waitFor({ state: "visible", timeout: 60000 });
      assert.deepEqual(
        await readFile(path.join(directory, seeded.file.filename)),
        seeded.bytes,
      );
      assert.equal(await readFile(unknown, "utf8"), "private local fixture");
      const second = await invoke("update_resource", updateArgs);
      assert(second.updateId);
      const later = path.join(directory, "later-user.jar");
      await writeFile(later, "later local changes");
      await assert.rejects(
        () =>
          invoke("rollback_resource_update", {
            ...args,
            updateId: second.updateId,
          }),
        /发生变化/,
      );
      assert.equal(await readFile(later, "utf8"), "later local changes");
      report.resourceTransactions = {
        projectId: versions[1].project_id,
        oldVersionId: versions[1].id,
        newVersionId: candidate.newVersionId,
        requiredProjects: journal.projects,
        uiDriven: true,
        unknownFilesPreserved: true,
        laterChangesProtected: true,
      };
      report.realNetworkChecks.push(
        "UI-driven Modrinth hash identification, required dependencies, SHA-512, transaction commit and rollback",
      );
    },
  );
  await check(
    "official managed server keeps eula=false and refuses to start without consent",
    async () => {
      const settings = {
        port: 25575,
        maxPlayers: 20,
        onlineMode: true,
        whitelist: false,
        motd: "Voxelight isolated fixture",
        difficulty: "normal",
        gamemode: "survival",
        viewDistance: 10,
        maxMemoryMb: 2048,
        bindAddress: "127.0.0.1",
      };
      managedServer = await invoke("create_managed_server", {
        request: {
          name: "Voxelight isolated server",
          versionId: baseVersion,
          settings,
        },
      });
      assert(managedServer.installed);
      assert.equal(managedServer.eulaAccepted, false);
      assert.equal(managedServer.pid, null);
      assert.match(
        await readFile(path.join(managedServer.directory, "eula.txt"), "utf8"),
        /eula=false/,
      );
      await assert.rejects(
        () => invoke("start_managed_server", { serverId: managedServer.id }),
        /server\.eulaRequired|EULA/,
      );
      assert.equal(
        (await invoke("list_managed_servers")).find(
          (item) => item.id === managedServer.id,
        ).pid,
        null,
      );
      await assert.rejects(
        () =>
          invoke("send_managed_server_command", {
            serverId: managedServer.id,
            command: "stop\nsay injected",
          }),
        /控制字符|换行/,
      );
      assert.equal(
        (
          await invoke("read_managed_server_logs", {
            serverId: managedServer.id,
            limit: 200,
          })
        ).length,
        0,
      );
      report.managedServer = {
        officialJarVerified: true,
        defaultEula: false,
        startRejectedWithoutConsent: true,
        eulaAcceptedByTest: false,
      };
      report.realNetworkChecks.push(
        "official Minecraft server JAR with SHA-1; no real EULA acceptance or server startup",
      );
    },
  );
  await check(
    "pause/resume, queued cancellation and active cancellation allow the next job",
    async () => {
      const first = await invoke("queue_install", { versionId: baseVersion });
      await eventually(async () => {
        const jobs = await invoke("list_download_tasks");
        return jobs.find((job) => job.id === first && job.status === "running");
      });
      await invoke("set_download_paused", { paused: true });
      const second = await invoke("queue_install", { versionId: baseVersion });
      const cancelled = await invoke("cancel_download_task", {
        taskId: second,
      });
      assert.equal(
        cancelled.find((job) => job.id === second).status,
        "cancelled",
      );
      await invoke("set_download_paused", { paused: false });
      await eventually(async () => {
        const job = (await invoke("list_download_tasks")).find(
          (job) => job.id === first,
        );
        if (job?.status === "failed") throw new Error(job.error);
        return job?.status === "completed";
      }, 90000);
      assert.equal(
        (await invoke("list_download_tasks")).find((job) => job.id === second)
          .status,
        "cancelled",
      );
      const active = await invoke("queue_install", { versionId: "1.21.1" });
      await eventually(async () =>
        (await invoke("list_download_tasks")).find(
          (job) => job.id === active && job.status === "running",
        ),
      );
      await invoke("cancel_download_task", { taskId: active });
      await eventually(
        async () =>
          (await invoke("list_download_tasks")).find((job) => job.id === active)
            ?.status === "cancelled",
      );
      const skinAfterCancellation = await invoke("get_default_skin", {
        skin: "steve",
        versionId: baseVersion,
      });
      assert.equal(skinAfterCancellation.id, "steve");
      assert(
        skinAfterCancellation.dataUrl?.startsWith("data:image/png;base64,"),
      );
      const cancelBeforeLaunch = await invoke("queue_install", {
        versionId: "1.21.1",
      });
      await eventually(async () =>
        (await invoke("list_download_tasks")).find(
          (job) => job.id === cancelBeforeLaunch && job.status === "running",
        ),
      );
      await invoke("cancel_download_task", { taskId: cancelBeforeLaunch });
      await eventually(
        async () =>
          (await invoke("list_download_tasks")).find(
            (job) => job.id === cancelBeforeLaunch,
          )?.status === "cancelled",
      );
      const directLaunch = await invoke("launch_game", {
        versionId: baseVersion,
        instanceId: fixtureInstance.id,
      });
      gamePid = directLaunch.pid;
      assert(gamePid > 0);
      await invoke("stop_game", { pid: gamePid });
      gamePid = undefined;
      await eventually(async () =>
        (await invoke("list_running_games")).every(
          (game) => game.instanceId !== fixtureInstance.id,
        ),
      );
      const next = await invoke("queue_install", { versionId: baseVersion });
      await eventually(
        async () =>
          (await invoke("list_download_tasks")).find((job) => job.id === next)
            ?.status === "completed",
        90000,
      );
      report.downloadControls = {
        pausedAndResumed: first,
        queuedCancellation: second,
        activeCancellation: active,
        nextAfterCancellation: next,
      };
    },
  );
  await check(
    "managed-server UI never implicitly accepts the EULA",
    async () => {
      assert(managedServer, "The isolated managed server must exist");
      await page.getByRole("button", { name: "联机", exact: true }).click();
      await page.getByRole("tab", { name: "服务端管理", exact: true }).click();
      assert(
        !(await page
          .getByRole("checkbox", { name: "同意 Minecraft EULA", exact: true })
          .isChecked()),
      );
      assert(
        await page
          .getByRole("button", { name: "启动服务端", exact: true })
          .isDisabled(),
      );
      await page.screenshot({
        path: path.join(work, "native-server-manager.png"),
        fullPage: true,
      });
    },
  );
  await check(
    "native home renders the animated world and skin page without runtime errors",
    async () => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.getByRole("button", { name: "开始", exact: true }).click();
      const scene = page.locator(".world-scene").first();
      await scene.waitFor({ state: "visible" });
      const bounds = await scene.boundingBox();
      assert(bounds && bounds.width > 200 && bounds.height > 200);
      assert.equal(await scene.getAttribute("data-motion"), "full");
      assert.deepEqual(report.webRuntimeErrors, []);
      await page.screenshot({
        path: path.join(work, "native-home.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "角色", exact: true })
        .click();
      const canvas = page.getByRole("img", {
        name: "可交互的 Minecraft 角色预览",
        exact: true,
      });
      await canvas.waitFor({ state: "visible" });
      assert(
        await canvas.evaluate((node) => node.width > 50 && node.height > 50),
      );
      await page.screenshot({
        path: path.join(work, "native-skins.png"),
        fullPage: true,
      });
    },
  );
} catch (error) {
  report.failures.push({ name: "test harness/setup", error: String(error) });
  console.error(error);
} finally {
  if (invoke)
    try {
      await invoke("cancel_download_task", { taskId: null });
      await invoke("set_download_paused", { paused: false });
      for (const game of await invoke("list_running_games"))
        await invoke("stop_game", { pid: game.pid });
    } catch {}
  if (gamePid)
    try {
      process.kill(gamePid);
    } catch {}
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve));
  if (browser) await browser.close().catch(() => {});
  child?.kill();
  if (
    checkFilters.length > 0 &&
    report.checks.length + report.failures.length === 0
  )
    report.failures.push({
      name: "test selection",
      error: `No smoke check matched SMOKE_CHECKS=${process.env.SMOKE_CHECKS}`,
    });
  report.success = report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  const destination =
    process.env.SMOKE_REPORT || path.join(work, "report.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2));
  await writeFile(path.join(work, "native-output.log"), output);
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
}
