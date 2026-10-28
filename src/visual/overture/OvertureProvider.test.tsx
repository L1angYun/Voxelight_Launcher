// @vitest-environment jsdom
import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OvertureProvider, useOverture } from "./OvertureProvider";
import { playOvertureTone } from "./audio";

vi.mock("./audio", () => ({ playOvertureTone: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useOverture>;

function Harness() {
  current = useOverture();
  return null;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Overture event choreography", () => {
  it("plays an event ID at most once and gives one event the focal point", () => {
    act(() => {
      root.render(createElement(OvertureProvider, null, createElement(Harness)));
    });
    act(() => current.play({ id: "launch-1", kind: "game-launched" }));
    expect(current.current?.id).toBe("launch-1");
    expect(current.playing).toBe(true);
    act(() => current.play({ id: "launch-1", kind: "game-launched" }));
    act(() => current.play({ id: "launch-2", kind: "game-launched" }));
    expect(current.current?.id).toBe("launch-1");
    act(() => current.dismiss());
    act(() => current.play({ id: "launch-2", kind: "game-launched" }));
    expect(current.current?.id).toBe("launch-2");
    act(() => vi.advanceTimersByTime(829));
    expect(current.playing).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(current.playing).toBe(false);
  });

  it("does not construct sound while sound is disabled", () => {
    act(() => {
      root.render(createElement(OvertureProvider, { soundEnabled: false }, createElement(Harness)));
    });
    act(() => current.play({ id: "quiet", kind: "instance-installed" }));
    expect(playOvertureTone).not.toHaveBeenCalled();
  });

  it("ends an event played during a StrictMode mount", () => {
    function PlayOnMount() {
      current = useOverture();
      const { play } = current;
      useEffect(() => play({ id: "mount", kind: "first-run" }), [play]);
      return null;
    }
    act(() => {
      root.render(createElement(StrictMode, null, createElement(OvertureProvider, null, createElement(PlayOnMount))));
    });
    expect(current.playing).toBe(true);
    act(() => vi.advanceTimersByTime(830));
    expect(current.playing).toBe(false);
  });

  it("suppresses a second focal event fired in the same tick", () => {
    act(() => {
      root.render(createElement(OvertureProvider, null, createElement(Harness)));
    });
    act(() => {
      current.play({ id: "first", kind: "game-launched" });
      current.play({ id: "second", kind: "instance-installed" });
    });
    expect(current.current?.id).toBe("first");
  });
});
