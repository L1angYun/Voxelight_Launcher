// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { Dialog } from "./Dialog";
import { Segmented } from "./Segmented";

vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({ effects: "lite", reducedMotion: true }) }));
let root: Root, container: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

it("tabs out of an arrow-focused manual tab in DOM order and returns to the selected tab", async () => {
  const change = vi.fn(), i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}>
    <Dialog open onOpenChange={() => {}} title="Sign in">
      <Segmented semantic="tabs" activation="manual" label="Method" value="first" onChange={change}
        options={[{ value: "first", label: "First" }, { value: "last", label: "Last" }]} />
      <button id="panel-action">Panel action</button>
    </Dialog>
  </I18nextProvider>));
  const [first, last] = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panel = container.querySelector<HTMLButtonElement>("#panel-action")!;
  await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(last);
  expect(first.tabIndex).toBe(0); expect(last.tabIndex).toBe(-1);
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(panel);
  await act(async () => panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(first);
  expect(change).not.toHaveBeenCalled();
});
