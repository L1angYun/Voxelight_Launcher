// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoadingStatus } from "./LoadingStatus";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
function render(active: boolean) { act(() => root.render(<LoadingStatus active={active}>Loading versions</LoadingStatus>)); }

it("mounts an empty live region before loading and changes its text only after 150 ms", () => {
  render(false);
  const status = container.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status?.textContent).toBe("");
  render(true);
  expect(container.querySelector('[role="status"]')).toBe(status);
  act(() => vi.advanceTimersByTime(149));
  expect(status?.textContent).toBe("");
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading versions");
  render(false);
  expect(container.querySelector('[role="status"]')).toBe(status);
  expect(status?.textContent).toBe("");
});

it("cancels a brief request and gives each new request its own full delay", () => {
  render(true);
  act(() => vi.advanceTimersByTime(100));
  render(false);
  act(() => vi.advanceTimersByTime(100));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  render(true);
  act(() => vi.advanceTimersByTime(149));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});
