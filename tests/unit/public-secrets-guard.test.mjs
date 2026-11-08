import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../../scripts/check-public-secrets.mjs", import.meta.url));
const publicIgnore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
const fixtureOne = "11111111-1111-1111-1111-111111111111";
const fixtureTwo = "22222222-2222-2222-2222-222222222222";
// Deliberately synthetic, but outside the repeated-character fixture exemption.
const mixed = ["11111111", "2222", "1111", "2222", "111111111111"].join("-");
const otherMixed = ["22222222", "1111", "2222", "1111", "222222222222"].join("-");
const uuid = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

function repository(t, { privateMode = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "voxelight-public-guard-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "absent-global-config"),
    GIT_AUTHOR_NAME: "Guard Fixture",
    GIT_AUTHOR_EMAIL: "guard@example.invalid",
    GIT_COMMITTER_NAME: "Guard Fixture",
    GIT_COMMITTER_EMAIL: "guard@example.invalid",
  };
  // A fixture must never inherit a caller's Git repository or injected config.
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  }
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, `fixture Git command failed: ${args[0]}`);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "guard fixture");
  };
  const check = () => {
    const result = spawnSync(process.execPath, [script, "--root", root], { cwd: root, env, encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(uuid.test(output), false, "guard diagnostics must never include a UUID");
    return { status: result.status, output };
  };
  git("init", "-q", "-b", "main");
  if (privateMode) git("config", "--local", "voxelight.private", "true");
  return { root, git, write, commit, check };
}

function rejected(result, location) {
  assert.equal(result.status, 1, "guard must reject unsafe repository content");
  assert.equal(result.output.trim().split(/\r?\n/).every(line => /^[^\r\n]+:\d+:[A-Za-z_][A-Za-z0-9_.-]*$/.test(line)), true, "rejections must contain only file:line:key diagnostics");
  if (location) assert.equal(result.output.includes(location), true, "diagnostic must identify only the file, line, and key");
}

test("public guard rejects keyed UUIDs without exposing their values", t => {
  const repo = repository(t);
  repo.write("src/demo.ts", `// synthetic fixture\nclientId: "${mixed}"\n`);
  rejected(repo.check(), "src/demo.ts:2:clientId");
});

test("client ID key spellings, env tables, typed constants, and multiline values are guarded", t => {
  const repo = repository(t);
  const cases = [
    ["microsoftClientId", `"microsoftClientId": "${mixed}"`],
    ["microsoft_client_id", `microsoft_client_id = '${mixed}'`],
    ["client-id", `client-id: "${mixed}"`],
    ["MS_CLIENT_ID", `MS_CLIENT_ID="${mixed}"`],
    ["VOXELIGHT_MS_CLIENT_ID", `VOXELIGHT_MS_CLIENT_ID = { value = "${mixed}", force = true }`],
    ["VOXELIGHT_MS_CLIENT_ID", `VOXELIGHT_MS_CLIENT_ID = { force = true, value = "${mixed}" }`],
    ["CLIENT_ID", `const CLIENT_ID: &str = "${mixed}";`],
    ["clientId", `clientId:\n  "${mixed}"`],
    ["clientId", `--clientId, '${mixed}'`],
    ["clientid", `clientid=${mixed}`],
  ];
  for (const [key, content] of cases) {
    repo.write("example.txt", content);
    rejected(repo.check(), `example.txt:1:${key}`);
  }
});

test("only one repeated hex character is exempt and unrelated UUIDs remain allowed", t => {
  const repo = repository(t);
  repo.write("fixtures.ts", `clientId: "${fixtureOne}"\nmicrosoftClientId: "${fixtureTwo}"\ninstanceId: "${mixed}"`);
  assert.equal(repo.check().status, 0);
  repo.write("fixtures.ts", `clientId: "${mixed}"`);
  rejected(repo.check());
});

test("public guard skips lockfiles, binary content, and files above the text size limit", t => {
  const repo = repository(t);
  repo.write("package-lock.json", `{"clientId":"${mixed}"}`);
  repo.write("src-tauri/Cargo.lock", `client_id = "${mixed}"`);
  repo.write("image.bin", Buffer.from(`\0clientId: "${mixed}"`));
  repo.write("large.txt", `${" ".repeat(2 * 1024 * 1024 + 1)}\nclientId: "${mixed}"`);
  assert.equal(repo.check().status, 0);
});

test("tracked files remain guarded after matching an ignore rule", t => {
  const repo = repository(t);
  repo.write("ignored.txt", "safe\n");
  repo.commit();
  repo.write(".gitignore", "ignored.txt\n");
  repo.write("ignored.txt", `clientId: "${mixed}"`);
  rejected(repo.check(), "ignored.txt:1:clientId");
});

test("the staged version is guarded even when the working copy has been cleaned", t => {
  const repo = repository(t);
  repo.write("staged.ts", `clientId: "${mixed}"`);
  repo.git("add", "staged.ts");
  repo.write("staged.ts", "// clean working copy\n");
  rejected(repo.check(), "staged.ts:1:clientId");
});

test("the staged version is guarded even when its working file is absent", t => {
  const repo = repository(t);
  repo.write("staged.ts", `clientId: "${mixed}"`);
  repo.git("add", "staged.ts");
  rmSync(join(repo.root, "staged.ts"));
  rejected(repo.check(), "staged.ts:1:clientId");
});

for (const path of [".cargo", "src-tauri/.cargo", ".cargo/config.toml", "src-tauri/.cargo/config.toml", ".cargo/extra.toml", "src-tauri/.cargo/nested/extra.toml"]) {
  test(`public guard rejects tracked Cargo configuration at ${path}`, t => {
    const repo = repository(t);
    repo.write(path, "# no ID is necessary to fail this rule\n");
    repo.git("add", path);
    rejected(repo.check(), `${path}:1:cargo-path`);
  });
}

test("would-be-committed Cargo files are rejected before staging", t => {
  const repo = repository(t);
  repo.write("src-tauri/.cargo/extra.toml", "# synthetic config\n");
  rejected(repo.check(), "src-tauri/.cargo/extra.toml:1:cargo-path");
});

test("public ignore rules exclude both local private config paths from addition", t => {
  const repo = repository(t);
  repo.write(".gitignore", publicIgnore);
  repo.write(".cargo/config.toml", "# local config\n");
  repo.write("src-tauri/.cargo/config.toml", "# local config\n");
  assert.equal(repo.git("check-ignore", ".cargo/config.toml", "src-tauri/.cargo/config.toml").split(/\r?\n/).length, 2);
  assert.equal(repo.check().status, 0);
});

test("Cargo configuration that was deleted still fails the public history check", t => {
  const repo = repository(t);
  repo.write(".cargo/config.toml", "# synthetic config\n");
  repo.commit();
  repo.git("rm", ".cargo/config.toml");
  repo.commit();
  rejected(repo.check(), ".cargo/config.toml:1:cargo-history");
});

for (const refKind of ["branch", "tag", "remote"]) {
  test(`Cargo history reachable only through a ${refKind} is rejected`, t => {
    const repo = repository(t);
    repo.write("README.md", "fixture\n");
    repo.commit();
    repo.git("checkout", "-qb", "private-fixture");
    repo.write("src-tauri/.cargo/config.toml", "# synthetic config\n");
    repo.commit();
    if (refKind === "tag") repo.git("tag", "private-fixture-tag");
    if (refKind === "remote") repo.git("update-ref", "refs/remotes/fixture/private", "HEAD");
    repo.git("checkout", "-q", "main");
    if (refKind !== "branch") repo.git("branch", "-D", "private-fixture");
    rejected(repo.check(), "src-tauri/.cargo/config.toml:1:cargo-history");
  });
}

test("history traversal detects Cargo files hidden by a merge resolution", t => {
  const repo = repository(t);
  repo.write("README.md", "fixture\n");
  repo.commit();
  repo.git("checkout", "-qb", "private-fixture");
  repo.write(".cargo/config.toml", "# synthetic config\n");
  repo.commit();
  repo.git("checkout", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "-s", "ours", "private-fixture", "-m", "fixture merge");
  repo.git("branch", "-D", "private-fixture");
  rejected(repo.check(), ".cargo/config.toml:1:cargo-history");
});

test("Cargo files first introduced by a merge commit remain forbidden after deletion", t => {
  const repo = repository(t);
  repo.write("README.md", "fixture\n");
  repo.commit();
  repo.git("checkout", "-qb", "feature-fixture");
  repo.write("feature.txt", "fixture\n");
  repo.commit();
  repo.git("checkout", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "--no-commit", "feature-fixture");
  repo.write("src-tauri/.cargo/config.toml", "# synthetic merge-only config\n");
  repo.commit();
  repo.git("rm", "src-tauri/.cargo/config.toml");
  repo.commit();
  repo.git("branch", "-D", "feature-fixture");
  rejected(repo.check(), "src-tauri/.cargo/config.toml:1:cargo-history");
});

test("private mode permits both config locations and their committed history", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${mixed}'\n`);
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = { value = "${otherMixed}", force = true }\n`);
  repo.commit();
  assert.equal(repo.check().status, 0);
});

test("private mode fails closed when no Cargo environment config exists", t => {
  const repo = repository(t, { privateMode: true });
  rejected(repo.check(), "src-tauri/.cargo/config.toml:1:VOXELIGHT_MS_CLIENT_ID");
});

for (const [name, config] of [
  ["missing key", "[env]\nOTHER_ENV = 'fixture'\n"],
  ["empty value", "[env]\nVOXELIGHT_MS_CLIENT_ID = ''\n"],
  ["unparseable inline value", "[env]\nVOXELIGHT_MS_CLIENT_ID = { value = 'not-an-id-fixture', force = true }\n"],
  ["unparseable table value", "[env.VOXELIGHT_MS_CLIENT_ID]\nvalue = 'not-an-id-fixture'\nforce = true\n"],
  ["UUID prefix with extra content", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}-extra-fixture'\n`],
  ["commented-out key", `[env]\n# VOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`],
]) {
  test(`private mode rejects config with ${name} without printing the value`, t => {
    const repo = repository(t, { privateMode: true });
    repo.write("src-tauri/.cargo/config.toml", config);
    const result = repo.check();
    rejected(result, "src-tauri/.cargo/config.toml:");
    assert.equal(result.output.includes("not-an-id-fixture"), false);
    assert.equal(result.output.includes("extra-fixture"), false);
  });
}

