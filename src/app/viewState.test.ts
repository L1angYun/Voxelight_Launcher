// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetViewState, useViewState } from "./viewState";

function Probe({ name, initial = "initial" }: { name: string; initial?: string }) {
  const [value, setValue] = useViewState(name, initial);
  return createElement("div", null,
    createElement("span", { "data-testid": "value" }, value),
    createElement("button", { type: "button", onClick: () => setValue((current) => `${current}+`) }, "append"),
  );
}

let root: Root;
let container: HTMLDivElement;

function value() {
  return container.querySelector<HTMLElement>('[data-testid="value"]')?.textContent;
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

async function append() {
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetViewState();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("view state", () => {
  it("returns the initial value and updates it", async () => {
    await render(createElement(Probe, { name: "demo" }));
    expect(value()).toBe("initial");
    await append();
    expect(value()).toBe("initial+");
  });

  it("keeps a value for the app session after its page unmounts", async () => {
    await render(createElement(Probe, { name: "library" }));
    await append();
    await render(null);
    await render(createElement(Probe, { name: "library", initial: "another default" }));
    expect(value()).toBe("initial+");
  });

  it("keeps different view keys independent", async () => {
    function Pair() {
      const [left] = useViewState("pair.left", "left default");
      const [right] = useViewState("pair.right", "right default");
      return createElement("div", null,
        createElement("span", { "data-testid": "left" }, left),
        createElement("span", { "data-testid": "right" }, right),
      );
    }
    await render(createElement(Pair));
    expect(container.querySelector('[data-testid="left"]')?.textContent).toBe("left default");
    expect(container.querySelector('[data-testid="right"]')?.textContent).toBe("right default");
  });

  it("starts clean in a fresh app session", async () => {
    await render(createElement(Probe, { name: "fresh" }));
    await append();
    expect(value()).toBe("initial+");

    vi.resetModules();
    const fresh = await import("./viewState");
    function FreshProbe() {
      const [freshValue] = fresh.useViewState("fresh", "initial");
      return createElement("span", { "data-testid": "value" }, freshValue);
    }
    await render(createElement(FreshProbe));
    expect(value()).toBe("initial");
  });
});
