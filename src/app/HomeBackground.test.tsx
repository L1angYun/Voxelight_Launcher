// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command, defaults, type Config } from "../lib/launcher";
import { pickLauncherPath } from "../lib/nativePaths";
import type { LauncherContextValue } from "./controller/types";
import type { NavigationPage } from "./FloatingNav";
import { HomeBackground } from "./HomeBackground";
import { App } from "./App";
import { AppearanceSettings } from "../features/settings/AppearanceSettings";

const refreshEvent = "vx:home-background-refresh";
const toast = vi.hoisted(() => ({ notify: vi.fn(), dismiss: vi.fn() }));

let launcher: LauncherContextValue;
let effects: "lite" | "full";
let reducedMotion: boolean;
let highContrast: boolean;

vi.mock("../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/launcher")>()),
  command: vi.fn(),
}));

vi.mock("./controller/LauncherProvider", () => ({
  useLauncher: () => launcher,
}));

vi.mock("./AppearanceProvider", () => ({
  useAppearance: () => ({ effects, reducedMotion, highContrast, reducedTransparency: false }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { exists: () => false },
  }),
}));

vi.mock("../lib/nativePaths", () => ({
  pickLauncherPath: vi.fn(),
}));

vi.mock("../components/ui/Select", () => ({
  Select: () => null,
}));

vi.mock("../components/world/worldAvailability", () => ({
  useWorldAvailability: () => "available",
  publishWorldAvailability: vi.fn(),
}));

vi.mock("../components/ui/ToastProvider", async (importOriginal) => ({
  // The shell's dialogs use the real helpers; only the provider and hook are stubbed.
  ...(await importOriginal<typeof import("../components/ui/ToastProvider")>()),
  ToastProvider: ({ children }: { children?: ReactNode }) => children,
  useToast: () => toast,
}));

vi.mock("../features/updates/LauncherUpdates", () => ({
  LauncherUpdateProvider: ({ children }: { children?: ReactNode }) => children,
  UpdateNoticeBridge: () => null,
}));

vi.mock("../features/downloads/useDownloadTasks", () => ({
  useDownloadTasks: () => ({ activeCount: 0, tasks: [] }),
}));

vi.mock("../components/world/deriveWorldState", () => ({
  deriveWorldState: () => ({ phase: "idle", fraction: null }),
}));