test("private mode reads the Cargo env table and rejects exact IDs under unrelated keys", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env.VOXELIGHT_MS_CLIENT_ID]\nvalue = '${fixtureOne}'\nforce = true\n`);
  assert.equal(repo.check().status, 0, "a valid Cargo table config is permitted");
  repo.write("src/leak.ts", `// synthetic fixture\nconst app = '${fixtureOne}';\n`);
  rejected(repo.check(), "src/leak.ts:2:VOXELIGHT_MS_CLIENT_ID");
  repo.git("add", "src/leak.ts");
  repo.write("src/leak.ts", "// cleaned working copy\n");
  rejected(repo.check(), "src/leak.ts:2:VOXELIGHT_MS_CLIENT_ID");
});

test("private mode does not let another valid config conceal an unparseable ID", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureTwo}'\n`);
  repo.write("src-tauri/.cargo/config.toml", "[env]\nVOXELIGHT_MS_CLIENT_ID = ''\n");
  rejected(repo.check(), "src-tauri/.cargo/config.toml:2:VOXELIGHT_MS_CLIENT_ID");
});

test("private mode rejects an invalid working ID even if the staged config is valid", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.git("add", "src-tauri/.cargo/config.toml");
  repo.write("src-tauri/.cargo/config.toml", "[env]\nVOXELIGHT_MS_CLIENT_ID = ''\n");
  rejected(repo.check(), "src-tauri/.cargo/config.toml:2:VOXELIGHT_MS_CLIENT_ID");
});

