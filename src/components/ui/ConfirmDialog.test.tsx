// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { ConfirmProvider, useConfirm, type ConfirmDetails, type ConfirmFn } from "./ConfirmDialog";

let root: Root, container: HTMLDivElement;
let confirmFn: ConfirmFn;
const destroy = vi.fn();
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

function Destroyer({ details }: { details?: ConfirmDetails }) {
  const confirm = useConfirm();
  confirmFn = confirm;
  return <button id="destroy" onClick={() => void (async () => {
    if (await confirm("Delete everything in this folder?", details)) destroy();
  })()}>Delete</button>;
}

async function render(node: React.ReactNode, language = "en-US") {
  const i18n = createLauncherI18n(language, language);
  await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>));
}

const dialog = () => container.querySelector<HTMLDialogElement>("dialog.vx-confirm-dialog")!;
const cancelButton = () => dialog().querySelector<HTMLButtonElement>("[data-confirm-cancel]")!;
const acceptButton = () => dialog().querySelector<HTMLButtonElement>("[data-confirm-accept]")!;
async function click(element: HTMLElement) { await act(async () => element.click()); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  destroy.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("ConfirmDialog", () => {
  it("waits for the user, focuses Cancel first and runs nothing when cancelled", async () => {
    await render(<ConfirmProvider><Destroyer details={{ tone: "danger" }} /></ConfirmProvider>);
    expect(dialog().open).toBe(false);
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog().textContent).toContain("Confirm action");
    expect(dialog().textContent).toContain("Delete everything in this folder?");
    expect(document.activeElement).toBe(cancelButton());
    expect(destroy).not.toHaveBeenCalled();
    await click(cancelButton());
    expect(dialog().open).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("runs the action only after the confirm button", async () => {
    await render(<ConfirmProvider><Destroyer details={{ tone: "danger" }} /></ConfirmProvider>);
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    expect(destroy).not.toHaveBeenCalled();
    await click(acceptButton());
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);
  });

  it.each([
    ["Escape", async () => act(async () => {
      dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    })],
    ["the close button", async () => click(dialog().querySelector<HTMLButtonElement>("[data-dialog-close]")!)],
    ["the native cancel event", async () => act(async () => { dialog().dispatchEvent(new Event("cancel", { cancelable: true })); })],
  ])("declines when the dialog is dismissed with %s", async (_label, dismiss) => {
    await render(<ConfirmProvider><Destroyer /></ConfirmProvider>);
    let resolved: boolean | undefined;
    let pending!: Promise<void>;
    await act(async () => { pending = confirmFn("Remove it?").then(value => { resolved = value; }); });
    expect(dialog().open).toBe(true);
    await dismiss();
    await pending;
    expect(resolved).toBe(false);
    expect(dialog().open).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("paints a destructive confirmation with the danger fill and keeps a plain one on the accent", async () => {
    await render(<ConfirmProvider><Destroyer details={{ tone: "danger" }} /></ConfirmProvider>);
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    expect(acceptButton().className).toContain("vx-button--primary");
    expect(acceptButton().className).toContain("vx-button--tone-danger");
    expect(cancelButton().className).toContain("vx-button--ghost");
    await click(cancelButton());

    await act(async () => root.render(<></>));
    await render(<ConfirmProvider><Destroyer /></ConfirmProvider>);
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    expect(acceptButton().className).toContain("vx-button--tone-default");
    expect(acceptButton().className).not.toContain("vx-button--tone-danger");
  });

  it("uses a caller's title and labels and the active locale's fallbacks", async () => {
    await render(<ConfirmProvider><Destroyer details={{ title: "Delete files", confirmLabel: "Delete", cancelLabel: "Keep" }} /></ConfirmProvider>);
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    expect(dialog().querySelector("h2")?.textContent).toBe("Delete files");
    expect(acceptButton().textContent).toBe("Delete");
    expect(cancelButton().textContent).toBe("Keep");
    await click(cancelButton());

    await act(async () => root.render(<></>));
    await render(<ConfirmProvider><Destroyer /></ConfirmProvider>, "zh-CN");
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    expect(dialog().querySelector("h2")?.textContent).toBe("确认操作");
    expect(acceptButton().textContent).toBe("确认");
    expect(cancelButton().textContent).toBe("取消");
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "es-ES"])(
    "keeps the refused backup reason and the risk question as separate described paragraphs in %s",
    async (language) => {
      const i18n = createLauncherI18n(language, language);
      await i18n.initPromise;
      const reason = "Backup failed: the disk is full.";
      const message = i18n.t("library:loaderChange.skipBackupConfirm", { reason });
      const question = message.slice(message.indexOf(reason) + reason.length).trim();
      await render(<ConfirmProvider><Destroyer /></ConfirmProvider>, language);
      await act(async () => { void confirmFn(message, { tone: "danger" }); });
      const paragraphs = [...dialog().querySelectorAll<HTMLParagraphElement>(".vx-dialog__header p")];
      expect(paragraphs.map(paragraph => paragraph.textContent)).toEqual([reason, question]);
      const described = dialog().getAttribute("aria-describedby")!.split(" ");
      expect(described).toEqual(paragraphs.map(paragraph => paragraph.id));
      expect(new Set(described).size).toBe(2);
      await click(cancelButton());
    },
  );

  it("declines an earlier request that a newer one replaces", async () => {
    await render(<ConfirmProvider><Destroyer /></ConfirmProvider>);
    const answers: boolean[] = [];
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      first = confirmFn("First?").then(value => { answers.push(value); });
      second = confirmFn("Second?").then(value => { answers.push(value); });
    });
    await first;
    expect(answers).toEqual([false]);
    expect(dialog().textContent).toContain("Second?");
    await click(acceptButton());
    await second;
    expect(answers).toEqual([false, true]);
  });

  it("declines a request that is still open when the provider unmounts", async () => {
    await render(<ConfirmProvider><Destroyer /></ConfirmProvider>);
    let answer: boolean | undefined;
    let pending!: Promise<void>;
    await act(async () => { pending = confirmFn("Remove it?").then(value => { answer = value; }); });
    await act(async () => root.render(<></>));
    await pending;
    expect(answer).toBe(false);
  });

  it("declines without a provider instead of letting the action through", async () => {
    await render(<Destroyer details={{ tone: "danger" }} />);
    await click(container.querySelector<HTMLButtonElement>("#destroy")!);
    await act(async () => {});
    expect(destroy).not.toHaveBeenCalled();
    expect(container.querySelector("dialog")).toBeNull();
    await expect(confirmFn("Remove it?")).resolves.toBe(false);
  });
});
