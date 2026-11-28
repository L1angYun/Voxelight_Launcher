// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { isolatedStylesheetCss } from "../../test/isolatedStylesheetCss";
import { ProjectCard } from "./ProjectCard";
import type { ResourceProject } from "../../lib/launcher";

const project: ResourceProject = { project_id: "project-fixture", slug: "project-fixture", title: "Fixture project",
  description: "A regular-weight description", icon_url: null, downloads: 1200,
  author: "Fixture author", project_type: "mod", versions: ["1.21.1"] };
let root: Root, container: HTMLDivElement, sheet: HTMLStyleElement;
const open = vi.fn(), install = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  open.mockReset(); install.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  sheet = document.createElement("style");
  // A concrete inherited weight makes the selected parent override observable in jsdom.
  sheet.textContent = ".vx-project-card { font-weight: 400; }\n" + isolatedStylesheetCss(
    readFileSync("src/features/discover/discover.css", "utf8"), ["features", "overrides"]);
  document.head.append(sheet);
});
afterEach(() => { act(() => root.unmount()); container.remove(); sheet.remove(); vi.unstubAllGlobals(); });

async function render(selected: boolean, value: ResourceProject = project, gameVersion?: string, targetLoader?: string | null) {
  const i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}><ProjectCard project={value} gameVersion={gameVersion} targetLoader={targetLoader}
    targetName="Fixture world" selected={selected} onOpen={open} onInstall={install} /></I18nextProvider>));
}

