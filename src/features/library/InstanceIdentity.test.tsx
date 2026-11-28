// @vitest-environment jsdom
import { act, createElement, Fragment, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceIdentity, InstanceIdentityProvider } from "./InstanceIdentity";
import { InstanceCard } from "./InstanceCard";
import { InstanceDetailPage } from "./InstanceDetailPage";
import type { Instance } from "../../lib/launcher";
import type { MotionTier } from "../../design/motion";

type LayoutEvents = { onLayoutAnimationStart?: () => void; onLayoutAnimationComplete?: () => void };
const layoutEvents = new Map<string, LayoutEvents>();
const layoutBindings = new Map<string, { layoutId?: string; dependency?: string }>();
// jsdom has no layout projection. Drive Motion's public lifecycle boundary;
// the identity component still owns the real card DOM and its cleanup.
vi.mock("motion/react", () => {
  const span = ({ layoutId, layoutDependency, transition: _transition,
    onLayoutAnimationStart, onLayoutAnimationComplete, ...props }:
    HTMLAttributes<HTMLSpanElement> & LayoutEvents & { ref?: Ref<HTMLSpanElement>; "data-identity": string;
      layoutId?: string; layoutDependency?: string; transition?: unknown }) => {
    layoutEvents.set(props["data-identity"], { onLayoutAnimationStart, onLayoutAnimationComplete });
    layoutBindings.set(props["data-identity"], { layoutId, dependency: layoutDependency });
    return createElement("span", props);
  };
  const article = ({ transition: _transition, layout: _layout, layoutDependency: _dependency, ...props }:
    HTMLAttributes<HTMLElement> & { transition?: unknown; layout?: unknown; layoutDependency?: unknown }) =>
    createElement("article", props);
  return { motion: { span, article }, LayoutGroup: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children) };
});
const launcherMock = vi.hoisted(() => ({ desktop: false }));
vi.mock("../../lib/launcher", () => ({
  get desktop() { return launcherMock.desktop; },
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  convertFileSrc: (path: string) => `asset://fixture/${path}`,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => ({ run: async (_key: string, action: () => Promise<void>) => action() }),
}));
vi.mock("./InstanceOverview", () => ({ InstanceOverview: () => null }));
vi.mock("./InstanceContent", () => ({ InstanceContent: () => null }));
vi.mock("./InstanceWorlds", () => ({ InstanceWorlds: () => null }));
vi.mock("./InstanceLogs", () => ({ InstanceLogs: () => null }));
vi.mock("./InstanceSettings", () => ({ InstanceSettings: () => null }));

let container: HTMLDivElement;
let root: Root;
type Kind = "instance" | "version-directory";

function render({ tier = "full", kind = "instance", returning = true, placement = "card", visible = true,
  iconPath = null, loader, versionId, versionType, name = "Origin" }:
  { tier?: MotionTier; kind?: Kind; returning?: boolean; placement?: "card" | "detail"; visible?: boolean;
    iconPath?: string | null; loader?: string | null; versionId?: string; versionType?: string | null; name?: string } = {}) {
  act(() => root.render(<InstanceIdentityProvider tier={tier} returningIdentity={returning ? `${kind}:origin` : undefined}>
    <article className="vx-instance-card" data-card="origin">
      {visible && <InstanceIdentity name={name} identity="origin" kind={kind} placement={placement}
        iconPath={iconPath} loader={loader} versionId={versionId} versionType={versionType} />}
    </article>
    <article className="vx-instance-card" data-card="other">
      <InstanceIdentity name="Other" identity="other" kind={kind} />
    </article>
  </InstanceIdentityProvider>));
}
function card(id = "origin") { return container.querySelector<HTMLElement>(`[data-card="${id}"]`)!; }
function emit(event: keyof LayoutEvents, id = "origin") { act(() => layoutEvents.get(id)?.[event]?.()); }
function renderNode(node: ReactNode) { act(() => root.render(node)); }
function glyphAttributes(element: Element | null) {
  const glyph = element?.querySelector(".vx-instance-glyph");
  return glyph ? {
    loader: glyph.getAttribute("data-glyph-loader"),
    version: glyph.getAttribute("data-glyph-version"),
  } : null;
}

