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

it("shows a status only when loading lasts 150 ms, and clears it immediately on completion", () => {
  render(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => vi.advanceTimersByTime(149));
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading versions");
  render(false);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("cancels a brief request and gives each new request its own full delay", () => {
  render(true);
  act(() => vi.advanceTimersByTime(100));
  render(false);
  act(() => vi.advanceTimersByTime(100));
  expect(container.querySelector('[role="status"]')).toBeNull();
  render(true);
  act(() => vi.advanceTimersByTime(149));
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});
