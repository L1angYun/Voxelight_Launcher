// @vitest-environment jsdom
import { act, createElement, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationPage } from "./FloatingNav";
import type { LauncherContextValue } from "./controller/types";
import { defaults, type Config } from "../lib/launcher";
import { createLauncherI18n } from "../i18n";
import { useShortcuts } from "./useShortcuts";
import {
  LeaveGuardProvider,
  LeaveGuardScope,
  useLeaveGuard,
  useLeaveGuardController,
  useLeaveGuardScope,
  useSharedSave,
  type LeaveGuardSaveHandler,
  type LeaveGuardSaveResult,
} from "./leaveGuard";
import { AppShell } from "./App";

const allPages: NavigationPage[] = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"];

const shellState = vi.hoisted(() => ({ launcher: null as unknown as LauncherContextValue }));

vi.mock("./controller/LauncherProvider", () => ({ useLauncher: () => shellState.launcher }));
vi.mock("./AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: true, highContrast: false }),
}));
vi.mock("../design/useMotionTier", () => ({ useMotionTier: () => ({ tier: "none", sceneStatic: true }) }));
vi.mock("../components/WorldScene", () => ({ WorldScene: () => null }));
vi.mock("../features/downloads/useDownloadTasks", () => ({ useDownloadTasks: () => ({ activeCount: 0 }) }));
vi.mock("../features/home/HomePage", () => ({ HomePage: () => null }));
vi.mock("../features/library/LibraryPage", () => ({ LibraryPage: () => null }));
vi.mock("../features/discover/DiscoverPage", () => ({ DiscoverPage: () => null }));
vi.mock("../features/downloads/DownloadsPage", () => ({ DownloadsPage: () => null }));
vi.mock("../features/accounts/AccountsPage", () => ({ AccountsPage: () => null }));
vi.mock("../features/multiplayer/MultiplayerPage", () => ({ MultiplayerPage: () => null }));
vi.mock("./FloatingNav", async () => {
  const { createElement: h } = await import("react");
  return {
    FloatingNav: ({ onNavigate }: { onNavigate: (page: NavigationPage) => void }) => h("nav", null,
      h("button", { type: "button", "data-nav": "library", onClick: () => onNavigate("library") }, "Library"),
      h("button", { type: "button", "data-nav": "settings", onClick: () => onNavigate("settings") }, "Settings"),
    ),
  };
});
vi.mock("../features/settings/SettingsPage", async () => {
  const { createElement: h, useState: useDirty } = await import("react");
  const { useLeaveGuard: registerGuard } = await import("./leaveGuard");
  function SettingsPage() {
    const [dirty, setDirty] = useDirty(false);
    registerGuard(dirty, {
      save: async () => ({ ok: true }),
      discard: () => setDirty(false),
    });
    return h("div", { "data-test-page": "settings" },
      h("button", { type: "button", onClick: () => setDirty(true) }, "Make dirty"),
    );
  }
  return { SettingsPage };
});

let root: Root;
let container: HTMLDivElement;
const originalScrollTo = HTMLElement.prototype.scrollTo;

type SaveHandler = LeaveGuardSaveHandler;

function GuardedSettings({
  dirty,
  save,
  discard,
}: {
  dirty: boolean;
  save: SaveHandler;
  discard: () => void;
}) {
  useLeaveGuard(dirty, { save, discard });
  return createElement("div", { "data-testid": "settings-page" }, "Settings draft");
}

function Harness({
  initialDirty = true,
  save = async () => ({ ok: true }),
  discard = () => {},
}: {
  initialDirty?: boolean;
  save?: SaveHandler;
  discard?: () => void;
}) {
  const [page, setPage] = useState<NavigationPage>("settings");
  const [dirty, setDirty] = useState(initialDirty);
  const [draft, setDraft] = useState("draft");
  const { requestLeave } = useLeaveGuardController();

  async function navigate(next: NavigationPage) {
    if (next === page) return;
    if (await requestLeave()) setPage(next);
  }

  useShortcuts({ navigate: (next) => void navigate(next), implemented: new Set(allPages) });

  return (
    <>
      {page === "settings" ? (
        <GuardedSettings
          dirty={dirty}
          save={save}
          discard={() => {
            discard();
            setDraft("saved");
            setDirty(false);
          }}
        />
      ) : (
        <div data-testid="library-page">Library</div>
      )}
      <button type="button" data-testid="nav-library" onClick={() => void navigate("library")}>Library nav</button>
      <span data-testid="draft">{draft}</span>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settleResolve, settleReject) => {
    resolve = settleResolve;
    reject = settleReject;
  });
  return { promise, resolve, reject };
}