test("private mode rejects a missing working config even if its staged copy has an ID", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.git("add", "src-tauri/.cargo/config.toml");
  rmSync(join(repo.root, "src-tauri/.cargo/config.toml"));
  rejected(repo.check(), "src-tauri/.cargo/config.toml:1:VOXELIGHT_MS_CLIENT_ID");
});

test("private mode rejects a working config without an ID even if the staged copy is valid", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.git("add", "src-tauri/.cargo/config.toml");
  repo.write("src-tauri/.cargo/config.toml", "[env]\nOTHER_ENV = 'fixture'\n");
  rejected(repo.check(), "src-tauri/.cargo/config.toml:1:VOXELIGHT_MS_CLIENT_ID");
});

test("private mode permits unrelated Cargo config alongside a valid environment ID", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", "[build]\njobs = 2\n");
  repo.write("src-tauri/.cargo/config.toml", `[env.VOXELIGHT_MS_CLIENT_ID]\nvalue = '${fixtureTwo}'\n`);
  assert.equal(repo.check().status, 0);
});

for (const [name, higherPriority] of [
  ["env dotted keys", `[env]\nVOXELIGHT_MS_CLIENT_ID.value = '${fixtureTwo}'\nVOXELIGHT_MS_CLIENT_ID.force = true\n`],
  ["root dotted keys", `env.VOXELIGHT_MS_CLIENT_ID.value = '${fixtureTwo}'\nenv.VOXELIGHT_MS_CLIENT_ID.force = true\n`],
  ["quoted dotted keys", `["env"]\n"VOXELIGHT_MS_CLIENT_ID"."value" = '${fixtureTwo}'\n"VOXELIGHT_MS_CLIENT_ID"."force" = true\n`],
  ["escaped quoted key", `[env]\n"\\u0056OXELIGHT_MS_CLIENT_ID".value = '${fixtureTwo}'\n`],
]) {
  test(`private mode checks higher-priority ${name} as well as another valid config`, t => {
    const repo = repository(t, { privateMode: true });
    repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
    repo.write("src-tauri/.cargo/config.toml", higherPriority);
    assert.equal(repo.check().status, 0, "valid supported Cargo values remain usable");
    repo.write("src/leak.ts", `// synthetic fixture\nconst app = '${fixtureTwo}';\n`);
    rejected(repo.check(), "src/leak.ts:2:VOXELIGHT_MS_CLIENT_ID");
    repo.git("add", "src/leak.ts");
    repo.write("src/leak.ts", "// cleaned working copy\n");
    rejected(repo.check(), "src/leak.ts:2:VOXELIGHT_MS_CLIENT_ID");
  });
}

