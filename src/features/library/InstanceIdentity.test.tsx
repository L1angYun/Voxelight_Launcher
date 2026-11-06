// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceIdentity, InstanceIdentityProvider } from "./InstanceIdentity";
import type { MotionTier } from "../../design/motion";

type LayoutEvents = { onLayoutAnimationStart?: () => void; onLayoutAnimationComplete?: () => void };
const layoutEvents = new Map<string, LayoutEvents>();
const layoutBindings = new Map<string, { layoutId?: string; dependency?: string }>();
// jsdom has no layout projection. Drive Motion's public lifecycle boundary;
// the identity component still owns the real card DOM and its cleanup.
vi.mock("motion/react", () => ({ motion: { span: ({ layoutId, layoutDependency,
  transition: _transition, onLayoutAnimationStart, onLayoutAnimationComplete, ...props }:
  HTMLAttributes<HTMLSpanElement> & LayoutEvents & { ref?: Ref<HTMLSpanElement>; "data-identity": string;
    layoutId?: string; layoutDependency?: string; transition?: unknown }) => {
  layoutEvents.set(props["data-identity"], { onLayoutAnimationStart, onLayoutAnimationComplete });
  layoutBindings.set(props["data-identity"], { layoutId, dependency: layoutDependency });
  return createElement("span", props);
} } }));
vi.mock("../../lib/launcher", () => ({ desktop: false }));

let container: HTMLDivElement;
let root: Root;
type Kind = "instance" | "version-directory";

function render({ tier = "full", kind = "instance", returning = true, placement = "card", visible = true }:
  { tier?: MotionTier; kind?: Kind; returning?: boolean; placement?: "card" | "detail"; visible?: boolean } = {}) {
  act(() => root.render(<InstanceIdentityProvider tier={tier} returningIdentity={returning ? `${kind}:origin` : undefined}>
    <article className="vx-instance-card" data-card="origin">
      {visible && <InstanceIdentity name="Origin" identity="origin" kind={kind} placement={placement} />}
    </article>
    <article className="vx-instance-card" data-card="other">
      <InstanceIdentity name="Other" identity="other" kind={kind} />
    </article>
  </InstanceIdentityProvider>));
}
function card(id = "origin") { return container.querySelector<HTMLElement>(`[data-card="${id}"]`)!; }
function emit(event: keyof LayoutEvents, id = "origin") { act(() => layoutEvents.get(id)?.[event]?.()); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  layoutEvents.clear();
  layoutBindings.clear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("return identity card elevation", () => {
  it.each(["instance", "version-directory"] as const)("passes a stable %s shared layout key and distinct placement dependencies to Motion", kind => {
    render({ kind, placement: "card" });
    expect(layoutBindings.get("origin")).toEqual({ layoutId: `${kind}-identity-origin`, dependency: "origin:card" });
    render({ kind, placement: "detail", returning: false });
    expect(layoutBindings.get("origin")).toEqual({ layoutId: `${kind}-identity-origin`, dependency: "origin:detail" });
    render({ kind, placement: "card", tier: "fade" });
    expect(layoutBindings.get("origin")).toEqual({ layoutId: undefined, dependency: undefined });
  });

  it.each(["instance", "version-directory"] as const)("raises only the returning %s card for its active flight", kind => {
    render({ kind });
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
    emit("onLayoutAnimationStart", "other");
    expect(card("other").hasAttribute("data-identity-flight")).toBe(false);
    emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(true);
    // The library consumes its previous-detail record before the flight ends.
    render({ kind, returning: false });
    expect(card().hasAttribute("data-identity-flight")).toBe(true);
    emit("onLayoutAnimationComplete");
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
    emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
  });

  it("does not raise an initial card during collection reordering", () => {
    render({ returning: false }); emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
  });

  it("clears the elevation when a return is interrupted by opening details", () => {
    render(); emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(true);
    render({ placement: "detail", returning: false });
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
    emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
  });

  it("clears an interrupted flight when its identity is removed", () => {
    render(); emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(true);
    render({ visible: false, returning: false });
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
    render({ returning: false }); emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
  });

  it.each(["fade", "none"] as const)("clears an active flight when the tier changes to %s", tier => {
    render(); emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(true);
    render({ tier });
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
    emit("onLayoutAnimationStart");
    expect(card().hasAttribute("data-identity-flight")).toBe(false);
  });
});
