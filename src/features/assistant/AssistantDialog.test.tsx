// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { createLauncherI18n } from "../../i18n";
import { AssistantDialog } from "./AssistantDialog";
import type { AssistantStatus, AssistantTurnResponse, PendingToolCall } from "./types";

const commandMock = vi.mocked(command);

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));

let root: Root;
let container: HTMLDivElement;

function statusFixture(overrides: Partial<AssistantStatus> = {}): AssistantStatus {
  return {
    apiKeyConfigured: true,
    provider: "openai",
    baseUrl: "",
    effectiveBaseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    permission: "controlled",
    proactive: true,
    loopbackEndpoint: false,
    ready: true,
    mcp: { running: false, port: 25590, url: null, tokenMasked: null },
    tools: [
      { name: "list_instances", tier: "readOnly", description: "List registered instances." },
      { name: "update_instance_notes", tier: "controlled", description: "Update instance notes." },
    ],
    ...overrides,
  };
}

async function renderDialog(props: {
  onOpenChange?: (open: boolean) => void;
  onConfigure?: () => void;
  onMutated?: () => Promise<void>;
  wakeRequest?: { id: number; reason?: string; prompt?: string; autoSend?: boolean } | null;
  onConsumeWake?: () => void;
} = {}) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => {
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AssistantDialog, {
          open: true,
          onOpenChange: props.onOpenChange ?? vi.fn(),
          onConfigure: props.onConfigure ?? vi.fn(),
          onMutated: props.onMutated ?? vi.fn(async () => {}),
          wakeRequest: props.wakeRequest ?? null,
          onConsumeWake: props.onConsumeWake,
        }),
      ),
    );
  });
}

function buttonByText(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commandMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  vi.clearAllMocks();
});