for (const [name, assignment] of [
  ["empty dotted value", "VOXELIGHT_MS_CLIENT_ID.value = ''"],
  ["unknown target field", "VOXELIGHT_MS_CLIENT_ID.unsupported = 'fixture'"],
  ["nested target value", "VOXELIGHT_MS_CLIENT_ID.value.unsupported = 'fixture'"],
]) {
  test(`private mode fails closed for ${name} beside a valid lower-priority ID`, t => {
    const repo = repository(t, { privateMode: true });
    repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
    repo.write("src-tauri/.cargo/config.toml", `[env]\n${assignment}\n`);
    rejected(repo.check(), "src-tauri/.cargo/config.toml:2:VOXELIGHT_MS_CLIENT_ID");
  });
}

test("private mode refuses a config file symlink beside another valid config without following it", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  // This synthetic source is outside the candidate-file set, so reading it
  // would require following the config symlink rather than scanning a file.
  repo.write(".git/fixture-source.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureTwo}'\n`);
  mkdirSync(join(repo.root, "src-tauri/.cargo"), { recursive: true });
  symlinkSync(join(repo.root, ".git/fixture-source.toml"), join(repo.root, "src-tauri/.cargo/config.toml"), "file");
  repo.write("src/leak.ts", `const app = '${fixtureTwo}';\n`);
  rejected(repo.check(), "src-tauri/.cargo/config.toml:1:VOXELIGHT_MS_CLIENT_ID");
});

test("private mode rejects a staged config symlink even when the working config is regular", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.write(".git/fixture-source.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureTwo}'\n`);
  repo.write("fixture-link-target.txt", ".git/fixture-source.toml");
  const object = repo.git("hash-object", "-w", "fixture-link-target.txt");
  repo.git("update-index", "--add", "--cacheinfo", `120000,${object},src-tauri/.cargo/config.toml`);
  assert.match(repo.git("ls-files", "--stage", "src-tauri/.cargo/config.toml"), /^120000 /);
  repo.write("src/leak.ts", `const app = '${fixtureTwo}';\n`);
  rejected(repo.check(), "src-tauri/.cargo/config.toml:1:VOXELIGHT_MS_CLIENT_ID");
});

for (const [name, config] of [
  ["root env inline map", `env = { VOXELIGHT_MS_CLIENT_ID = '${fixtureTwo}' }\n`],
  ["escaped root env inline map", `"\\u0065nv" = { "\\u0056OXELIGHT_MS_CLIENT_ID" = '${fixtureTwo}' }\n`],
]) {
  test(`private mode rejects unsupported ${name} beside another parsed config`, t => {
    const repo = repository(t, { privateMode: true });
    repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
    repo.write("src-tauri/.cargo/config.toml", config);
    rejected(repo.check(), "src-tauri/.cargo/config.toml:1:VOXELIGHT_MS_CLIENT_ID");
  });
}

