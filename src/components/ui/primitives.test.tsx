// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";
import { EmptyState, ToastRegion } from "./Feedback";

let root: Root;
let container: HTMLDivElement;

function render(node: ReactNode) {
  act(() => root.render(node));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function () {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function () {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("UI primitives", () => {
  it("keeps button hierarchy independent from semantic tone", () => {
    render(createElement(Button, { variant: "ghost", tone: "danger" }, "Delete"));
    const button = container.querySelector("button")!;
    expect(button.dataset.variant).toBe("ghost");
    expect(button.dataset.tone).toBe("danger");
    expect(button.querySelectorAll("button")).toHaveLength(0);
    render(createElement(IconButton, { label: "关闭", icon: "×" }));
    expect(container.querySelector("button")!.getAttribute("aria-label")).toBe("关闭");
  });

  it("does not invent an action for an empty state", () => {
    render(createElement(EmptyState, { title: "No instances" }));
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("No instances");
  });

  it("connects field descriptions and errors to the control", () => {
    render(
      createElement(
        Field,
        { label: "Memory", description: "Maximum heap", error: "Too large" },
        createElement("input", { id: "memory", "aria-label": "Memory" }),
      ),
    );
    const input = container.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("field-description");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Too large");
  });

  it("focuses the first dialog control, traps Tab, and restores the trigger on Escape", () => {
    const onChange = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return createElement(
        "div",
        null,
        createElement("button", { id: "trigger", onClick: () => setOpen(true) }, "Open"),
        createElement(
          Dialog,
          {
            open,
            onOpenChange: (value: boolean) => {
              onChange(value);
              setOpen(value);
            },
            title: "Install",
            closeLabel: "关闭对话框",
          },
          createElement("input", { id: "instance-name", "aria-label": "Instance name" }),
        ),
      );
    }
    render(createElement(Example));
    const trigger = container.querySelector<HTMLButtonElement>("#trigger")!;
    trigger.focus();
    act(() => trigger.click());
    const dialog = container.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(document.activeElement?.id).toBe("instance-name");
    const close = dialog.querySelector<HTMLButtonElement>("[data-dialog-close]")!;
    close.focus();
    act(() => {
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement?.id).toBe("instance-name");
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(false);
    expect(dialog.open).toBe(false);
    expect(document.activeElement?.id).toBe("trigger");
  });

  it("uses an alert for an error toast", () => {
    render(createElement(ToastRegion, { message: "Failed", kind: "error", onDismiss: vi.fn(), closeLabel: "关闭" }));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
