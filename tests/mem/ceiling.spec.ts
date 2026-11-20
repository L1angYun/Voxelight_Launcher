import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installLauncherFixture } from "../e2e/fixtures";

const SAMPLER = process.env.VX_SAMPLER ?? fileURLToPath(new URL("./sample.ps1", import.meta.url));
const OUT = process.env.VX_OUT ?? process.env.TEMP ?? ".";
function browserPid(): number {
  return Number(execFileSync("powershell", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--vx-mem-marker*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId"], { encoding: "utf8" }).trim());
}
function sample(label: string, samples = 4) {
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SAMPLER, "-RootPid", String(browserPid()),
    "-Label", label, "-Out", `${OUT}\${label}.json`, "-Samples", String(samples), "-IntervalSec", "8"], { encoding: "utf8" });
  console.log(`== ${label}\n${out.split(/\r?\n/).filter(line => /^sample/.test(line)).join("\n")}`);
}
const lose = (page: import("@playwright/test").Page, selector: string) => page.evaluate(sel => {
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>(sel)) {
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.width = 1; canvas.height = 1;
  }
}, selector);

test("lite ceiling", async ({ page }) => {
  await installLauncherFixture(page, { effects: "lite", instanceCount: 2 });
  await page.goto("/?next-ui");
  await page.waitForTimeout(15_000);
  sample("ceil-lite");
  await lose(page, ".vx-character-canvas__mount canvas, canvas.vx-character-canvas__mount");
  await page.waitForTimeout(10_000);
  sample("ceil-lite-nochar");
  await lose(page, ".world-scene__canvas");
  await page.waitForTimeout(10_000);
  sample("ceil-lite-nochar-noworld");
  await page.goto("about:blank");
  await page.waitForTimeout(15_000);
  sample("ceil-blank", 3);
});