/** A page whose own Save button starts `pendingSave`; it is clean once that save succeeds. */
function PageWithOwnSave({
  pendingSave,
  save,
  discard,
  staysDirty = false,
  cleanWhileSaving = false,
}: {
  pendingSave: Promise<LeaveGuardSaveResult>;
  save: SaveHandler;
  discard: () => void;
  staysDirty?: boolean;
  cleanWhileSaving?: boolean;
}) {
  const [dirty, setDirty] = useState(true);
  const running = useRef<Promise<LeaveGuardSaveResult> | null>(null);
  useLeaveGuard(dirty, { save, discard, running: () => running.current });
  return createElement("button", {
    type: "button",
    "data-testid": "page-save",
    onClick: () => {
      if (cleanWhileSaving) setDirty(false);
      running.current = pendingSave.then((result) => {
        running.current = null;
        if (result.ok && !staysDirty) setDirty(false);
        return result;
      }, (cause: unknown) => {
        running.current = null;
        throw cause;
      });
    },
  }, "Save page");
}

function OwnSaveHarness(props: Parameters<typeof PageWithOwnSave>[0]) {
  const [page, setPage] = useState<NavigationPage>("settings");
  const { requestLeave } = useLeaveGuardController();
  async function navigate(next: NavigationPage) {
    if (await requestLeave()) setPage(next);
  }
  return (
    <>
      {page === "settings" ? <PageWithOwnSave {...props} /> : <div data-testid="library-page">Library</div>}
      <button type="button" data-testid="nav-library" onClick={() => void navigate("library")}>Library nav</button>
    </>
  );
}

/** A section that holds typed text outside the page draft, like a typed API key. */
function TypedSection({ save, discard, initiallyTyped }: { save: SaveHandler; discard: () => void; initiallyTyped: boolean }) {
  const [typed, setTyped] = useState(initiallyTyped);
  useLeaveGuard(typed, {
    save: async () => {
      const outcome = await save();
      if (outcome !== false && !(typeof outcome === "object" && outcome && !outcome.ok)) setTyped(false);
      return outcome;
    },
    discard: () => {
      discard();
      setTyped(false);
    },
  });
  return createElement("div", { "data-testid": "section-a" }, typed ? "typed" : "empty");
}

/** A page with its own dirty draft that swaps one scoped section for another. */
function ScopedPage({
  pageSave = async () => ({ ok: true }),
  pageDiscard = () => {},
  sectionSave = async () => ({ ok: true }),
  sectionDiscard = () => {},
  pageDirty = true,
  sectionTyped = true,
}: {
  pageSave?: SaveHandler;
  pageDiscard?: () => void;
  sectionSave?: SaveHandler;
  sectionDiscard?: () => void;
  pageDirty?: boolean;
  sectionTyped?: boolean;
}) {
  const scope = useLeaveGuardScope();
  const { requestLeave } = useLeaveGuardController();
  const [section, setSection] = useState<"a" | "b">("a");
  const [left, setLeft] = useState(false);
  useLeaveGuard(pageDirty, { save: pageSave, discard: pageDiscard });
  if (left) return createElement("div", { "data-testid": "left-page" }, "Left");
  return createElement("div", null,
    createElement(LeaveGuardScope, { scope },
      section === "a"
        ? createElement(TypedSection, { save: sectionSave, discard: sectionDiscard, initiallyTyped: sectionTyped })
        : createElement("div", { "data-testid": "section-b" }, "B")),
    createElement("button", {
      type: "button",
      "data-testid": "switch-section",
      onClick: () => void scope.requestLeave().then((allowed) => { if (allowed) setSection("b"); }),
    }, "Switch"),
    createElement("button", {
      type: "button",
      "data-testid": "leave-page",
      onClick: () => void requestLeave().then((allowed) => { if (allowed) setLeft(true); }),
    }, "Leave"),
  );
}

async function render(node: ReactNode) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, node)));
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog[open]");
}

function namedButton(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

async function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => window.dispatchEvent(event));
  return event;
}