test("private mode ignores unrelated build and net Windows path strings", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.write("src-tauri/.cargo/config.toml", String.raw`[build]
target-dir = 'C:\build\cache'
[net]
fixture-cache = 'C:\net\cache'
`);
  assert.equal(repo.check().status, 0);
});

for (const [name, config, line] of [
  ["direct", `[env]\nvoxelight_ms_client_id = { value = '${fixtureTwo}', force = true }\n`, 2],
  ["dotted", `[env]\nVoXeLiGhT_mS_cLiEnT_iD.value = '${fixtureTwo}'\nVoXeLiGhT_mS_cLiEnT_iD.force = true\n`, 2],
  ["standard-table", `[env.voxelight_MS_client_ID]\nvalue = '${fixtureTwo}'\nforce = true\n`, 1],
]) {
  test(`private mode refuses noncanonical target env casing in ${name} config`, t => {
    const repo = repository(t, { privateMode: true });
    repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
    repo.write("src-tauri/.cargo/config.toml", config);
    repo.write("src/leak.ts", `const app = '${fixtureTwo}';\n`);
    rejected(repo.check(), `src-tauri/.cargo/config.toml:${line}:VOXELIGHT_MS_CLIENT_ID`);
  });
}

test("private mode detects exact IDs under unrelated keys in tracked and candidate files", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = { force = true, value = "${mixed}" }\n`);
  repo.commit();
  repo.write("src/leak.ts", `// synthetic data\nconst app = "${mixed}";\n`);
  rejected(repo.check(), "src/leak.ts:2:VOXELIGHT_MS_CLIENT_ID");
  repo.git("add", "src/leak.ts");
  repo.write("src/leak.ts", "// cleaned copy\n");
  rejected(repo.check(), "src/leak.ts:2:VOXELIGHT_MS_CLIENT_ID");
});

test("private exact-value checks also cover binary, lock, and oversized candidate files", t => {
  const repo = repository(t, { privateMode: true });
  repo.write(".cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = "${mixed}"\n`);
  for (const [path, content, line] of [
    ["package-lock.json", `{"app":"${mixed}"}`, 1],
    ["image.bin", Buffer.from(`\0${mixed}`), 1],
    ["large.txt", `${" ".repeat(2 * 1024 * 1024 + 1)}\n${mixed}`, 2],
  ]) {
    repo.write(path, content);
    rejected(repo.check(), `${path}:${line}:VOXELIGHT_MS_CLIENT_ID`);
    rmSync(join(repo.root, path));
  }
});

test("private mode permits only disabled push placeholders", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.git("remote", "add", "public", "https://example.invalid/public.git");
  repo.git("remote", "set-url", "--push", "public", "DISABLED-private-never-pushes");
  assert.equal(repo.check().status, 0);
  repo.git("remote", "add", "backup", "https://example.invalid/backup.git");
  repo.git("remote", "set-url", "--push", "backup", "DISABLED");
  assert.equal(repo.check().status, 0);
});

test("private mode rejects effective fetch URL fallback without exposing a push address", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  const address = "https://example.invalid/private-fixture.git";
  repo.git("remote", "add", "public", address);
  const result = repo.check();
  rejected(result, ".git/config:1:remote.pushurl");
  assert.equal(result.output.includes(address), false, "push URLs must stay out of diagnostics");
});

test("private mode checks every configured push URL", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.git("remote", "add", "public", "https://example.invalid/public.git");
  repo.git("remote", "set-url", "--push", "public", "DISABLED-private-never-pushes");
  repo.git("remote", "set-url", "--push", "--add", "public", "https://example.invalid/second.git");
  rejected(repo.check(), ".git/config:1:remote.pushurl");
});

test("private mode checks Git URL rewriting instead of trusting a disabled-looking raw value", t => {
  const repo = repository(t, { privateMode: true });
  repo.write("src-tauri/.cargo/config.toml", `[env]\nVOXELIGHT_MS_CLIENT_ID = '${fixtureOne}'\n`);
  repo.git("remote", "add", "public", "DISABLED-private-never-pushes");
  repo.git("config", "--local", "url.https://example.invalid/rewrite.git.pushInsteadOf", "DISABLED-private-never-pushes");
  rejected(repo.check(), ".git/config:1:remote.pushurl");
});
