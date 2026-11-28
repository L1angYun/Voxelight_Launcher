// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { parse, type Rule } from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import type { Instance, Progress } from "../../lib/launcher";
import { LaunchConsole } from "./LaunchConsole";
import { RecentInstances } from "./RecentInstances";

vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({
  effects: "full", reducedMotion: false, reducedTransparency: false, highContrast: false,
}) }));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ className, children }: { className?: string; children?: ReactNode }) => <div className={className}>{children}</div>,
}));
vi.mock("./InstancePicker", () => ({ InstancePicker: () => <button type="button">Instance picker</button> }));

const homeSheet = parse(readFileSync("src/features/home/home.css", "utf8"));

/** Every declaration of rules whose selector list contains exactly `selector`. */
function declarations(selector: string) {
  const found: Record<string, string> = {};
  homeSheet.walkRules((rule: Rule) => {
    if (!rule.selectors.some((item) => item.trim() === selector)) return;
    rule.walkDecls((declaration) => { found[declaration.prop] = declaration.value; });
  });
  return found;
}

function progress(completed: number, total: number): Progress {
  return { taskId: "launch-fixture", operation: "launch", versionId: "1.21.1", stage: "assets",
    completed, total, bytesCompleted: 0, bytesTotal: 0, message: "" };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderConsole(locale: "zh-CN" | "en-US" | "ru-RU", props: { busy?: string; preparing?: boolean; running?: boolean; progress?: Progress | null }) {
  const i18n = createLauncherI18n(locale, locale);
  await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}>
    <LaunchConsole instances={[]} pickerOpen={false} onPickerOpenChange={() => {}} onSelectInstance={() => {}}
      onLaunch={async () => {}} onStop={async () => {}} onCancel={async () => {}} onOpenFolder={() => {}}
      busy={props.busy ?? ""} preparing={props.preparing ?? false} running={props.running ?? false} progress={props.progress ?? null} />
  </I18nextProvider>));
}

describe("launch console progress figure", () => {
  it.each(["zh-CN", "en-US", "ru-RU"] as const)("keeps Doto for the %s percent figure and drops it for the unknown-total word", async (locale) => {
    await renderConsole(locale, { preparing: true, progress: progress(37, 100) });
    const figure = () => container.querySelector<HTMLElement>(".vx-launch-console__progress-text")!;
    expect(figure().textContent).toMatch(/37/);
    expect(figure().dataset.matrix).toBe("true");

    await renderConsole(locale, { preparing: true, progress: progress(5, 0) });
    expect(figure().textContent).not.toMatch(/\d/);
    expect(figure().dataset.matrix).toBe("false");
  });

  it("styles the word fallback in the UI face and keeps the matrix face for figures", () => {
    expect(declarations(".vx-launch-console__progress-text").font).toBe("var(--type-matrix)");
    const fallback = declarations('.vx-launch-console__progress-text[data-matrix="false"]');
    expect(fallback.font).toBe("var(--type-body-strong)");
  });
});

describe("blocked launch action", () => {
  it("marks the idle launch as blocked only while another operation is busy", async () => {
    const wrap = () => container.querySelector<HTMLElement>(".vx-launch-console__launch-wrap")!;
    await renderConsole("zh-CN", {});
    expect(wrap().hasAttribute("data-blocked")).toBe(false);

    await renderConsole("zh-CN", { busy: "folder.open" });
    expect(wrap().dataset.blocked).toBe("true");
    expect(container.querySelector("[data-launch-primary]")?.getAttribute("aria-disabled")).toBe("true");
    // The 56px block stays in place; the solid surface is the same element.
    expect(wrap().querySelector(".vx-launch-console__launch")).not.toBeNull();

    // Preparation and running keep the accent surface even while busy.
    await renderConsole("zh-CN", { busy: "game.stop", running: true });
    expect(wrap().hasAttribute("data-blocked")).toBe(false);
    await renderConsole("zh-CN", { busy: "folder.open", preparing: true, progress: progress(1, 10) });
    expect(wrap().hasAttribute("data-blocked")).toBe(false);
  });

  it("moves a blocked launch to a neutral fill with a readable, undimmed label", () => {
    const surface = declarations('.vx-launch-console__launch-wrap[data-blocked="true"] > .vx-launch-console__launch');
    expect(surface.background).toBe("var(--fill-selected)");
    expect(surface["box-shadow"]).toContain("var(--border-subtle)");
    const label = declarations('.vx-launch-console__launch-wrap[data-blocked="true"] .vx-button');
    expect(label.color).toBe("var(--text-secondary)");
    expect(label.opacity).toBeUndefined();
    // The short cancel guard still only changes the pointer on the accent fill.
    expect(declarations('.vx-launch-console__launch-wrap .vx-button:is(:disabled,[aria-disabled="true"])').opacity).toBe("1");
  });
});

