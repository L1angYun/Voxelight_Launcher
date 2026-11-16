// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createLauncherI18n } from "../../i18n";
import { ExternalLink } from "./ExternalLink";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (clipboardBefore) Object.defineProperty(navigator, "clipboard", clipboardBefore);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.resetAllMocks();
});

it("keeps a keyboard-selectable address when the desktop opener and clipboard deny access", async () => {
  const destination = "https://modrinth.com/mod/example";
  vi.mocked(openUrl).mockRejectedValue(new Error("Synthetic opener refusal"));
  const writeText = vi.fn(async () => { throw new Error("Synthetic clipboard refusal"); });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(ExternalLink, { url: destination, variant: "ghost", children: "Open project page" }))));

  const open = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { open.focus(); open.click(); });
  expect(openUrl).toHaveBeenCalledWith(destination);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/could not open/i);
  expect(document.activeElement).toBe(open);
  expect(container.textContent).not.toContain("Synthetic opener refusal");
  const copy = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Copy link")!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith(destination);
  expect(container.querySelector('[role="status"]')?.textContent).not.toBe("Link copied.");
  expect(container.querySelector('[role="status"]')?.textContent).toMatch(/select|clipboard/i);

  const address = container.querySelector<HTMLInputElement>('input[aria-label="Link address"]');
  expect(address?.value).toBe(destination);
  expect(address?.readOnly).toBe(true);
  await act(async () => address?.focus());
  expect(document.activeElement).toBe(address);
  expect(address?.selectionStart).toBe(0);
  expect(address?.selectionEnd).toBe(destination.length);
});

it("uses the permitted canonical origin for a CurseForge Minecraft project URL from the API", async () => {
  const returned = "https://curseforge.com/minecraft/mc-mods/fixture-project";
  const canonical = "https://www.curseforge.com/minecraft/mc-mods/fixture-project";
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(ExternalLink, { url: returned, children: "Open project page" }))));

  const link = container.querySelector<HTMLAnchorElement>("a")!;
  await act(async () => link.click());
  expect(openUrl).toHaveBeenCalledWith(canonical);
  expect(link.getAttribute("href")).toBe(canonical);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
