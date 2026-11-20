import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installLauncherFixture } from "../e2e/fixtures";

const SAMPLER = process.env.VX_SAMPLER ?? fileURLToPath(new URL("./sample.ps1", import.meta.url));
const OUT = process.env.VX_OUT ?? process.env.TEMP ?? ".";
function browserPid(): number {
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--vx-mem-marker*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId"], { encoding: "utf8" });
  return Number(out.trim());
}
function sample(label: string, samples = 4) {
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SAMPLER, "-RootPid", String(browserPid()),
    "-Label", label, "-Out", `${OUT}\${label}.json`, "-Samples", String(samples), "-IntervalSec", "8"], { encoding: "utf8" });
  const lines = out.split(/\r?\n/).filter(line => /^sample|gpu-process|renderer /.test(line));
  console.log(`== ${label}\n${lines.join("\n")}`);
}
const canvases = (page: import("@playwright/test").Page) => page.evaluate(() =>
  [...document.querySelectorAll("canvas")].map(c => `${String(c.className || c.parentElement?.className).slice(0, 32)} ${c.width}x${c.height}`));

for (const effects of ["full", "lite"] as const) {
  test(`memory ${effects}`, async ({ page }) => {
    await installLauncherFixture(page, { effects, instanceCount: 2 });
    await page.goto("/?next-ui");
    await page.waitForTimeout(15_000);
    console.log(effects, JSON.stringify(await canvases(page)));
    sample(`${process.env.VX_TAG}-${effects}`);
    await page.goto("about:blank");
    await page.waitForTimeout(15_000);
    sample(`${process.env.VX_TAG}-${effects}-blank`, 3);
  });
}