describe("home identity during the world entrance", () => {
  const introSelector = '[data-world-intro="on"] .vx-app-body:not(:has(> .vx-app-background[data-visible="true"])) .vx-home__identity:not([data-picker-open="true"])';

  it("fades the identity in 600ms into the entrance unless the picker hides it", () => {
    const intro = declarations(introSelector);
    expect(intro.animation).toBe("vx-home-identity-arrive var(--duration-slow) var(--ease-out) 600ms both");
    let keyframes = "";
    homeSheet.walkAtRules("keyframes", (rule) => { if (rule.params === "vx-home-identity-arrive") keyframes = rule.toString(); });
    expect(keyframes).toMatch(/from\s*\{\s*opacity:\s*0;?\s*\}/);
    expect(keyframes).toMatch(/to\s*\{\s*opacity:\s*1;?\s*\}/);
  });

  it("leaves the identity shown at once over a custom photo, where no animation may start it at opacity 0", () => {
    // Every home.css rule that animates the identity during the entrance.
    const animated: string[] = [];
    homeSheet.walkRules((rule: Rule) => {
      if (!rule.nodes.some((node) => node.type === "decl" && node.prop === "animation")) return;
      animated.push(...rule.selectors.filter((selector) => selector.includes(".vx-home__identity")));
    });
    expect(animated).toContain(introSelector);

    document.documentElement.dataset.worldIntro = "on";
    container.innerHTML = '<div class="vx-app-body"><div class="vx-app-background" data-visible="true"></div>'
      + '<main><section class="vx-home"><div class="vx-home__identity"></div></section></main></div>';
    try {
      const identity = container.querySelector(".vx-home__identity")!;
      for (const selector of animated) expect(identity.matches(selector), `${selector} over a photo`).toBe(false);
      container.querySelector(".vx-app-background")!.setAttribute("data-visible", "false");
      expect(animated.some((selector) => identity.matches(selector)), "the world entrance without a photo").toBe(true);
    } finally {
      delete document.documentElement.dataset.worldIntro;
    }
  });

  it("draws the character floor from the selected-state fill rather than an ad hoc mix", () => {
    const floor = declarations(".vx-home__character-floor");
    expect(floor.background).toBe("radial-gradient(ellipse, var(--fill-selected), transparent 70%)");
    // R10 allows color-mix in the features layer only for the vignette scrim.
    homeSheet.walkDecls((declaration) => {
      if (!declaration.value.includes("color-mix(")) return;
      const selector = (declaration.parent as Rule).selector;
      expect(selector, `color-mix in ${selector}`).toBe(".vx-home::before");
    });
  });

  // The instance title and metadata rules belong to the instance-model change,
  // which restyles them; their two size aliases move with it.
  it("uses only current tokens in the home stylesheet outside the instance identity rules", () => {
    const css = readFileSync("src/features/home/home.css", "utf8");
    for (const alias of ["--bg-base", "--bg-raised", "--hairline", "--surface-hover", "--text-sm", "--text-md", "--text-xl"])
      expect(css, alias).not.toContain(`var(${alias}`);
  });
});

describe("recent instances", () => {
  it("draws the instance cube at the xl icon size without a custom stroke", async () => {
    const i18n = createLauncherI18n("zh-CN", "zh-CN");
    await i18n.initPromise;
    const base = { versionId: "1.21.1", gameDirectory: "C:\\Fixture", createdAt: "2026-10-25T08:00:00Z", category: "", iconPath: null,
      notes: "", maxMemoryMb: null, javaPath: null, jvmArguments: null, screenWidth: null, screenHeight: null, totalPlayTime: 0,
      loader: "vanilla", loaderVersion: "" } as unknown as Omit<Instance, "id" | "name">;
    const instances = [{ ...base, id: "a", name: "A" }, { ...base, id: "b", name: "B" }] as Instance[];
    await act(async () => root.render(<I18nextProvider i18n={i18n}>
      <RecentInstances instances={instances} selectedId="a" onSelect={() => {}} />
    </I18nextProvider>));
    const icon = container.querySelector(".vx-recent-card__icon")!;
    expect(icon.getAttribute("width")).toBe("24");
    expect(icon.getAttribute("stroke-width")).toBe("2");
  });
});
