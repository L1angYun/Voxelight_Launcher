// @vitest-environment jsdom
import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { notifyDialogLayer, ToastProvider, useToast } from "./ToastProvider";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const appearance = vi.hoisted(() => ({ effects: "lite", reducedMotion: true }));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => appearance }));
let root: Root, node: HTMLDivElement;
const launcherDismissed = vi.fn();
function Harness() {
  const { notify, dismiss } = useToast();
  const [first, setFirst] = useState(false), [second, setSecond] = useState(false);
  return <><button id="notify" onClick={() => notify({ message: "Download failed", kind: "error" })}>notify</button>
    <button id="replace" onClick={() => notify({ message: "Recovered" })}>replace</button>
    <button id="launcher" onClick={() => notify({ id: "launcher", message: "Preparing launch", onDismiss: launcherDismissed })}>launcher</button>
    <button id="launcher-replace" onClick={() => notify({ id: "launcher", message: "Launch failed", kind: "error", onDismiss: launcherDismissed })}>launcher replace</button>
    <button id="launcher-dismiss" onClick={() => dismiss("launcher")}>launcher dismiss</button>
    <button id="first" onClick={() => setFirst(true)}>first</button><button id="second" onClick={() => setSecond(true)}>second</button>
    <Dialog open={first} onOpenChange={setFirst} title="First"><button id="other-tab" role="tab" tabIndex={-1}>other</button>
      <button id="selected-tab" role="tab" tabIndex={0}>selected</button><button id="close-first" onClick={() => setFirst(false)}>close</button></Dialog>
    <Dialog open={second} onOpenChange={setSecond} title="Second"><button id="close-second" onClick={() => setSecond(false)}>close</button></Dialog></>;
}
async function click(selector: string) { await act(async () => { node.querySelector<HTMLButtonElement>(selector)!.click(); }); }
beforeEach(async () => {
  launcherDismissed.mockClear();
  appearance.effects = "lite"; appearance.reducedMotion = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => { root.render(<ToastProvider><Harness /></ToastProvider>); });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
it("mounts a fresh notification when its message changes under the launcher's logical id", async () => {
  await click("#launcher");
  const previous = document.querySelector(".vx-toast");
  await click("#launcher-replace");
  const replacement = document.querySelector(".vx-toast");
  expect(replacement).not.toBe(previous);
  expect(replacement?.textContent).toContain("Launch failed");
  expect(launcherDismissed).not.toHaveBeenCalled();
  await click("#launcher-dismiss");
  expect(document.querySelector(".vx-toast")).toBeNull();
  expect(launcherDismissed).toHaveBeenCalledTimes(1);
});
it("retires the outgoing notification's announcement and close action during replacement", async () => {
  await click("#launcher");
  const previous = document.querySelector<HTMLElement>(".vx-toast")!;
  const previousClose = previous.querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    flushSync(() => node.querySelector<HTMLButtonElement>("#launcher-replace")!.click());
    expect(previous.getAttribute("aria-hidden")).toBe("true");
    expect(previous.hasAttribute("inert")).toBe(true);
    expect(previous.getAttribute("role")).toBeNull();
    expect(previousClose.disabled).toBe(true);
    previousClose.click();
  });
  expect(document.querySelector(".vx-toast")?.textContent).toContain("Launch failed");
  expect(launcherDismissed).not.toHaveBeenCalled();
});
it("starts a fresh entrance when an existing notification moves into a dialog", async () => {
  appearance.effects = "full"; appearance.reducedMotion = false;
  await click("#notify");
  const dialog = node.querySelector<HTMLDialogElement>("dialog")!;
  dialog.setAttribute("open", "");
  node.querySelector<HTMLButtonElement>("#selected-tab")!.focus();
  await act(async () => {
    flushSync(() => notifyDialogLayer(dialog, true));
    const notification = dialog.querySelector<HTMLElement>(".vx-toast")!;
    expect(notification.style.opacity).toBe("0");
  });
  expect(document.querySelectorAll(".vx-toast")).toHaveLength(1);
  expect(document.activeElement).toBe(node.querySelector("#selected-tab"));
});
it("keeps a notification's remaining lifetime when it is rehosted above a dialog", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await click("#launcher");
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  await click("#first");
  await act(async () => vi.advanceTimersByTimeAsync(999));
  expect(document.querySelector("dialog[open] .vx-toast")?.textContent).toContain("Preparing launch");
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(document.querySelector(".vx-toast")).toBeNull();
  expect(node.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
  expect(launcherDismissed).toHaveBeenCalledTimes(1);
});
it("gives a replacement error its full lifetime even when it reuses the launcher's id", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await click("#launcher");
  await act(async () => vi.advanceTimersByTimeAsync(4900));
  await click("#launcher-replace");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(document.querySelector(".vx-toast")?.textContent).toContain("Launch failed");
  await act(async () => vi.advanceTimersByTimeAsync(10899));
  expect(document.querySelector(".vx-toast")?.textContent).toContain("Launch failed");
  expect(launcherDismissed).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(document.querySelector(".vx-toast")).toBeNull();
  expect(launcherDismissed).toHaveBeenCalledTimes(1);
});
it("keeps inactive roving tabs out of the dialog Tab path", async () => {
  await click("#first");
  const tab = node.querySelector<HTMLButtonElement>("#selected-tab")!;
  expect(document.activeElement).toBe(tab);
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
it("names notification dismissal separately and leaves its hosting dialog open", async () => {
  await click("#first"); await click("#notify");
  const dialog = node.querySelector<HTMLDialogElement>("dialog[open]")!;
  const dismiss = dialog.querySelector<HTMLButtonElement>(".vx-toast button")!;
  expect(dismiss.getAttribute("aria-label")).toBe("common:a11y.dismissNotification");
  await act(async () => dismiss.click());
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector(".vx-toast")).toBeNull();
});
