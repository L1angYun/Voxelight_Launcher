import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const npmArgs = ["audit", "--audit-level=moderate", "--json"];
const idPattern = /^[a-z0-9][a-z0-9:_.-]{0,127}$/i;
const packagePattern = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]{1,214}$/i;
const usage = "Usage: node scripts/check-toolchain.mjs --msrv [--strict] | --audit [--only=cargo|npm]";

function validFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function npmAuditInvocation({ platform, execPath, env, isFile = validFile }) {
  const configured = env.npm_execpath;
  if (configured && /\.m?js$/i.test(configured) && isFile(configured)) {
    return { command: execPath, args: [configured, ...npmArgs] };
  }
  if (platform !== "win32") return { command: "npm", args: npmArgs };

  const adjacent = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (isFile(adjacent)) return { command: execPath, args: [adjacent, ...npmArgs] };

  // npm.cmd cannot be executed directly by Node on Windows. The shell only sees a fixed
  // literal command; the checkout path is passed separately as the child's working directory.
  return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd audit --audit-level=moderate --json"] };
}

function flagSet(args) {
  if (new Set(args).size !== args.length) return undefined;
  const has = (flag) => args.includes(flag);
  if (has("--msrv") && args.every((arg) => ["--msrv", "--strict"].includes(arg))) {
    return { mode: "msrv", strict: has("--strict") };
  }
  if (has("--audit") && args.every((arg) => ["--audit", "--only=cargo", "--only=npm"].includes(arg)) &&
      !(has("--only=cargo") && has("--only=npm"))) {
    return { mode: "audit", only: args.find((arg) => arg.startsWith("--only="))?.slice(7) };
  }
}

