// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { ToastProvider, useToast } from "./ToastProvider";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({ effects: "lite", reducedMotion: true }) }));
let root: Root, node: HTMLDivElement;
function Harness() {
  const { notify } = useToast();
  const [first, setFirst] = useState(false), [second, setSecond] = useState(false);
  return <><button id="notify" onClick={() => notify({ message: "Download failed", kind: "error" })}>notify</button>
    <button id="replace" onClick={() => notify({ message: "Recovered" })}>replace</button>
    <button id="first" onClick={() => setFirst(true)}>first</button><button id="second" onClick={() => setSecond(true)}>second</button>
    <Dialog open={first} onOpenChange={setFirst} title="First"><button id="selected-tab" role="tab" tabIndex={0}>selected</button>
      <button id="other-tab" role="tab" tabIndex={-1}>other</button><button id="close-first" onClick={() => setFirst(false)}>close</button></Dialog>
    <Dialog open={second} onOpenChange={setSecond} title="Second"><button id="close-second" onClick={() => setSecond(false)}>close</button></Dialog></>;
}
async function click(selector: string) { await act(async () => { node.querySelector<HTMLButtonElement>(selector)!.click(); }); }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => { root.render(<ToastProvider><Harness /></ToastProvider>); });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
it("keeps one notification above the most recently opened dialog and rehosts it after closing", async () => {
  await click("#notify");
  expect(document.querySelectorAll(".vx-toast")).toHaveLength(1);
  await click("#first"); await click("#second");
  const dialogs = node.querySelectorAll("dialog");
  expect(dialogs[1].querySelector('[role="alert"]')?.textContent).toContain("Download failed");
  expect(dialogs[0].querySelector(".vx-toast")).toBeNull();
  await click("#close-second");
  expect(dialogs[0].querySelector(".vx-toast")?.textContent).toContain("Download failed");
  await click("#close-first");
  expect(document.querySelector(".vx-toast")?.closest("dialog")).toBeNull();
  expect(document.querySelectorAll(".vx-toast")).toHaveLength(1);
});
it("replaces a notification and lets the visible close action dismiss it", async () => {
  await click("#notify"); await click("#replace");
  expect(document.querySelectorAll(".vx-toast")).toHaveLength(1);
  expect(document.querySelector(".vx-toast")?.textContent).toContain("Recovered");
  await act(async () => document.querySelector<HTMLButtonElement>(".vx-toast button")!.click());
  expect(document.querySelector(".vx-toast")).toBeNull();
});
it("keeps inactive roving tabs out of the dialog Tab path", async () => {
  await click("#first");
  const tab = node.querySelector<HTMLButtonElement>("#selected-tab")!;
  tab.focus();
  await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(node.querySelector("#close-first"));
});
it("ignores a queued close event for a dialog that has already reopened", async () => {
  await click("#first"); await click("#notify");
  const dialog = node.querySelector<HTMLDialogElement>("dialog[open]")!;
  await act(async () => dialog.dispatchEvent(new Event("close")));
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector(".vx-toast")?.textContent).toContain("Download failed");
});
