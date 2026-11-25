// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { createLauncherI18n } from "../../i18n";
import { AssistantDialog } from "./AssistantDialog";
import type { AssistantStatus, AssistantTurnResponse } from "./types";

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

  it("handles tool traces and Controlled-mode approval confirmation", async () => {
    const onMutated = vi.fn(async () => {});
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
      pendingApprovals: [
        {
          id: "call_write_1",
          name: "update_instance_notes",
          arguments: { instanceId: "inst-1", notes: "Modded 1.21" },
          description: "Update the notes and/or category metadata of a registered instance.",
        },
      ],
      continuation: {
        provider: "openai",
        providerMessages: [],
        completedResults: [],
        pendingCalls: [
          {
            id: "call_write_1",
            name: "update_instance_notes",
            arguments: { instanceId: "inst-1", notes: "Modded 1.21" },
            description: "Update the notes and/or category metadata of a registered instance.",
          },
        ],
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

    expect(document.body.textContent).toContain("list_instances");
    expect(document.body.textContent).toContain("Approve Lumen action");
    expect(document.body.textContent).toContain("update_instance_notes");
    expect(onMutated).not.toHaveBeenCalled();

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
      request: { messages: [{ role: "user", content: "Diagnose the crash for Modded 1.21" }] },
    });
    expect(document.body.textContent).toContain("Crash caused by missing Fabric API dependency.");
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