function runMsrv(ctx, strict) {
  let requested;
  try {
    const manifest = readFileSync(path.join(ctx.rustDir, "Cargo.toml"), "utf8");
    const packageTable = manifest.split(/^\s*\[package\][^\r\n]*\r?\n/m)[1]?.split(/^\s*\[/m)[0];
    requested = packageTable?.match(/^\s*rust-version\s*=\s*["'](\d+\.\d+(?:\.\d+)?)["']\s*(?:#.*)?$/m)?.[1];
    if (!requested) throw new Error("missing version");
  } catch {
    ctx.stderr("msrv: failed (could not read package rust-version from src-tauri/Cargo.toml)");
    return 1;
  }
  const unavailable = () => {
    const details = "Rust " + requested + " is not installed; run rustup toolchain install " + requested + " --profile minimal";
    if (strict) {
      ctx.stderr("msrv: failed (" + details + ")");
      return 2;
    }
    ctx.stdout("SKIPPED: " + details + "\nmsrv: skipped");
    return 0;
  };

  const listed = ctx.command("rustup", ["toolchain", "list"], ctx.rustDir);
  if (absent(listed)) return unavailable();
  if (listed.status !== 0) {
    ctx.stderr("msrv: failed (rustup toolchain list failed)");
    return 1;
  }
  const full = requested.split(".").length === 2 ? requested + ".0" : requested;
  const toolchain = listed.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s/)[0]).find((name) => {
    const version = name.match(/^(\d+\.\d+(?:\.\d+)?)(?:-[a-z0-9_]+-[a-z0-9_-]+)?$/i)?.[1];
    return version === requested || version === full;
  });
  if (!toolchain) return unavailable();

  const output = ctx.command("cargo", ["+" + toolchain, "check", "--locked", "--all-targets"], ctx.rustDir, {
    ...ctx.env, CARGO_TARGET_DIR: path.join(ctx.rustDir, "target", "msrv"),
  });
  if (output.error || output.status !== 0) {
    ctx.stderr("msrv: failed (Rust " + requested + " cargo check --locked --all-targets; rerun that command for compiler diagnostics)");
    return 1;
  }
  ctx.stdout("msrv: ok (Rust " + requested + ")");
  return 0;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentity(id, packageName) {
  return typeof id === "string" && idPattern.test(id) &&
    typeof packageName === "string" && packagePattern.test(packageName);
}

function dateIsValid(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(date + "T00:00:00Z");
  return Number.isFinite(value.getTime()) && value.toISOString().startsWith(date);
}

function key(id, packageName) {
  return id + "\0" + packageName;
}

function readAllowlist(ctx) {
  const file = path.join(ctx.root, "scripts", "advisory-allowlist.json");
  let rules;
  try {
    // Windows editors often save with a UTF-8 BOM; accept one leading BOM.
    const text = readFileSync(file, "utf8");
    rules = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw new AuditError("allowlist is invalid (expected scripts/advisory-allowlist.json)");
  }
  if (!Array.isArray(rules)) throw new AuditError("allowlist is invalid (expected an array)");
  const allowed = new Set();
  for (const [index, entry] of rules.entries()) {
    const location = "allowlist entry " + (index + 1);
    if (!record(entry) || !validIdentity(entry.id, entry.package) ||
        typeof entry.reason !== "string" || !entry.reason.trim() || !dateIsValid(entry.expires)) {
      throw new AuditError(location + " is invalid (expected id, package, reason, and an ISO expiration date)");
    }
    if (entry.expires < ctx.today) throw new AuditError(location + " expired (" + entry.id + " " + entry.package + ")");
    const identity = key(entry.id, entry.package);
    if (allowed.has(identity)) throw new AuditError(location + " is invalid (duplicate id/package)");
    allowed.add(identity);
  }
  return allowed;
}

class AuditError extends Error {}

function invalidReport() {
  return new AuditError("invalid or incomplete scanner JSON");
}

function severity(value) {
  const label = value === "medium" ? "moderate" : value;
  return ["info", "low", "moderate", "high", "critical"].includes(label) ? label : "unknown";
}

function cvss3Severity(vector) {
  if (typeof vector !== "string" || !/^CVSS:3\.[01]\//.test(vector)) return undefined;
  const values = Object.fromEntries(vector.split("/").slice(1).map((metric) => metric.split(":")));
  if (!/^[UC]$/.test(values.S ?? "")) return undefined;
  const scopeChanged = values.S === "C";
  const weights = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    PR: scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 },
    UI: { N: 0.85, R: 0.62 },
  };
  const impacts = { H: 0.56, L: 0.22, N: 0 };
  const impactBase = 1 - (1 - impacts[values.C]) * (1 - impacts[values.I]) * (1 - impacts[values.A]);
  const impact = scopeChanged
    ? 7.52 * (impactBase - 0.029) - 3.25 * (impactBase - 0.02) ** 15
    : 6.42 * impactBase;
  const exploitability = 8.22 * weights.AV[values.AV] * weights.AC[values.AC] * weights.PR[values.PR] * weights.UI[values.UI];
  if (!Number.isFinite(impact) || !Number.isFinite(exploitability)) return undefined;
  if (impact <= 0) return "info";

  // CVSS 3.x qualitative scale uses the base score rounded up to one decimal place.
  const score = Math.ceil(Math.round(Math.min((impact + exploitability) * (scopeChanged ? 1.08 : 1), 10) * 1e5) / 1e4) / 10;
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "moderate" : "low";
}

function finding(id, name, level) {
  if (!validIdentity(id, name)) throw invalidReport();
  return { id, name, severity: severity(level) };
}

function npmAdvisoryId(entry) {
  if (typeof entry.url === "string") {
    const ghsa = entry.url.match(/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})(?:[/?#]|$)/i)?.[1];
    if (ghsa) return ghsa;
  }
  if (Number.isSafeInteger(entry.source) && entry.source > 0) return "npm:" + entry.source;
  throw invalidReport();
}

function npmFindings(report) {
  if (!record(report) || report.auditReportVersion !== 2 || !record(report.vulnerabilities)) throw invalidReport();
  const vulnerabilities = new Map(Object.entries(report.vulnerabilities));
  const findings = [];
  const reachable = new Set();
  const dependents = new Map();
  for (const [name, row] of vulnerabilities) {
    if (!packagePattern.test(name) || !record(row) || !Array.isArray(row.via) || row.via.length === 0) throw invalidReport();
    for (const entry of row.via) {
      if (typeof entry === "string") {
        if (!vulnerabilities.has(entry)) throw invalidReport();
        if (!dependents.has(entry)) dependents.set(entry, []);
        dependents.get(entry).push(name);
      } else {
        if (!record(entry)) throw invalidReport();
        findings.push(finding(npmAdvisoryId(entry), entry.dependency ?? entry.name ?? name, entry.severity ?? row.severity));
        reachable.add(name);
      }
    }
  }
  // npm's meta-vulnerabilities point to another row, rather than identifying
  // a new advisory. Resolve the graph from its advisory rows, even across cycles.
  for (const name of reachable) {
    for (const dependent of dependents.get(name) ?? []) reachable.add(dependent);
  }
  if (reachable.size !== vulnerabilities.size) throw invalidReport();
  return findings;
}

function cargoFindings(report) {
  const list = report?.vulnerabilities?.list;
  if (!Array.isArray(list) || report.vulnerabilities.count !== list.length ||
      report.vulnerabilities.found !== (list.length > 0) || !record(report.warnings)) throw invalidReport();
  const findings = list.map((row) =>
    finding(row?.advisory?.id, row?.package?.name, cvss3Severity(row?.advisory?.cvss)),
  );
  for (const [kind, warnings] of Object.entries(report.warnings)) {
    if (!Array.isArray(warnings)) throw invalidReport();
    for (const warning of warnings) {
      // A yank is a scanner finding but has no advisory ID in RustSec. Give it a
      // stable identifier for the same package-scoped exception mechanism.
      const id = warning?.advisory?.id ?? (kind === "yanked" ? "RUSTSEC-YANKED" : undefined);
      findings.push(finding(id, warning?.package?.name, warning?.advisory?.severity ?? "info"));
    }
  }
  return findings;
}

function osvFindings(report) {
  // OSV uses null as well as an empty array when no lockfile source had a match.
  if (!record(report) || (report.results !== null && !Array.isArray(report.results))) throw invalidReport();
  const findings = [];
  for (const source of report.results ?? []) {
    if (!Array.isArray(source?.packages)) throw invalidReport();
    for (const detected of source.packages) {
      if (!Array.isArray(detected?.vulnerabilities)) throw invalidReport();
      for (const advisory of detected.vulnerabilities) {
        findings.push(finding(advisory?.id, detected?.package?.name, advisory?.database_specific?.severity?.toLowerCase?.() ??
          cvss3Severity(Array.isArray(advisory?.severity)
            ? advisory.severity.find((rating) => rating?.type === "CVSS_V3")?.score
            : undefined)));
      }
    }
  }
  return findings;
}

function absent(output) {
  return output.error?.code === "ENOENT";
}

function auditOutput(output, parse, name) {
  if (output.error || ![0, 1].includes(output.status)) throw new AuditError(name + " could not complete");
  let report;
  try {
    report = JSON.parse(output.stdout);
  } catch {
    throw invalidReport();
  }
  const findings = parse(report);
  if (output.status === 1 && !findings.length) throw new AuditError(name + " failed without advisory findings");
  return findings;
}

function rustAudit(ctx) {
  const probe = ctx.command("cargo", ["audit", "--version"], ctx.rustDir);
  if (!probe.error && probe.status === 0) {
    return auditOutput(ctx.command("cargo", ["audit", "--file", "Cargo.lock", "--json"], ctx.rustDir), cargoFindings, "cargo-audit");
  }
  const cargoWithoutAudit = !probe.error && /no such command:\s*['`"]audit['`"]/i.test(probe.stderr ?? "");
  if (!absent(probe) && !cargoWithoutAudit) throw new AuditError("cargo-audit version probe failed");
  const osv = ctx.command("osv-scanner", ["--version"], ctx.rustDir);
  if (absent(osv)) return null;
  if (osv.error || osv.status !== 0) throw new AuditError("osv-scanner version probe failed");
  const major = osv.stdout.match(/osv-scanner version:\s*v?(\d+)\./i)?.[1];
  const mode = Number(major) >= 2 ? ["scan", "source"] : [];
  return auditOutput(ctx.command("osv-scanner", [...mode, "--lockfile=Cargo.lock", "--format", "json"], ctx.rustDir), osvFindings, "osv-scanner");
}

function jsAudit(ctx) {
  const invocation = npmAuditInvocation(ctx);
  return auditOutput(ctx.command(invocation.command, invocation.args, ctx.root), npmFindings, "npm audit");
}

function runAudit(ctx, only) {
  let allowed;
  try {
    allowed = readAllowlist(ctx);
  } catch (error) {
    if (!(error instanceof AuditError)) throw error;
    ctx.stderr("audit: failed (" + error.message + ")");
    return 1;
  }

  let code = 0;
  const tools = { npm: jsAudit, cargo: rustAudit };
  for (const name of only ? [only] : ["npm", "cargo"]) {
    const label = "audit " + name + ": ";
    try {
      const findings = tools[name](ctx);
      if (findings === null) {
        ctx.stdout("SKIPPED: no Rust advisory scanner (install cargo-audit or osv-scanner)\n" + label + "skipped");
        continue;
      }
      const unique = new Map(findings.map((hit) => [key(hit.id, hit.name), hit]));
      let denied = 0;
      for (const [identity, hit] of unique) {
        const permitted = allowed.has(identity);
        (permitted ? ctx.stdout : ctx.stderr)(
          "  " + hit.id + " " + hit.name + " severity=" + hit.severity + (permitted ? " (allowlisted)" : ""),
        );
        if (!permitted) denied++;
      }
      if (denied) {
        ctx.stderr(label + "failed (" + denied + " unallowlisted findings)");
        code = 1;
      } else {
        ctx.stdout(label + "ok (" + unique.size + " allowlisted findings)");
      }
    } catch (error) {
      if (!(error instanceof AuditError)) throw error;
      ctx.stderr(label + "failed (" + error.message + ")");
      code = 1;
    }
  }
  return code;
}

export function runToolchain(args, {
  root = repository,
  spawn = spawnSync,
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  isFile = validFile,
  today = new Date().toISOString().slice(0, 10),
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (args.length === 1 && args[0] === "--help") {
    stdout(usage);
    return 0;
  }
  const flags = flagSet(args);
  if (!flags) {
    stderr(usage);
    return 2;
  }
  const ctx = {
    root, rustDir: path.join(root, "src-tauri"), env, platform, execPath, isFile, today, stdout, stderr,
    command: (command, argv, cwd, childEnv = env) => spawn(command, argv, {
      cwd, env: childEnv, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }),
  };
  return flags.mode === "msrv" ? runMsrv(ctx, flags.strict) : runAudit(ctx, flags.only);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runToolchain(process.argv.slice(2));
}