describe("AssistantDialog", () => {
  it("shows unconfigured guidance and opens Assistant settings on Configure", async () => {
    commandMock.mockResolvedValueOnce(
      statusFixture({ apiKeyConfigured: false, model: "", ready: false }),
    );
    const onOpenChange = vi.fn();
    const onConfigure = vi.fn();
    await renderDialog({ onOpenChange, onConfigure });

    expect(document.body.textContent).toContain("Model not configured");
    expect(buttonByText("Send").disabled).toBe(true);
    await act(async () => buttonByText("Configure").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it("sums up provider, model and permission in one meta line and keeps a badge only for warnings", async () => {
    commandMock.mockResolvedValueOnce(statusFixture());
    await renderDialog();
    const summary = document.querySelector<HTMLElement>(".vx-assistant-bar .vx-assistant-summary")!;
    expect([...summary.children].map((part) => part.textContent)).toEqual([
      "OpenAI-compatible",
      "gpt-4o-mini",
      "Controlled",
      "2 tools",
    ]);
    expect(document.querySelector(".vx-assistant-pill")).toBeNull();
    expect(document.querySelector(".vx-assistant-warning")).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    commandMock.mockResolvedValueOnce(statusFixture({ model: "", ready: false }));
    await renderDialog();
    const warning = document.querySelector<HTMLElement>(".vx-assistant-bar .vx-assistant-warning")!;
    expect(warning.textContent).toBe("Model not configured");
    expect(warning.querySelector("svg")).not.toBeNull();
  });

  it("handles tool traces and Controlled-mode approval confirmation", async () => {
    const onMutated = vi.fn(async () => {});
    const notesCall: PendingToolCall = {
      id: "call_write_1",
      name: "update_instance_notes",
      arguments: { instanceId: "inst-1", notes: "Modded 1.21" },
      description: "Update the notes and/or category metadata of a registered instance.",
      details: [
        { field: "instance", value: "Fabric Test · 1.21.1 · fabric 0.16.5", unresolved: false },
        { field: "notes", value: "Modded 1.21", unresolved: false },
      ],
      unresolved: false,
      reason: "controlled",
    };
    const pendingTurn: AssistantTurnResponse = {
      reply: "I can update the instance notes for you.",
      traces: [
        {
          id: "t1",
          name: "list_instances",
          arguments: {},
          tier: "readOnly",
          status: "executed",
          summary: "{\"count\":1}",
        },
      ],
      pendingApprovals: [notesCall],
      continuation: {
        provider: "openai",
        providerMessages: [],
        completedResults: [],
        pendingCalls: [notesCall],
        round: 0,
      },
      model: "gpt-4o-mini",
      provider: "openai",
    };
    const approvedTurn: AssistantTurnResponse = {
      reply: "Updated notes for Fabric Test.",
      traces: [
        {
          id: "call_write_1",
          name: "update_instance_notes",
          arguments: { instanceId: "inst-1", notes: "Modded 1.21" },
          tier: "controlled",
          status: "approved",
          summary: "{\"notes\":\"Modded 1.21\"}",
        },
      ],
      pendingApprovals: [],
      continuation: null,
      model: "gpt-4o-mini",
      provider: "openai",
    };

    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_assistant_status") return statusFixture();
      if (name === "assistant_chat") {
        const req = (args as { request?: { approvedCallIds?: string[] } })?.request;
        return req?.approvedCallIds?.length ? approvedTurn : pendingTurn;
      }
      return null;
    });

    await renderDialog({ onMutated });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message for Lumen"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Add a note to my instance",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonByText("Send").click());

    expect(document.body.textContent).toContain("List instances");
    expect(document.body.textContent).toContain("Approve Lumen action");
    expect(document.body.textContent).toContain("Update instance notes");
    expect(document.body.textContent).not.toContain("list_instances");
    expect(onMutated).not.toHaveBeenCalled();

    // Resolved details come first with translated labels; raw arguments stay in a closed disclosure.
    const card = document.querySelector<HTMLElement>('[data-testid="lumen-approval"]')!;
    const rows = [...card.querySelectorAll(".vx-assistant-approval__details > div")].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);
    expect(rows).toEqual([
      ["Instance", "Fabric Test · 1.21.1 · fabric 0.16.5"],
      ["Notes", "Modded 1.21"],
    ]);
    const technical = card.querySelector<HTMLDetailsElement>("details.vx-assistant-approval__technical")!;
    expect(technical.open).toBe(false);
    expect(technical.querySelector("summary")?.textContent).toBe("Technical details");
    expect(technical.textContent).toContain("instanceId");
    // The raw tool identifier moves out of the heading into the technical disclosure.
    expect(card.querySelector(".vx-assistant-approval__head")?.textContent).toBe("Update instance notes");
    expect(technical.querySelector(".vx-assistant-approval__tool-id")?.textContent).toBe("update_instance_notes");
    expect(document.querySelector(".vx-assistant-trace .vx-assistant-trace__name")?.getAttribute("title")).toBe("list_instances");
    expect(card.querySelector('[role="note"]')).toBeNull();
    expect(card.querySelector('input[type="checkbox"]')).toBeNull();

    // Focus lands on the card heading so a stray Enter or Space cannot approve.
    const heading = card.querySelector("h3")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
    expect(card.getAttribute("role")).toBe("region");
    expect(card.getAttribute("aria-labelledby")).toBe(heading.id);

    await act(async () => buttonByText("Approve & run").click());
    expect(commandMock).toHaveBeenLastCalledWith("assistant_chat", {
      request: expect.objectContaining({
        approvedCallIds: ["call_write_1"],
        deniedCallIds: [],
      }),
    });
    expect(document.body.textContent).toContain("Updated notes for Fabric Test.");
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it("displays proactive wake banner and auto-sends crash diagnostic prompt once", async () => {
    const onConsumeWake = vi.fn();
    commandMock.mockImplementation(async (name) => {
      if (name === "get_assistant_status") return statusFixture();
      if (name === "assistant_chat") {
        return {
          reply: "Crash caused by missing Fabric API dependency.",
          traces: [],
          pendingApprovals: [],
          continuation: null,
          model: "gpt-4o-mini",
          provider: "openai",
        } satisfies AssistantTurnResponse;
      }
      return null;
    });
    await renderDialog({
      wakeRequest: {
        id: 1,
        reason: "Lumen woke automatically: Modded 1.21 exited abnormally (exit code 1).",
        prompt: "Diagnose the crash for Modded 1.21",
        autoSend: true,
      },
      onConsumeWake,
    });
    expect(document.querySelector('[data-testid="lumen-wake-banner"]')?.textContent).toContain("exit code 1");
    expect(onConsumeWake).toHaveBeenCalledTimes(1);
    expect(commandMock).toHaveBeenCalledWith("assistant_chat", {
      request: { messages: [{ role: "user", content: "Diagnose the crash for Modded 1.21" }], wake: true },
    });
    expect(document.body.textContent).toContain("Crash caused by missing Fabric API dependency.");
  });

  it("lets the user allow calls one by one and sends the rest as denied", async () => {
    const call = (id: string, name: string, overrides: Partial<PendingToolCall> = {}): PendingToolCall => ({
      id,
      name,
      arguments: { instanceId: "inst-1" },
      description: "",
      details: [{ field: "instance", value: "Fabric Test · 1.21.1", unresolved: false }],
      unresolved: false,
      reason: "alwaysAsk",
      ...overrides,
    });
    const calls = [
      call("c_install", "install_modrinth_resource", {
        details: [
          { field: "instance", value: "Fabric Test · 1.21.1", unresolved: false },
          { field: "project", value: "Sodium (sodium)", unresolved: false },
          { field: "resourceVersion", value: "Totally Sodium (9.9.9)", unresolved: true },
        ],
        unresolved: true,
      }),
      call("c_save", "save_multiplayer_server"),
      call("c_loader", "change_instance_loader"),
    ];
    const pendingTurn: AssistantTurnResponse = {
      reply: "These need your approval.",
      traces: [],
      pendingApprovals: calls,
      continuation: { provider: "openai", providerMessages: [], completedResults: [], pendingCalls: calls, round: 0 },
      model: "gpt-4o-mini",
      provider: "openai",
    };
    const doneTurn: AssistantTurnResponse = {
      reply: "Saved the server only.",
      traces: [],
      pendingApprovals: [],
      continuation: null,
      model: "gpt-4o-mini",
      provider: "openai",
    };
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_assistant_status") return statusFixture({ permission: "fullAccess" });
      if (name === "assistant_chat") {
        const req = (args as { request?: { pendingContinuation?: unknown } })?.request;
        return req?.pendingContinuation ? doneTurn : pendingTurn;
      }
      return null;
    });

    await renderDialog();
    await act(async () => buttonByText("List my running games and managed servers.").click());

    const card = document.querySelector<HTMLElement>('[data-testid="lumen-approval"]')!;
    expect(card.textContent).toContain("Full access still asks before these actions.");
    expect(card.textContent).toContain("This kind of action always asks first.");
    expect(document.activeElement).toBe(card.querySelector("h3"));
    expect([...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Approve & run")).toBe(false);

    const install = card.querySelector<HTMLElement>('[data-call-id="c_install"]')!;
    expect(install.querySelector('[role="note"]')?.textContent).toBe(
      "Some details could not be confirmed. Check the technical details before you approve.",
    );
    const flagged = install.querySelector('[data-unresolved="true"]')!;
    expect(flagged.querySelector("dt")?.textContent).toBe("Version");
    expect(flagged.textContent).toContain("not confirmed");
    expect(card.querySelector('[data-call-id="c_save"] [role="note"]')).toBeNull();

    const boxes = [...card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    expect(buttonByText("Run allowed").disabled).toBe(true);

    const saveBox = card.querySelector<HTMLInputElement>('[data-call-id="c_save"] input[type="checkbox"]')!;
    await act(async () => saveBox.click());
    expect(saveBox.checked).toBe(true);
    expect(buttonByText("Run allowed").disabled).toBe(false);

    await act(async () => buttonByText("Run allowed").click());
    expect(commandMock).toHaveBeenLastCalledWith("assistant_chat", {
      request: expect.objectContaining({
        approvedCallIds: ["c_save"],
        deniedCallIds: ["c_install", "c_loader"],
      }),
    });
    expect(document.body.textContent).toContain("Saved the server only.");
  });

  it("denies every pending call with Deny all and never sends a wake flag for typed prompts", async () => {
    const calls: PendingToolCall[] = ["a", "b"].map((id) => ({
      id,
      name: "update_instance_notes",
      arguments: { instanceId: "inst-1", notes: id },
      description: "",
      details: [],
      unresolved: false,
      reason: "limit",
    }));
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_assistant_status") return statusFixture({ permission: "fullAccess" });
      if (name === "assistant_chat") {
        const req = (args as { request?: { pendingContinuation?: unknown } })?.request;
        return {
          reply: req?.pendingContinuation ? "Nothing changed." : "More changes need approval.",
          traces: [],
          pendingApprovals: req?.pendingContinuation ? [] : calls,
          continuation: req?.pendingContinuation
            ? null
            : { provider: "openai", providerMessages: [], completedResults: [], pendingCalls: calls, round: 1 },
          model: "gpt-4o-mini",
          provider: "openai",
        } satisfies AssistantTurnResponse;
      }
      return null;
    });

    await renderDialog({ wakeRequest: { id: 7, reason: "Check this", prompt: "Look at my crash", autoSend: false } });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message for Lumen"]')!;
    expect(textarea.value).toBe("Look at my crash");
    await act(async () => buttonByText("Send").click());
    expect(commandMock).toHaveBeenCalledWith("assistant_chat", {
      request: { messages: [{ role: "user", content: "Look at my crash" }] },
    });
    expect(document.body.textContent).toContain("Lumen already made several changes for this message");

    await act(async () => buttonByText("Deny all").click());
    expect(commandMock).toHaveBeenLastCalledWith("assistant_chat", {
      request: expect.objectContaining({ approvedCallIds: [], deniedCallIds: ["a", "b"] }),
    });
    const lastRequest = (commandMock.mock.lastCall?.[1] as { request: Record<string, unknown> }).request;
    expect(lastRequest).not.toHaveProperty("wake");
    expect(document.body.textContent).toContain("Nothing changed.");
  });

  it("labels every instance setting and retried task on a card and shows a cleared value", async () => {
    const calls: PendingToolCall[] = [
      {
        id: "c_settings",
        name: "update_instance_settings",
        arguments: { instanceId: "inst-1", notes: "", maxMemoryMb: 4096, gameProxyMode: "off", resetRuntime: true },
        description: "",
        details: [
          { field: "instance", value: "Fabric Test · 1.21.1", unresolved: false },
          { field: "notes", value: "", unresolved: false },
          { field: "maxMemory", value: "4096 MB", unresolved: false },
          { field: "gameProxyMode", value: "off", unresolved: false },
          { field: "resetRuntime", value: "true", unresolved: false },
        ],
        unresolved: false,
        reason: "controlled",
      },
      {
        id: "c_retry",
        name: "retry_failed_downloads",
        arguments: {},
        description: "",
        details: [
          { field: "retryCount", value: "1", unresolved: false },
          { field: "retryTask", value: "resource · Sodium", unresolved: false },
        ],
        unresolved: false,
        reason: "alwaysAsk",
      },
    ];
    commandMock.mockImplementation(async (name) => {
      if (name === "get_assistant_status") return statusFixture();
      if (name === "assistant_chat") {
        return {
          reply: "These need your approval.",
          traces: [],
          pendingApprovals: calls,
          continuation: { provider: "openai", providerMessages: [], completedResults: [], pendingCalls: calls, round: 0 },
          model: "gpt-4o-mini",
          provider: "openai",
        } satisfies AssistantTurnResponse;
      }
      return null;
    });

    await renderDialog();
    await act(async () => buttonByText("List my running games and managed servers.").click());

    const rows = (id: string) =>
      [...document.querySelectorAll(`[data-call-id="${id}"] .vx-assistant-approval__details > div`)].map((row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector("dd")?.textContent,
      ]);
    expect(rows("c_settings")).toEqual([
      ["Instance", "Fabric Test · 1.21.1"],
      ["Notes", "(empty)"],
      ["Maximum memory", "4096 MB"],
      ["Game network proxy", "off"],
      ["Reset memory, Java, JVM arguments, window size and proxy", "true"],
    ]);
    expect(rows("c_retry")).toEqual([
      ["Failed tasks to retry", "1"],
      ["Retry", "resource · Sodium"],
    ]);
  });

  it("renders localized Lumen errors cleanly", async () => {
    commandMock.mockImplementation(async (name) => {
      if (name === "get_assistant_status") return statusFixture();
      if (name === "assistant_chat") throw new LauncherError("assistant.apiKeyRequired");
      return null;
    });
    await renderDialog();
    await act(async () => buttonByText("Summarize my instances and installed versions.").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Save your own AI API key in Settings → Lumen & MCP first.",
    );
  });
});
