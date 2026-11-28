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

async function renderDialog(children: React.ReactNode, footer?: React.ReactNode) {
  const i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}>
    <Dialog open onOpenChange={() => {}} title="Keyboard shortcuts" footer={footer}>{children}</Dialog>
  </I18nextProvider>));
  return container.querySelector<HTMLDialogElement>("dialog")!;
}

it("starts a dialog without input controls on its close button, never on a body action", async () => {
  const action = vi.fn();
  const dialog = await renderDialog(<p>Ctrl + 1 opens Play.</p>,
    <button id="show-tour" onClick={action}>Show the welcome setup</button>);
  expect(document.activeElement).toBe(dialog.querySelector("[data-dialog-close]"));
  expect(document.activeElement).not.toBe(dialog.querySelector("#show-tour"));
  expect(dialog.querySelector(".vx-dialog__header h2")?.getAttribute("tabindex")).toBe("-1");
  expect(action).not.toHaveBeenCalled();
});

it("lets an explicit autofocus win over the close button and over a field", async () => {
  let dialog = await renderDialog(<p>Remove it?</p>, <>
    <button id="cancel" data-dialog-autofocus="true">Cancel</button><button id="accept">Remove</button>
  </>);
  expect(document.activeElement).toBe(dialog.querySelector("#cancel"));
  await act(async () => root.render(<></>));
  dialog = await renderDialog(<><input id="name" aria-label="Name" /><textarea id="notes" aria-label="Notes" data-dialog-autofocus="" /></>);
  expect(document.activeElement).toBe(dialog.querySelector("#notes"));
});

it("still starts on the first input control ahead of body buttons", async () => {
  const dialog = await renderDialog(<><button id="browse">Browse</button><input id="path" aria-label="Path" /></>);
  expect(document.activeElement).toBe(dialog.querySelector("#path"));
});

async function renderDescribed(description: string) {
  const i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}>
    <Dialog open onOpenChange={() => {}} title="Change loader" description={description} />
  </I18nextProvider>));
  const dialog = container.querySelector<HTMLDialogElement>("dialog")!;
  return { dialog, paragraphs: [...dialog.querySelectorAll<HTMLParagraphElement>(".vx-dialog__header p")] };
}

it("shows a description with blank lines as separate paragraphs that all describe the dialog", async () => {
  const { dialog, paragraphs } = await renderDescribed("Backup failed.\r\n\r\nChange the loader anyway?\n \n\nWorlds can lose modded blocks.");
  expect(paragraphs.map(paragraph => paragraph.textContent)).toEqual(["Backup failed.", "Change the loader anyway?", "Worlds can lose modded blocks."]);
  expect(dialog.getAttribute("aria-describedby")!.split(" ")).toEqual(paragraphs.map(paragraph => paragraph.id));
  expect(new Set(paragraphs.map(paragraph => paragraph.id)).size).toBe(3);
});

it("keeps a one-paragraph description as a single described paragraph", async () => {
  const { dialog, paragraphs } = await renderDescribed("Remove this server from the list?");
  expect(paragraphs.map(paragraph => paragraph.textContent)).toEqual(["Remove this server from the list?"]);
  expect(dialog.getAttribute("aria-describedby")).toBe(paragraphs[0].id);
  await act(async () => root.render(<></>));
  const empty = await renderDescribed("");
  expect(empty.paragraphs).toEqual([]);
  expect(empty.dialog.hasAttribute("aria-describedby")).toBe(false);
});
