// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterCanvas } from "./CharacterCanvas";

const { loadSkin, loadCape, viewers, MockViewer } = vi.hoisted(() => {
  const loadSkin = vi.fn();
  const loadCape = vi.fn();
  const viewers: MockViewer[] = [];
  class MockViewer {
    disposed = false;
    renderPaused = false;
    autoRotate = false;
    animation: unknown = null;
    scene = { traverse: vi.fn() };
    controls = {
      enablePan: false,
      enableDamping: false,
      enableRotate: true,
      enableZoom: true,
      minDistance: 30,
      maxDistance: 140,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      update: vi.fn(),
    };
    playerWrapper = { rotation: { x: 0, y: 0, set: vi.fn() }, visible: true };
    camera = { position: { length: () => 60, multiplyScalar: vi.fn() } };
    composer = { dispose: vi.fn() };
    fxaaPass = { material: { dispose: vi.fn() } };
    renderer = { forceContextLoss: vi.fn() };
    constructor(public options: unknown) {
      viewers.push(this);
    }
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn(() => {
      this.disposed = true;
    });
    resetCameraPose = vi.fn();
  }
  return { loadSkin, loadCape, viewers, MockViewer };
});
let rejectNextSkin = false;
let rejectNextCape = false;

vi.mock("skinview3d", () => ({
  SkinViewer: MockViewer,
  WebGLSkinViewer: MockViewer,
  IdleAnimation: class {},
  WalkingAnimation: class {},
  RunningAnimation: class {},
}));

vi.mock("../../components/skinTexture", () => ({
  SkinTextureLoader: class {
    load = loadSkin;
    dispose = vi.fn();
  },
  CapeTextureLoader: class {
    load = loadCape;
    dispose = vi.fn();
  },
}));

let root: Root;
let container: HTMLDivElement;
let intersectionCallback: IntersectionObserverCallback | undefined;

async function render(props: Parameters<typeof CharacterCanvas>[0]) {
  await act(async () => {
    root.render(createElement(CharacterCanvas, props));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  viewers.length = 0;
  rejectNextSkin = false;
  rejectNextCape = false;
  loadSkin.mockReset();
  loadCape.mockReset();
  loadSkin.mockImplementation(async () => {
    if (rejectNextSkin) throw new Error("damaged skin");
    return true;
  });
  loadCape.mockImplementation(async () => {
    if (rejectNextCape) throw new Error("damaged cape");
    return true;
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })),
  });
  intersectionCallback = undefined;
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("CharacterCanvas", () => {
  it("loads the selected skin and cape with accessible manual controls", async () => {
    await render({ skinUrl: "skin.png", capeUrl: "cape.png", model: "slim", interactive: true, label: "Account skin" });
    expect(loadSkin).toHaveBeenCalledWith("skin.png", "slim");
    expect(loadCape).toHaveBeenCalledWith("cape.png", "cape");
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-label")).toBe("Account skin");
    expect(canvas.tabIndex).toBe(0);
    expect(viewers[0].autoRotate).toBe(true);
  });

  it("pauses rendering and reports damaged resources with a retry path", async () => {
    const onError = vi.fn();
    rejectNextSkin = true;
    await render({ skinUrl: "broken.png", paused: true, label: "Preview", onError });
    expect(onError).toHaveBeenCalledWith("damaged skin");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    rejectNextSkin = false;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-character-retry]')!.click();
    });
    expect(loadSkin).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(viewers.at(-1)?.renderPaused).toBe(true);
  });

  it("pauses offscreen rendering and resumes without changing preferences", async () => {
    await render({ skinUrl: "skin.png", interactive: true, autoRotate: true, animation: "walk", label: "Preview" });
    const viewer = viewers[0];
    expect(viewer.renderPaused).toBe(false);
    await act(async () => intersectionCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(viewer.renderPaused).toBe(true);
    expect(viewer.autoRotate).toBe(true);
    await act(async () => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(viewer.renderPaused).toBe(false);
    expect(viewer.autoRotate).toBe(true);
  });

  it("clears a valid skin and cape when a later resource fails", async () => {
    await render({ skinUrl: "valid-skin.png", capeUrl: "valid-cape.png", label: "Preview" });
    const viewer = viewers[0];
    expect(viewer.playerWrapper.visible).toBe(true);

    rejectNextSkin = true;
    rejectNextCape = true;
    await render({ skinUrl: "broken-skin.png", capeUrl: "broken-cape.png", label: "Preview" });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(viewer.playerWrapper.visible).toBe(false);
    expect(loadCape).toHaveBeenCalledWith(null, "cape");
  });
});