/** Declarations of the discover.css rules (also inside @media) whose selector list contains `selector`. */
function ruleDeclarations(selector: string) {
  const found: CSSStyleDeclaration[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ("selectorText" in rule && (rule as CSSStyleRule).selectorText.split(",").map(part => part.trim()).includes(selector)) found.push((rule as CSSStyleRule).style);
      else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  walk(sheet.sheet!.cssRules);
  expect(found, selector).toHaveLength(1);
  return found[0];
}

it("exposes current project on its focusable Details control and preserves its direct dotted frame", async () => {
  await render(true);
  const article = container.querySelector("article")!;
  const details = container.querySelector<HTMLButtonElement>(".vx-project-card__actions .vx-button--ghost")!;
  expect(article.hasAttribute("aria-current")).toBe(false);
  expect(details.getAttribute("aria-current")).toBe("true");
  expect(details.disabled).toBe(false); details.focus(); expect(document.activeElement).toBe(details);
  expect(article.querySelector(":scope > .vx-lattice-frame")?.getAttribute("data-selected")).toBe("true");
  await act(async () => details.click()); expect(open).toHaveBeenCalledOnce(); expect(install).not.toHaveBeenCalled();
  await render(false);
  expect(details.hasAttribute("aria-current")).toBe(false);
  expect(article.querySelector(":scope > .vx-lattice-frame")?.getAttribute("data-selected")).toBe("false");
});

it("does not add a selected background or inherited bold weight to the project card", async () => {
  await render(false);
  const card = container.querySelector<HTMLElement>("article")!;
  const original = { background: getComputedStyle(card).backgroundColor, weight: getComputedStyle(card).fontWeight };
  expect(original.background).not.toBe(""); expect(original.weight).toBe("400");
  await render(true);
  expect(getComputedStyle(card).backgroundColor).toBe(original.background);
  expect(getComputedStyle(card).fontWeight).toBe(original.weight);
});

it("opens the drawer from anywhere on the card through the stretched Details link", async () => {
  await render(false);
  const article = container.querySelector("article")!;
  const details = article.querySelector<HTMLButtonElement>(".vx-project-card__details")!;
  expect(details).not.toBeNull();
  // The Details button's ::after covers the whole card: the card is its containing block.
  const stretched = ruleDeclarations(".vx-project-card__details::after");
  expect(stretched.getPropertyValue("content")).toBe('""');
  expect(stretched.getPropertyValue("position")).toBe("absolute");
  expect(stretched.getPropertyValue("inset")).toMatch(/^0(px)?$/);
  expect(getComputedStyle(article).position).toBe("relative");
  expect(getComputedStyle(details).position).not.toBe("relative");
  const body = article.querySelector<HTMLElement>(".vx-project-card__body")!;
  await act(async () => body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(open).toHaveBeenCalledOnce();
  expect(install).not.toHaveBeenCalled();
});

it("keeps the install action separate from the full-card details link", async () => {
  await render(false);
  const article = container.querySelector("article")!;
  const installButton = article.querySelector<HTMLButtonElement>(".vx-project-card__actions button:first-child")!;
  // Install is raised above the stretched ::after so it keeps its own clicks.
  expect(getComputedStyle(installButton).position).toBe("relative");
  expect(getComputedStyle(installButton).zIndex).toBe("1");
  // A pressed Details button must not transform: a transform would shrink the
  // ::after's containing block to the button while the pointer is down.
  expect(sheet.textContent).toMatch(/\.vx-project-card__details\.vx-button:active\s*\{\s*transform:\s*none;\s*\}/);
  await act(async () => installButton.click());
  expect(install).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});

it("shows a compatibility badge for the target version instead of every snapshot version", async () => {
  await render(false, { ...project, versions: ["1.21.1", "1.20.6", "1.20.1", "1.19.4"] }, "1.21.1");
  const card = container.querySelector<HTMLElement>("article")!;
  const badge = card.querySelector<HTMLElement>(".vx-project-card__compatibility")!;
  expect(badge.dataset.compatible).toBe("true");
  expect(badge.textContent).toBe("Works with 1.21.1");
  expect(card.querySelector(".vx-project-card__versions")).toBeNull();
  expect(card.textContent).not.toContain("1.20.6");
  expect(card.querySelector(".vx-project-card__downloads .lucide-arrow-down-to-line")).not.toBeNull();
  expect(card.querySelector(".vx-project-card__details .lucide-panel-right")).not.toBeNull();
});

it("states when the project has no version for the target", async () => {
  await render(false, { ...project, versions: ["1.20.6"] }, "1.21.1");
  const badge = container.querySelector<HTMLElement>(".vx-project-card__compatibility")!;
  expect(badge.dataset.compatible).toBe("false");
  expect(badge.textContent).toBe("No 1.21.1 version");
  expect(badge.querySelector("svg")).toBeNull();
});

it("keeps a Package tile behind a loading project icon, with the edge ring drawn above the icon", async () => {
  await render(false, { ...project, icon_url: "data:image/png;base64,fixture" });
  const art = container.querySelector<HTMLElement>(".vx-project-card__art")!;
  const img = art.querySelector("img")!;
  expect(art.querySelector("svg.lucide-package")).not.toBeNull();
  expect(img.getAttribute("src")).toBe("data:image/png;base64,fixture");
  expect(getComputedStyle(art).position).toBe("relative");
  expect(getComputedStyle(img).position).toBe("absolute");
  // The image covers the tile, so an inset ring on the tile itself would be hidden under it.
  expect(["", "none"]).toContain(getComputedStyle(art).boxShadow);
  for (const selector of [".vx-project-card__art::after", ".vx-project-details__art::after"]) {
    const ring = ruleDeclarations(selector);
    expect(ring.getPropertyValue("position")).toBe("absolute");
    expect(ring.getPropertyValue("inset")).toMatch(/^0(px)?$/);
    expect(ring.getPropertyValue("box-shadow")).toBe("inset 0 0 0 1px var(--border-subtle)");
    expect(ring.getPropertyValue("pointer-events")).toBe("none");
  }
});

it("hides the Package glyph once the icon has loaded and shows it again for a new or failed icon", async () => {
  await render(false, { ...project, icon_url: "https://cdn.example/sodium.png" });
  const art = container.querySelector<HTMLElement>(".vx-project-card__art")!;
  const glyph = art.querySelector<SVGElement>("svg.lucide-package")!;
  expect(art.hasAttribute("data-loaded")).toBe(false);
  expect(getComputedStyle(glyph).visibility).not.toBe("hidden");
  await act(async () => art.querySelector("img")!.dispatchEvent(new Event("load")));
  // A transparent icon must not show the glyph through it.
  expect(art.dataset.loaded).toBe("true");
  expect(getComputedStyle(glyph).visibility).toBe("hidden");

  await render(false, { ...project, icon_url: "https://cdn.example/lithium.png" });
  expect(art.hasAttribute("data-loaded")).toBe(false);
  expect(getComputedStyle(glyph).visibility).not.toBe("hidden");
  const next = art.querySelector("img")!;
  expect(next.getAttribute("src")).toBe("https://cdn.example/lithium.png");
  await act(async () => next.dispatchEvent(new Event("error")));
  expect(next.hidden).toBe(true);
  expect(art.hasAttribute("data-loaded")).toBe(false);
  expect(getComputedStyle(glyph).visibility).not.toBe("hidden");
});

it("leaves the hover fill to the card instead of a second pill on the stretched Details button", async () => {
  await render(false);
  const hover = ruleDeclarations(".vx-project-card__details.vx-button--ghost:hover");
  expect(hover.getPropertyValue("background")).toBe("transparent");
  expect(ruleDeclarations(".vx-project-card:not(.is-selected):hover").getPropertyValue("background")).toBe("var(--fill-hover)");
});

it("does not promise a fit for a mod on a target that cannot load mods", async () => {
  for (const loader of [null, "vanilla"]) {
    await render(false, project, "1.21.1", loader);
    const badge = container.querySelector<HTMLElement>(".vx-project-card__compatibility")!;
    expect(badge.dataset.compatible).toBe("false");
    expect(badge.textContent).toBe("Vanilla cannot load mods");
    expect(badge.querySelector("svg")).toBeNull();
  }
  // Resource packs fit a vanilla target by game version alone; a mod loader target keeps the check.
  await render(false, { ...project, project_type: "resourcepack" }, "1.21.1", null);
  expect(container.querySelector(".vx-project-card__compatibility")?.textContent).toBe("Works with 1.21.1");
  await render(false, project, "1.21.1", "fabric");
  const badge = container.querySelector<HTMLElement>(".vx-project-card__compatibility")!;
  expect(badge.dataset.compatible).toBe("true");
  expect(badge.querySelector(".lucide-circle-check")).not.toBeNull();
});