vi.mock("./AppProviders", () => ({
  AppProviders: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("../components/WorldScene", async () => {
  const { createElement } = await import("react");
  return {
    WorldScene: ({ className, paused }: { className?: string; paused?: boolean }) =>
      createElement("div", { className, "data-paused": String(Boolean(paused)) }),
  };
});

vi.mock("./FloatingNav", async () => {
  const { createElement } = await import("react");
  return {
    FloatingNav: ({ page, onNavigate }: { page: string; onNavigate: (page: NavigationPage) => void }) =>
      createElement("header", { className: "vx-window-chrome", "data-nav-page": page },
        createElement("button", {
          type: "button",
          "data-navigate": "library",
          onClick: () => onNavigate("library"),
        }, "library")),
  };
});

vi.mock("../features/home/HomePage", async () => {
  const { createElement } = await import("react");
  return { HomePage: () => createElement("div", { "data-test-page": "home" }) };
});
vi.mock("../features/library/LibraryPage", async () => {
  const { createElement } = await import("react");
  return { LibraryPage: () => createElement("div", { "data-test-page": "library" }) };
});
vi.mock("../features/discover/DiscoverPage", async () => {
  const { createElement } = await import("react");
  return { DiscoverPage: () => createElement("div", { "data-test-page": "discover" }) };
});
vi.mock("../features/downloads/DownloadsPage", async () => {
  const { createElement } = await import("react");
  return { DownloadsPage: () => createElement("div", { "data-test-page": "downloads" }) };
});
vi.mock("../features/accounts/AccountsPage", async () => {
  const { createElement } = await import("react");
  return { AccountsPage: () => createElement("div", { "data-test-page": "accounts" }) };
});
vi.mock("../features/multiplayer/MultiplayerPage", async () => {
  const { createElement } = await import("react");
  return { MultiplayerPage: () => createElement("div", { "data-test-page": "multiplayer" }) };
});
vi.mock("../features/settings/SettingsPage", async () => {
  const { createElement } = await import("react");
  return { SettingsPage: () => createElement("div", { "data-test-page": "settings" }) };
});

const commandMock = vi.mocked(command);
const pickLauncherPathMock = vi.mocked(pickLauncherPath);
const imageUrl = "data:image/png;base64,UHJldmlldw==";
const otherImageUrl = "data:image/jpeg;base64,T3RoZXI=";

function createLauncher(overrides: Partial<LauncherContextValue> = {}): LauncherContextValue {
  const config: Config = { ...defaults, customBackground: null };
  return {
    bootstrapped: false,
    data: { config, accounts: [], instances: [], installedVersions: [], capabilities: {} },
    config,
    manifest: null,
    accountAppearance: {},
    selectedVersionId: "",
    running: [],
    preparing: false,
    progress: null,
    resourceProgress: null,
    logs: [],
    busy: "",
    notice: null,
    reload: vi.fn(async () => {}),
    saveConfig: vi.fn(async (next: Config) => next),
    setConfig: vi.fn(),
    selectInstance: vi.fn(),
    selectVersion: vi.fn(),
    launch: vi.fn(async () => {}),
    launchMultiplayer: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancelPreparation: vi.fn(async () => {}),
    run: vi.fn(async (_label: string, action: () => Promise<unknown>) => action()),
    dismissNotice: vi.fn(),
    ...overrides,
  } as unknown as LauncherContextValue;
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = "";

  get src() {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    preloadedImages.push(this);
  }
}

let preloadedImages: FakeImage[];
let root: Root;
let container: HTMLDivElement;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(page: NavigationPage = "home") {
  await act(async () => {
    root.render(createElement(HomeBackground, { page }));
  });
  await flush();
}

function layer() {
  return container.querySelector<HTMLElement>("[data-home-background]");
}

function answerWith(url: string) {
  commandMock.mockImplementation(async (name) =>
    name === "get_launcher_background" ? url : null,
  );
}

async function renderLoadedImage(page: NavigationPage = "home") {
  answerWith(imageUrl);
  launcher = { ...launcher, bootstrapped: true };
  await render(page);
  expect(preloadedImages).toHaveLength(1);
  await act(async () => {
    preloadedImages[0].onload?.();
  });
  await flush();
}

const backgroundSheet = parse(readFileSync("src/app/home-background.css", "utf8"));
function declarationsFor(selector: string, media?: string) {
  const declarations: Record<string, string[]> = {};
  backgroundSheet.walkRules((rule) => {
    if (rule.selectors.length !== 1 || rule.selectors[0].trim() !== selector) return;
    if (media) {
      let parent = rule.parent;
      let underMedia = false;
      while (parent && parent.type !== "root") {
        if (parent.type === "atrule" && parent.name === "media" && parent.params === media) {
          underMedia = true;
          break;
        }
        parent = parent.parent;
      }
      if (!underMedia) return;
    }
    rule.walkDecls((declaration) => {
      (declarations[declaration.prop] ??= []).push(declaration.value);
    });
  });
  return declarations;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // The app shell scrolls the main region when a page exit completes; jsdom
  // implements the element but not this method.
  if (typeof HTMLElement.prototype.scrollTo !== "function") {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
  effects = "full";
  reducedMotion = false;
  highContrast = false;
  preloadedImages = [];
  launcher = createLauncher();
  vi.stubGlobal("Image", FakeImage);
  commandMock.mockReset();
  commandMock.mockImplementation(async () => null);
  pickLauncherPathMock.mockReset();
  pickLauncherPathMock.mockResolvedValue(null);
  toast.notify.mockReset();
  toast.dismiss.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.worldIntro;
});

describe("HomeBackground", () => {
  it("does not request the image before bootstrap and requests once afterwards", async () => {
    await render();
    expect(commandMock).not.toHaveBeenCalled();

    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\early.png" },
    };
    await render();
    expect(commandMock).not.toHaveBeenCalled();

    launcher = { ...launcher, bootstrapped: true };
    await render();

    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(commandMock).toHaveBeenCalledWith("get_launcher_background");
  });

  it("requests a new image whenever customBackground changes", async () => {
    launcher = { ...launcher, bootstrapped: true };
    await render();
    expect(commandMock).toHaveBeenCalledTimes(1);

    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\one.png" },
    };
    await render();
    expect(commandMock).toHaveBeenCalledTimes(2);

    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\two.png" },
    };
    await render();
    expect(commandMock).toHaveBeenCalledTimes(3);

    // An unrelated rerender must not fetch the image again.
    await render();
    expect(commandMock).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale response that arrives after a newer request", async () => {
    launcher = { ...launcher, bootstrapped: true };
    const stale = deferred<string | null>();
    const current = deferred<string | null>();
    let requests = 0;
    commandMock.mockImplementation((name) => {
      if (name !== "get_launcher_background") return Promise.resolve(null);
      requests += 1;
      return requests === 1 ? stale.promise : current.promise;
    });

    await render();
    expect(requests).toBe(1);

    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\new.png" },
    };
    await render();
    expect(requests).toBe(2);

    await act(async () => {
      current.resolve(otherImageUrl);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(preloadedImages).toHaveLength(1);
    await act(async () => {
      preloadedImages[0].onload?.();
    });
    await flush();
    expect(layer()?.style.backgroundImage).toContain(otherImageUrl);

    await act(async () => {
      stale.resolve(imageUrl);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(preloadedImages).toHaveLength(1);
    expect(layer()?.style.backgroundImage).toContain(otherImageUrl);
    expect(layer()?.style.backgroundImage).not.toContain(imageUrl);
  });

  it("builds the image style once instead of stringifying it on every render", async () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      await renderLoadedImage();
      const stringifiedImageUrl = () =>
        stringify.mock.calls.filter(([value]) => value === imageUrl).length;
      expect(stringifiedImageUrl()).toBe(1);

      // Progress and log events rerender Home while an image is shown.
      await render();
      await render();
      expect(stringifiedImageUrl()).toBe(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it("removes the shown layer when the command returns null", async () => {
    await renderLoadedImage();
    expect(layer()).not.toBeNull();

    commandMock.mockImplementation(async () => null);
    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\cleared.png" },
    };
    await render();
    await flush();

    expect(layer()).toBeNull();
  });

  it("removes the shown layer when the command fails", async () => {
    await renderLoadedImage();
    expect(layer()).not.toBeNull();

    commandMock.mockRejectedValue(new Error("background is missing"));
    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\missing.png" },
    };
    await render();
    await flush();

    expect(layer()).toBeNull();
  });

  it("removes the shown layer when a new preload fails", async () => {
    await renderLoadedImage();
    expect(layer()).not.toBeNull();

    answerWith(otherImageUrl);
    launcher = {
      ...launcher,
      config: { ...launcher.config, customBackground: "C:\\pictures\\broken.png" },
    };
    await render();
    expect(preloadedImages).toHaveLength(2);

    await act(async () => {
      preloadedImages[1].onerror?.();
    });
    await flush();

    expect(layer()).toBeNull();
  });

  it("shows the loaded image on home and hides it on another page", async () => {
    await renderLoadedImage("home");

    expect(layer()).not.toBeNull();
    expect(layer()?.style.backgroundImage).toContain(imageUrl);
    expect(layer()?.dataset.visible).toBe("true");
    expect(layer()?.style.opacity).toBe("1");

    await render("library");
    expect(layer()?.dataset.visible).toBe("false");
    expect(layer()?.style.opacity).toBe("0");

    await render("home");
    expect(layer()?.dataset.visible).toBe("true");
    expect(layer()?.style.opacity).toBe("1");
  });

  it("is hidden from assistive technology and never captures pointer input", async () => {
    await renderLoadedImage();

    expect(layer()?.getAttribute("aria-hidden")).toBe("true");
    expect(layer()?.style.pointerEvents).toBe("none");
  });

  it.each([
    { label: "reduced motion", effects: "full" as const, reducedMotion: true },
    { label: "lite effects", effects: "lite" as const, reducedMotion: false },
  ])("does not fade in or out with $label", async ({ effects: nextEffects, reducedMotion: nextReducedMotion }) => {
    effects = nextEffects;
    reducedMotion = nextReducedMotion;
    await renderLoadedImage();

    expect(layer()?.dataset.motion).toBe("reduced");
  });

  it("refreshes when the same configured path is chosen again", async () => {
    answerWith(imageUrl);
    launcher = {
      ...launcher,
      bootstrapped: true,
      config: { ...launcher.config, customBackground: "C:\\pictures\\background.png" },
    };
    await render();
    expect(preloadedImages).toHaveLength(1);
    await act(async () => {
      preloadedImages[0].onload?.();
    });
    await flush();
    expect(layer()?.style.backgroundImage).toContain(imageUrl);

    answerWith(otherImageUrl);
    await act(async () => {
      window.dispatchEvent(new Event(refreshEvent));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(commandMock).toHaveBeenCalledTimes(2);
    expect(preloadedImages).toHaveLength(2);
    await act(async () => {
      preloadedImages[1].onload?.();
    });
    await flush();
    expect(layer()?.style.backgroundImage).toContain(otherImageUrl);
  });
});

describe("HomeBackground in the app shell", () => {
  it("mounts between the world scene and the shell and follows the current page", async () => {
    answerWith(imageUrl);
    launcher = createLauncher({
      bootstrapped: true,
      config: { ...defaults, customBackground: "C:\\pictures\\background.png" },
    });
    await act(async () => root.render(createElement(App)));
    await flush();
    expect(preloadedImages).toHaveLength(1);
    await act(async () => {
      preloadedImages[0].onload?.();
    });
    await flush();

    const body = container.querySelector(".vx-app-body");
    expect(body).not.toBeNull();
    const children = [...body!.children];
    const scene = children.findIndex((child) => child.classList.contains("vx-global-scene"));
    const background = children.findIndex((child) => child.hasAttribute("data-home-background"));
    const chrome = children.findIndex((child) => child.classList.contains("vx-window-chrome"));
    const main = children.findIndex((child) => child.classList.contains("vx-app-main"));
    expect(scene).toBe(0);
    expect(background).toBe(1);
    expect(chrome).toBeGreaterThan(background);
    expect(main).toBeGreaterThan(background);
    expect(layer()?.dataset.visible).toBe("true");
    // The opaque image covers the world scene: stop its animation on Home.
    const sceneHost = () => container.querySelector<HTMLElement>(".vx-global-scene")!;
    expect(sceneHost().dataset.paused).toBe("true");

    const goLibrary = container.querySelector<HTMLButtonElement>('[data-navigate="library"]');
    expect(goLibrary).not.toBeNull();
    await act(async () => {
      goLibrary!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(layer()?.dataset.visible).toBe("false");
    // Leave Home immediately, before the 300 ms background fade finishes.
    expect(sceneHost().dataset.paused).toBe("false");
  });
});

describe("AppearanceSettings background refresh", () => {
  it("signals HomeBackground when a successfully saved path is unchanged", async () => {
    const onPersistedPatch = vi.fn(async () => {});
    const onNotice = vi.fn();
    const refresh = vi.fn();
    pickLauncherPathMock.mockResolvedValue("C:\\pictures\\background.png");
    commandMock.mockImplementation(async (name) =>
      name === "set_launcher_background"
        ? { ...defaults, customBackground: "C:\\pictures\\background.png" }
        : null,
    );
    window.addEventListener(refreshEvent, refresh);

    try {
      await act(async () => {
        root.render(createElement(AppearanceSettings, {
          config: { ...defaults, customBackground: "C:\\pictures\\background.png" },
          onChange: vi.fn(),
          onPersisted: vi.fn(async () => {}),
          onPersistedPatch,
          onError: vi.fn(),
          onNotice,
        }));
      });
      await flush();

      const choose = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("settings:background.choose"));
      expect(choose).toBeDefined();
      await act(async () => {
        choose!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let index = 0; index < 5; index++) await Promise.resolve();
      });
      await flush();

      expect(commandMock).toHaveBeenCalledWith("set_launcher_background", {
        path: "C:\\pictures\\background.png",
      });
      expect(onPersistedPatch).toHaveBeenCalledWith({
        customBackground: "C:\\pictures\\background.png",
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(refreshEvent, refresh);
    }
  });
});

describe("home-background styles", () => {
  it("scrims the transparent chrome and the top of Home over a photo", () => {
    const scrim = declarationsFor(".vx-home-background::after");
    const background = scrim.background?.join(" ") ?? "";
    expect(background).toContain("180deg");
    expect(background).toContain("var(--shell-height");
    expect(background).toContain("--bg-base");

    const chrome = declarationsFor(
      '.vx-app-body:has(> .vx-home-background[data-visible="true"]) .vx-window-chrome__bar',
    );
    expect(chrome.background?.[0]).toContain("--bg-overlay");
  });

  it("keeps Home's identity visible over a shown image during the world intro", () => {
    const identity = declarationsFor(
      ':root[data-world-intro="on"] .vx-app-body:has(> .vx-home-background[data-visible="true"]) .vx-home__identity:not([data-picker-open="true"])',
    );
    expect(identity.opacity).toEqual(["1"]);
  });

  it("removes the photo in forced colors", () => {
    const forced = declarationsFor(".vx-home-background", "(forced-colors: active)");
    expect(forced.display).toEqual(["none"]);
  });
});
