// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { isolatedStylesheetCss } from "../../test/isolatedStylesheetCss";
import { ProjectCard } from "./ProjectCard";

const project = { project_id: "project-fixture", slug: "project-fixture", title: "Fixture project",
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

async function render(selected: boolean) {
  const i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}><ProjectCard project={project}
    targetName="Fixture world" selected={selected} onOpen={open} onInstall={install} /></I18nextProvider>));
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