function installShellLauncher() {
  const config: Config = { ...defaults, tourCompleted: true };
  const launcher = {
    bootstrapped: true,
    bootstrapFailed: false,
    data: { config, accounts: [], instances: [], installedVersions: [], capabilities: {} },
    config,
    manifest: null,
    activeAccount: undefined,
    accountAppearance: { skinUrl: undefined },
    selectedInstance: undefined,
    selectedVersion: undefined,
    selectedVersionId: "",
    selectedRunningGame: undefined,
    running: [],
    preparing: false,
    progress: null,
    resourceProgress: null,
    logs: [],
    busy: "",
    notice: null,
    gamePid: undefined,
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
  };
  shellState.launcher = launcher as unknown as LauncherContextValue;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.open = true; },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((dialogElement) => dialogElement.remove());
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: originalScrollTo });
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.restoreAllMocks();
});

describe("leave guard", () => {
  it("lets navigation proceed when no page is dirty", async () => {
    await render(createElement(LeaveGuardProvider, null, createElement(Harness, { initialDirty: false })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);

    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
  });

  it("asks with Save, Discard and Stay when the current page is dirty", async () => {
    await render(createElement(LeaveGuardProvider, null, createElement(Harness)));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);

    const prompt = dialog();
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toContain("Unsaved changes");
    expect(prompt?.textContent).toContain("Save your changes before leaving this page");
    expect(namedButton(prompt!, "Save")).toBeTruthy();
    expect(namedButton(prompt!, "Discard")).toBeTruthy();
    expect(namedButton(prompt!, "Stay")).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-page"]')).not.toBeNull();
  });

  it("saves first and only then navigates when Save succeeds", async () => {
    const save = vi.fn(async () => ({ ok: true }) as const);
    await render(createElement(LeaveGuardProvider, null, createElement(Harness, { save })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await click(namedButton(dialog()!, "Save"));

    expect(save).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
  });

  it("stays and shows the save error when Save fails", async () => {
    const save = vi.fn(async () => ({ ok: false as const, message: "The settings file is read-only." }));
    await render(createElement(LeaveGuardProvider, null, createElement(Harness, { save })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await click(namedButton(dialog()!, "Save"));

    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain("The settings file is read-only.");
    expect(container.querySelector('[data-testid="settings-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).toBeNull();
  });

  it("treats a save handler that returns nothing as success", async () => {
    const save = vi.fn();
    await render(createElement(LeaveGuardProvider, null, createElement(Harness, { save: () => { save(); } })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await click(namedButton(dialog()!, "Save"));

    expect(save).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
  });

  it("shows the generic error when the save handler rejects", async () => {
    const save = vi.fn(async () => { throw new Error("backend detail"); });
    await render(createElement(LeaveGuardProvider, null, createElement(Harness, { save })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await click(namedButton(dialog()!, "Save"));

    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain("Your changes could not be saved.");
    expect(dialog()?.textContent).not.toContain("backend detail");
  });

  it("discards the draft and navigates", async () => {
    const discard = vi.fn();
    await render(createElement(LeaveGuardProvider, null, createElement(Harness, { discard })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await click(namedButton(dialog()!, "Discard"));

    expect(discard).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="draft"]')?.textContent).toBe("saved");
  });

  it("closes the prompt, keeps the page and restores focus when the user stays", async () => {
    await render(createElement(LeaveGuardProvider, null, createElement(Harness)));
    const nav = container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!;
    nav.focus();
    await click(nav);
    await click(namedButton(dialog()!, "Stay"));

    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="settings-page"]')).not.toBeNull();
    expect(document.activeElement).toBe(nav);
  });

  it("sends keyboard shortcuts and the navigation bar through the guard", async () => {
    await render(createElement(LeaveGuardProvider, null, createElement(Harness)));

    await press({ key: "2", ctrlKey: true });
    expect(dialog()).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-page"]')).not.toBeNull();

    await click(namedButton(dialog()!, "Stay"));
    expect(dialog()).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    expect(dialog()).not.toBeNull();
    await click(namedButton(dialog()!, "Discard"));

    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
  });

  it("waits for a save the page already started and leaves once it succeeds, without offering Discard", async () => {
    const pending = deferred<LeaveGuardSaveResult>();
    const save = vi.fn(async () => ({ ok: true }) as const);
    const discard = vi.fn();
    await render(createElement(LeaveGuardProvider, null, createElement(OwnSaveHarness, { pendingSave: pending.promise, save, discard })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="page-save"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);

    const prompt = dialog()!;
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).toContain("Your changes are still being saved.");
    expect(namedButton(prompt, "Discard").disabled).toBe(true);
    expect(namedButton(prompt, "Save").disabled).toBe(true);
    expect(namedButton(prompt, "Stay").disabled).toBe(false);
    await click(namedButton(prompt, "Discard"));
    expect(discard).not.toHaveBeenCalled();

    await act(async () => pending.resolve({ ok: true }));

    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("shows the real failure of a save the page already started and offers Discard only afterwards", async () => {
    const pending = deferred<LeaveGuardSaveResult>();
    await render(createElement(LeaveGuardProvider, null, createElement(OwnSaveHarness, {
      pendingSave: pending.promise, save: async () => ({ ok: true }), discard: () => {},
    })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="page-save"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);

    await act(async () => pending.resolve({ ok: false, message: "The settings file is read-only." }));

    const prompt = dialog()!;
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).toContain("The settings file is read-only.");
    expect(prompt.textContent).not.toContain("still being saved");
    expect(prompt.textContent).not.toContain("Your changes could not be saved.");
    expect(namedButton(prompt, "Discard").disabled).toBe(false);
    expect(container.querySelector('[data-testid="page-save"]')).not.toBeNull();
  });

  it("asks again when changes remain after the page's own save finished", async () => {
    const pending = deferred<LeaveGuardSaveResult>();
    await render(createElement(LeaveGuardProvider, null, createElement(OwnSaveHarness, {
      pendingSave: pending.promise, save: async () => ({ ok: true }), discard: () => {}, staysDirty: true,
    })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="page-save"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await act(async () => pending.resolve({ ok: true }));

    const prompt = dialog()!;
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).not.toContain("still being saved");
    expect(namedButton(prompt, "Discard").disabled).toBe(false);
    expect(namedButton(prompt, "Save").disabled).toBe(false);
    expect(container.querySelector('[data-testid="library-page"]')).toBeNull();
  });

  it("waits for a running save even when the page already reports its draft as clean", async () => {
    const pending = deferred<LeaveGuardSaveResult>();
    await render(createElement(LeaveGuardProvider, null, createElement(OwnSaveHarness, {
      pendingSave: pending.promise, save: async () => ({ ok: true }), discard: () => {}, cleanWhileSaving: true,
    })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="page-save"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);

    expect(dialog()?.textContent).toContain("Your changes are still being saved.");
    expect(container.querySelector('[data-testid="library-page"]')).toBeNull();

    await act(async () => pending.resolve({ ok: true }));

    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).not.toBeNull();
  });

  it("keeps the page when the user stays while the page's own save runs", async () => {
    const pending = deferred<LeaveGuardSaveResult>();
    await render(createElement(LeaveGuardProvider, null, createElement(OwnSaveHarness, {
      pendingSave: pending.promise, save: async () => ({ ok: true }), discard: () => {},
    })));
    await click(container.querySelector<HTMLButtonElement>('[data-testid="page-save"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-testid="nav-library"]')!);
    await click(namedButton(dialog()!, "Stay"));
    expect(dialog()).toBeNull();

    await act(async () => pending.resolve({ ok: true }));

    expect(dialog()).toBeNull();
    expect(container.querySelector('[data-testid="library-page"]')).toBeNull();
    expect(container.querySelector('[data-testid="page-save"]')).not.toBeNull();
  });

  it("shares one running save between callers and starts a new one after it settled", async () => {
    let shared: ReturnType<typeof useSharedSave<boolean>> | null = null;
    function Probe() {
      shared = useSharedSave<boolean>();
      return null;
    }
    await render(createElement(Probe));
    const first = deferred<boolean>();
    const task = vi.fn(() => first.promise);
    const one = shared!.run(task);
    const two = shared!.run(task);
    expect(two).toBe(one);
    expect(shared!.current()).toBe(one);
    expect(task).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(true));
    await expect(one).resolves.toBe(true);
    expect(shared!.current()).toBeNull();
    const next = vi.fn(async () => false);
    await expect(shared!.run(next)).resolves.toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("guards the real AppShell navigation for shortcuts and the navigation bar", async () => {
    installShellLauncher();
    await render(createElement(AppShell));

    const main = container.querySelector<HTMLElement>("main")!;
    expect(main.dataset.currentPage).toBe("home");

    await press({ key: "7", ctrlKey: true });
    expect(main.dataset.currentPage).toBe("settings");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(container.querySelector('[data-test-page="settings"]')).not.toBeNull();

    await act(async () => namedButton(container, "Make dirty").click());
    await press({ key: "2", ctrlKey: true });
    expect(dialog()).not.toBeNull();
    expect(main.dataset.currentPage).toBe("settings");

    await click(namedButton(dialog()!, "Stay"));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-nav="library"]')!.click());
    expect(dialog()).not.toBeNull();
    expect(main.dataset.currentPage).toBe("settings");

    await click(namedButton(dialog()!, "Discard"));
    expect(dialog()).toBeNull();
    expect(main.dataset.currentPage).toBe("library");
  });

  describe("scoped sections", () => {
    const switchButton = () => container.querySelector<HTMLButtonElement>('[data-testid="switch-section"]')!;
    const leaveButton = () => container.querySelector<HTMLButtonElement>('[data-testid="leave-page"]')!;
    const shown = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;

    it("asks about only the section's own unsaved text on a switch, and Discard clears only that", async () => {
      const pageDiscard = vi.fn();
      const sectionDiscard = vi.fn();
      await render(createElement(LeaveGuardProvider, null, createElement(ScopedPage, { pageDiscard, sectionDiscard })));
      await click(switchButton());

      const prompt = dialog();
      expect(prompt?.textContent).toContain("Save your changes before switching to another section");
      expect(shown("section-a")).toBe(true);
      await click(namedButton(prompt!, "Discard"));

      expect(dialog()).toBeNull();
      expect(sectionDiscard).toHaveBeenCalledTimes(1);
      expect(pageDiscard).not.toHaveBeenCalled();
      expect(shown("section-b")).toBe(true);
    });

    it("saves only the section from a switch prompt and keeps the section when that save fails", async () => {
      const pageSave = vi.fn(async () => ({ ok: true }) as const);
      const sectionSave = vi.fn<SaveHandler>(async () => ({ ok: false, message: "Typed text could not be saved." }));
      await render(createElement(LeaveGuardProvider, null, createElement(ScopedPage, { pageSave, sectionSave })));
      await click(switchButton());
      await click(namedButton(dialog()!, "Save"));

      expect(sectionSave).toHaveBeenCalledTimes(1);
      expect(pageSave).not.toHaveBeenCalled();
      expect(dialog()?.textContent).toContain("Typed text could not be saved.");
      expect(shown("section-a")).toBe(true);

      sectionSave.mockImplementation(async () => ({ ok: true }));
      await click(namedButton(dialog()!, "Save"));
      expect(dialog()).toBeNull();
      expect(pageSave).not.toHaveBeenCalled();
      expect(shown("section-b")).toBe(true);
    });

    it("switches without asking while only the page draft is dirty", async () => {
      await render(createElement(LeaveGuardProvider, null, createElement(ScopedPage, { sectionTyped: false })));
      await click(switchButton());
      expect(dialog()).toBeNull();
      expect(shown("section-b")).toBe(true);
    });

    it("keeps guarding the whole page with the section's registrations", async () => {
      const pageSave = vi.fn(async () => ({ ok: true }) as const);
      const sectionSave = vi.fn(async () => ({ ok: true }) as const);
      await render(createElement(LeaveGuardProvider, null, createElement(ScopedPage, { pageSave, sectionSave })));
      await click(leaveButton());
      expect(dialog()?.textContent).toContain("Save your changes before leaving this page");
      await click(namedButton(dialog()!, "Save"));
      expect(pageSave).toHaveBeenCalledTimes(1);
      expect(sectionSave).toHaveBeenCalledTimes(1);
      expect(shown("left-page")).toBe(true);
    });

    it("checks the whole page after a section prompt that a page leave arrived during", async () => {
      const pageDiscard = vi.fn();
      await render(createElement(LeaveGuardProvider, null, createElement(ScopedPage, { pageDiscard })));
      await click(switchButton());
      expect(dialog()?.textContent).toContain("switching to another section");
      // A shortcut can still reach the shell while the section prompt is open.
      await click(leaveButton());
      await click(namedButton(dialog()!, "Discard"));

      expect(shown("section-b")).toBe(true);
      expect(shown("left-page")).toBe(false);
      expect(dialog()?.textContent).toContain("Save your changes before leaving this page");
      expect(pageDiscard).not.toHaveBeenCalled();
      await click(namedButton(dialog()!, "Stay"));
      expect(dialog()).toBeNull();
      expect(shown("left-page")).toBe(false);
    });
  });
});
