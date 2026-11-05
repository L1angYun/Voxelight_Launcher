// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";
import { RailNav } from "./RailNav";
import { SectionPanel } from "./SectionPanel";

vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "full", reducedMotion: true }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const options = [{ value: "first", label: "First" }, { value: "disabled", label: "Disabled", disabled: true }, { value: "last", label: "Last" }] as const;
function render(node: ReactNode) { act(() => root.render(node)); }
function key(button: HTMLButtonElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => button.dispatchEvent(event));
  return event;
}
function Example({ semantic = "tabs", label = "Views", activation = "automatic" }: { semantic?: "tabs" | "toggle" | "nav"; label?: string; activation?: "automatic" | "manual" }) {
  const [value, setValue] = useState<string>("first");
  return <Segmented semantic={semantic} label={label} options={options} value={value} onChange={setValue} panelId="example-panel" activation={activation} />;
}

describe("shared selection controls", () => {
  it("moves manual tab focus without activating until its button is invoked", () => {
    render(<Example activation="manual" />);
    const [first, , last] = [...container.querySelectorAll<HTMLButtonElement>("button")];
    first.focus(); key(first, "ArrowRight");
    expect(document.activeElement).toBe(last);
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(last.getAttribute("aria-selected")).toBe("false");
    expect(last.tabIndex).toBe(0); expect(first.tabIndex).toBe(-1);
    act(() => last.click());
    expect(last.getAttribute("aria-selected")).toBe("true");
    key(last, "Home");
    expect(document.activeElement).toBe(first);
    expect(last.getAttribute("aria-selected")).toBe("true");
  });
  it("moves tab focus and selection together, skips disabled tabs, and wraps", () => {
    render(<Example />);
    const [first, disabled, last] = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(first.tabIndex).toBe(0);
    expect(last.tabIndex).toBe(-1);
    expect(disabled.disabled).toBe(true);
    first.focus();
    expect(key(first, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(first.tabIndex).toBe(-1);
    key(last, "ArrowRight");
    expect(document.activeElement).toBe(first);
    key(first, "End");
    expect(document.activeElement).toBe(last);
    key(last, "Home");
    expect(document.activeElement).toBe(first);
    expect(key(first, "ArrowDown").defaultPrevented).toBe(false);
  });

  it.each(["toggle", "nav"] as const)("keeps %s buttons in normal Tab order and leaves arrow keys alone", (semantic) => {
    render(<Example semantic={semantic} />);
    const [first, , last] = [...container.querySelectorAll<HTMLButtonElement>("button")];
    first.focus();
    expect(key(first, "ArrowRight").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0);
    expect(last.tabIndex).toBe(0);
    expect(first.hasAttribute("aria-selected")).toBe(false);
    act(() => last.click());
    expect(last.getAttribute(semantic === "nav" ? "aria-current" : "aria-pressed")).toBe(semantic === "nav" ? "page" : "true");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("isolates simultaneously mounted controls and keeps their tab ids stable", () => {
    render(<><Example label="First dialog" /><Example label="Second dialog" /></>);
    const lists = [...container.querySelectorAll('[role="tablist"]')];
    const firstTabs = [...lists[0].querySelectorAll<HTMLButtonElement>("button")];
    const secondTabs = [...lists[1].querySelectorAll<HTMLButtonElement>("button")];
    expect(new Set([...firstTabs, ...secondTabs].map((button) => button.id)).size).toBe(6);
    const firstId = firstTabs[0].id;
    key(secondTabs[0], "End");
    expect(document.activeElement).toBe(secondTabs[2]);
    expect(firstTabs[0].getAttribute("aria-selected")).toBe("true");
    expect(firstTabs[0].id).toBe(firstId);
    expect(lists.every((list) => list.querySelector('[data-selection-mark]'))).toBe(true);
  });

  it("uses a labelled navigation landmark for the settings rail", () => {
    render(<RailNav label="Settings sections" options={options} value="first" onChange={() => {}} />);
    const nav = container.querySelector('nav[aria-label="Settings sections"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe("First");
  });

  it("replaces section content immediately and removes pending motion for reduced motion", () => {
    function Panels() {
      const [panel, setPanel] = useState("first");
      return <><button onClick={() => setPanel("last")}>Change</button><SectionPanel selectionKey={panel} role="tabpanel"><input aria-label={panel} defaultValue={panel} /></SectionPanel></>;
    }
    render(<Panels />);
    const oldInput = container.querySelector("input")!;
    act(() => container.querySelector("button")!.click());
    expect(oldInput.isConnected).toBe(false);
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(container.querySelector("input")?.value).toBe("last");
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("data-section-motion")).toBe("none");
  });
});
