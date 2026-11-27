// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { GlassProvider } from "../../visual/glass/GlassSystem";
import { command, defaults, events, type Account, type Bootstrap } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { createLauncherI18n } from "../../i18n";
import { MultiplayerPage } from "./MultiplayerPage";
import type { NetworkCheckReport } from "./useMultiplayer";

const commandMock = vi.mocked(command);
const eventsMock = vi.mocked(events);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let mockReport: NetworkCheckReport;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const account: Account = {
  id: "fixture-account",
  username: "Fixture",
  uuid: "11111111111111111111111111111111",
  type: "microsoft",
  isSelected: true,
};

function makeLauncher(): LauncherContextValue {
  const data: Bootstrap = {
    config: { ...defaults },
    accounts: [account],
    instances: [],
    installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 }],
    capabilities: {},
  };
  return {
    bootstrapped: true,
    data,
    config: data.config,
    manifest: { latestRelease: "1.21.1", latestSnapshot: "", versions: [{ id: "1.21.1", type: "release", releaseTime: "", url: "" }] },
    activeAccount: account,
    accountAppearance: { profile: null, setProfile: vi.fn(), skinUrl: undefined, model: "auto", capeUrl: undefined, hasAccountSkin: false, loading: false, error: "", refresh: vi.fn() },
    selectedInstance: undefined,
    selectedVersion: data.installedVersions[0],
    selectedVersionId: "1.21.1",
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
    saveConfig: vi.fn(async (next) => next),
    setTourCompleted: vi.fn(async (completed) => ({ ...defaults, tourCompleted: completed })),
    setConfig: vi.fn(),
    selectInstance: vi.fn(),
    selectVersion: vi.fn(),
    launch: vi.fn(async () => {}),
    launchMultiplayer: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancelPreparation: vi.fn(async () => {}),
    run: vi.fn(async (_key, action) => action()),
    dismissNotice: vi.fn(),
  };
}

async function renderPage() {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(MultiplayerPage)))));
}

function findButton(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((btn) => btn.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = makeLauncher();
  mockReport = {
    checkedAt: "2026-11-25T08:00:00Z",
    ipv4: {
      available: true,
      localIp: "192.168.1.25",
      publicIp: "198.51.100.42",
      localPort: 50000,
      mappedPort: 61234,
      probesSucceeded: 2,
      rttMs: 24,
    },
    ipv6: {
      status: "globalPublic",
      localIp: "2409:8a00:1234::42",
      publicIp: "2409:8a00:1234::42",
      mappedPort: 50001,
      probesSucceeded: 2,
      rttMs: 19,
    },
    natType: "endpointIndependent",
    cgnatSuspected: false,
    directConnectIpv4: "198.51.100.42:25565",
    directConnectIpv6: "[2409:8a00:1234::42]:25565",
    stunHostsQueried: ["stun.cloudflare.com:3478", "stun.miwifi.com:3478"],
    advice: [
      { code: "ipv6DirectReady", severity: "good" },
      { code: "ipv4ConeForward", severity: "info" },
    ],
  };
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => {
    if (name === "list_servers") return [];
    if (name === "list_managed_servers") return [];
    if (name === "check_network_environment") return mockReport;
    return null;
  });
  eventsMock.mockReset();
  eventsMock.mockResolvedValue(() => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("NetworkCheckPanel", () => {
  it("does not probe STUN automatically until the user clicks Run network check", async () => {
    await renderPage();
    await act(async () => findButton("Network check").click());
    expect(commandMock).not.toHaveBeenCalledWith("check_network_environment");
    expect(container.textContent).toContain("Ready to check your network");
    expect(container.textContent).toContain("stun.cloudflare.com");

    await act(async () => findButton("Run network check").click());
    expect(commandMock).toHaveBeenCalledWith("check_network_environment");
    expect(container.textContent).toContain("198.51.100.42");
    expect(container.textContent).toContain("2409:8a00:1234::42");
    expect(container.textContent).toContain("Cone NAT");
    expect(container.textContent).toContain("Global public IPv6");
    expect(container.textContent).toContain("[2409:8a00:1234::42]:25565");
    expect(container.textContent).toContain("198.51.100.42:25565");
  });

  it("reformats direct-connect addresses when the port changes and copies them", async () => {
    await renderPage();
    await act(async () => findButton("Network check").click());
    await act(async () => findButton("Run network check").click());

    const portInput = container.querySelector<HTMLInputElement>('input[aria-label="Direct-connect port"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(portInput, "25570");
      portInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("[2409:8a00:1234::42]:25570");
    expect(container.textContent).toContain("198.51.100.42:25570");

    const copyButtons = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .filter((btn) => btn.textContent?.trim() === "Copy");
    expect(copyButtons).toHaveLength(2);
    await act(async () => copyButtons[0].click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("[2409:8a00:1234::42]:25570");
    expect(container.textContent).toContain("Copied");
  });

  it("shows a tunnel warning and no direct address when a TUN handles the probes", async () => {
    mockReport = {
      ...mockReport,
      natType: "proxied",
      directConnectIpv4: null,
      directConnectIpv6: null,
      advice: [
        { code: "ipv6Unavailable", severity: "info" },
        { code: "ipv4TunnelDetected", severity: "warn" },
      ],
    };
    await renderPage();
    await act(async () => findButton("Network check").click());
    await act(async () => findButton("Run network check").click());

    expect(container.textContent).toContain("Proxy / VPN tunnel");
    expect(container.textContent).toContain("A local proxy or VPN tunnel (TUN mode) appears");
    expect(container.querySelector(".vx-network-addresses")).toBeNull();
  });

  it("shows symmetric NAT and CGNAT warnings without fabricating direct IPv4", async () => {
    mockReport = {
      ...mockReport,
      natType: "addressPortDependent",
      cgnatSuspected: true,
      directConnectIpv4: null,
      directConnectIpv6: null,
      ipv6: { status: "unavailable", localIp: null, publicIp: null, mappedPort: null, probesSucceeded: 0, rttMs: null },
      advice: [
        { code: "ipv6Unavailable", severity: "info" },
        { code: "ipv4SymmetricWarn", severity: "warn" },
        { code: "ipv4CgnatDetected", severity: "warn" },
      ],
    };
    await renderPage();
    await act(async () => findButton("Network check").click());
    await act(async () => findButton("Run network check").click());

    expect(container.textContent).toContain("Symmetric NAT");
    expect(container.textContent).toContain("Carrier-grade NAT (100.64.0.0/10)");
    expect(container.querySelector(".vx-network-addresses")).toBeNull();
  });

  it("explains differing egress IPs without calling them a tunnel", async () => {
    mockReport = {
      ...mockReport,
      natType: "addressPortDependent",
      directConnectIpv4: null,
      directConnectIpv6: null,
      advice: [
        { code: "ipv6Unavailable", severity: "info" },
        { code: "ipv4SymmetricWarn", severity: "warn" },
        { code: "ipv4MixedEgress", severity: "info" },
      ],
    };
    await renderPage();
    await act(async () => findButton("Network check").click());
    await act(async () => findButton("Run network check").click());

    expect(container.textContent).toContain("The STUN servers saw different public IPv4 addresses.");
    expect(container.textContent).not.toContain("Proxy / VPN tunnel");
    expect(container.querySelector(".vx-network-addresses")).toBeNull();
  });
});