const glyphInstance: Instance = {
  id: "glyph-world",
  name: "Glyph World",
  versionId: "24w14a",
  gameDirectory: "C:\\Glyph",
  createdAt: "2026-01-01T00:00:00Z",
  category: "",
  iconPath: null,
  notes: "",
  maxMemoryMb: null,
  javaPath: null,
  jvmArguments: null,
  screenWidth: null,
  screenHeight: null,
  totalPlayTime: 0,
  loader: "fabric",
  loaderVersion: "0.16.10",
};
const loaderVersion: Instance = {
  id: "fabric-loader-0.16.10-24w14a",
  name: "Fabric 24w14a",
  versionId: "fabric-loader-0.16.10-24w14a",
  gameDirectory: "C:\\Loader",
  createdAt: "2026-01-01T00:00:00Z",
  category: "",
  iconPath: null,
  notes: "",
  maxMemoryMb: null,
  javaPath: null,
  jvmArguments: null,
  screenWidth: null,
  screenHeight: null,
  totalPlayTime: 0,
  loader: "fabric",
  loaderVersion: "0.16.10",
  kind: "version",
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  launcherMock.desktop = false;
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

describe("default instance glyph", () => {
  it("renders a loader glyph with the version data when no custom icon exists", () => {
    render({ loader: "fabric", versionId: "24w14a" });
    const glyph = card().querySelector<SVGSVGElement>(".vx-instance-glyph")!;
    expect(glyph).not.toBeNull();
    expect(glyph.getAttribute("data-glyph-loader")).toBe("fabric");
    expect(glyph.getAttribute("data-glyph-version")).toBe("snapshot");
    expect(card().querySelector("img")).toBeNull();
    expect(card().querySelector(".vx-instance-identity__plane")).toBeNull();
  });

  it("lets the version type override the id when deciding the mark", () => {
    render({ loader: null, versionId: "1.21.1", versionType: "old_alpha" });
    const glyph = card().querySelector<SVGSVGElement>(".vx-instance-glyph")!;
    expect(glyph.getAttribute("data-glyph-loader")).toBe("vanilla");
    expect(glyph.getAttribute("data-glyph-version")).toBe("old");
  });

  it("keeps a working custom icon and does not render a glyph", () => {
    launcherMock.desktop = true;
    render({ iconPath: "custom.png", loader: "forge", versionId: "1.21.1" });
    expect(card().querySelector("img")?.getAttribute("src")).toBe("asset://fixture/custom.png");
    expect(card().querySelector(".vx-instance-glyph")).toBeNull();
  });

  it("falls back to the glyph after the custom icon fails to load", () => {
    launcherMock.desktop = true;
    render({ iconPath: "damaged.png", loader: "quilt", versionId: "1.20.1" });
    const image = card().querySelector("img")!;
    expect(image).not.toBeNull();
    act(() => image.dispatchEvent(new Event("error")));
    expect(card().querySelector("img")).toBeNull();
    const glyph = card().querySelector<SVGSVGElement>(".vx-instance-glyph")!;
    expect(glyph.getAttribute("data-glyph-loader")).toBe("quilt");
    expect(glyph.getAttribute("data-glyph-version")).toBe("release");
  });

  it("renders the letter and plane when neither loader nor versionId is given", () => {
    render();
    expect(card().querySelector(".vx-instance-identity__plane")).not.toBeNull();
    expect(card().querySelector(".vx-instance-identity__letter")?.textContent).toBe("O");
    expect(card().querySelector(".vx-instance-glyph")).toBeNull();
  });

  it("marks the glyph face so the decorative tile and corner mark stay hidden", () => {
    render({ loader: "fabric", versionId: "24w14a" });
    const identity = card().querySelector(".vx-instance-identity")!;
    expect(identity.getAttribute("data-identity-face")).toBe("glyph");

    render();
    expect(card().querySelector(".vx-instance-identity")?.hasAttribute("data-identity-face")).toBe(false);
  });

  it("keeps the fallback letter hidden when the glyph is shown", () => {
    render({ loader: "fabric", versionId: "24w14a" });
    const identity = card().querySelector(".vx-instance-identity")!;
    expect(identity.querySelector(".vx-instance-glyph")).not.toBeNull();
    expect(identity.querySelector(".vx-instance-identity__letter")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps the icon decorative because the card text names version and loader", () => {
    render({ loader: "forge", versionId: "1.21.1" });
    const glyph = card().querySelector(".vx-instance-glyph")!;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(card().querySelector(".vx-instance-identity")?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.querySelector("title")).toBeNull();
  });

  it.each([
    ["vanilla", "1.21.1"],
    ["fabric", "1.21.1"],
    ["quilt", "1.21.1"],
    ["forge", "1.21.1"],
    ["neoforge", "1.21.1"],
    ["optifine", "1.21.1"],
    ["unknown", "1.21.1"],
  ] as const)("passes the %s loader to the glyph for its colour token", (loader, versionId) => {
    render({ loader, versionId });
    expect(card().querySelector(".vx-instance-glyph")?.getAttribute("data-glyph-loader")).toBe(loader);
  });

  it.each([
    ["1.21.1", "release"],
    ["24w14a", "snapshot"],
    ["b1.7.3", "old"],
  ] as const)("renders the %s version kind as a %s cube", (versionId, version) => {
    render({ loader: "vanilla", versionId });
    const glyph = card().querySelector(".vx-instance-glyph")!;
    expect(glyph.getAttribute("data-glyph-version")).toBe(version);
    const hasNotch = Boolean(glyph.querySelector(".vx-instance-glyph__notch"));
    expect(hasNotch).toBe(version === "snapshot");
  });
});

describe("loader recognition from version-folder ids", () => {
  it.each([
    { id: "26.2-fabric-0.19.3", loader: "fabric", version: "release" },
    { id: "1.21.1-fabric-0.19.3", loader: "fabric", version: "release" },
    { id: "fabric-loader-0.19.3-26.2", loader: "fabric", version: "release" },
    { id: "quilt-loader-0.26.4-1.21.1", loader: "quilt", version: "release" },
    { id: "1.21.1-quilt-0.26.4", loader: "quilt", version: "release" },
    { id: "1.20.1-forge-47.2.0", loader: "forge", version: "release" },
    { id: "1.21.1-neoforge-21.1.77", loader: "neoforge", version: "release" },
    { id: "neoforge-21.1.77", loader: "neoforge", version: "release" },
    { id: "1.20.4-OptiFine_HD_U_I7", loader: "optifine", version: "release" },
    { id: "1.21.1", loader: "vanilla", version: "release" },
  ])("shows $id as a $loader cube on an instance card", ({ id, loader, version }) => {
    render({ loader: null, versionId: id });
    expect(glyphAttributes(card())).toEqual({ loader, version });
  });

  it("uses the version id when a caller does not supply a loader family", () => {
    render({ loader: null, versionId: "26.2-fabric-0.19.3" });
    expect(glyphAttributes(card())).toEqual({ loader: "fabric", version: "release" });
  });

  it("recovers a known loader from the version id even when the family is unknown", () => {
    render({ loader: "liteloader", versionId: "1.21.1-fabric-0.19.3" });
    expect(glyphAttributes(card())).toEqual({ loader: "fabric", version: "release" });
  });
});

describe("glyph caller props", () => {
  it("keeps the same instance glyph on the card, detail page and back", () => {
    const expected = { loader: "fabric", version: "snapshot" };
    const instanceCard = <InstanceCard instance={glyphInstance} onOpen={() => {}} onLaunch={() => {}} />;
    renderNode(instanceCard);
    expect(glyphAttributes(container.querySelector(".vx-instance-card__select"))).toEqual(expected);
    renderNode(<InstanceDetailPage instance={glyphInstance} onBack={() => {}} onChanged={async () => {}} onLaunch={() => {}} />);
    expect(glyphAttributes(container.querySelector(".vx-detail-header"))).toEqual(expected);
    renderNode(instanceCard);
    expect(glyphAttributes(container.querySelector(".vx-instance-card__select"))).toEqual(expected);
  });

  it("keeps the same loader-profile instance glyph on the card, detail page and back", () => {
    const expected = { loader: "fabric", version: "snapshot" };
    const instanceCard = <InstanceCard instance={loaderVersion} onOpen={() => {}} onLaunch={() => {}} />;
    renderNode(instanceCard);
    expect(glyphAttributes(container.querySelector(".vx-instance-card__select"))).toEqual(expected);
    renderNode(<InstanceDetailPage instance={loaderVersion} onBack={() => {}} onChanged={async () => {}} onLaunch={() => {}} />);
    expect(glyphAttributes(container.querySelector(".vx-detail-header"))).toEqual(expected);
    renderNode(instanceCard);
    expect(glyphAttributes(container.querySelector(".vx-instance-card__select"))).toEqual(expected);
  });
});
