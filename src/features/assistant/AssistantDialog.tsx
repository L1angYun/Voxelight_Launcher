import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Send, Settings, Trash2, X } from "lucide-react";
import { command } from "../../lib/launcher";
import { normalizeError, type LauncherError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import type {
  AssistantStatus,
  AssistantTurnResponse,
  ChatMessage,
  PendingContinuation,
  PendingToolCall,
  ToolTraceItem,
} from "./types";
import "./assistant.css";

interface TranscriptEntry extends ChatMessage {
  id: string;
  traces?: ToolTraceItem[];
}

export function AssistantDialog({
  open,
  onOpenChange,
  onConfigure,
  onMutated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigure: () => void;
  onMutated: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LauncherError | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolCall[]>([]);
  const [continuation, setContinuation] = useState<PendingContinuation | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const next = await command<AssistantStatus>("get_assistant_status");
      setStatus(next);
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }, []);

  useEffect(() => {
    if (open) void loadStatus();
  }, [open, loadStatus]);

  function errorMessage(cause: LauncherError): string {
    const key = [
      `shell:errors.${cause.code}`,
      `settings:errors.${cause.code}`,
    ].find((candidate) => i18n.exists(candidate));
    if (key) {
      const translated = t(key, cause.params);
      if (cause.code === "assistant.providerError" && cause.detail) {
        return `${translated} (${cause.detail})`;
      }
      return translated;
    }
    return cause.detail || t("common:errors.internalUnexpected");
  }

  function applyResponse(response: AssistantTurnResponse) {
    const assistantText = response.reply.trim();
    if (assistantText || response.traces.length > 0) {
      setEntries((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}-${current.length}`,
          role: "assistant",
          content: assistantText,
          traces: response.traces,
        },
      ]);
    }
    setPendingApprovals(response.pendingApprovals);
    setContinuation(response.continuation);
    if (response.traces.some((item) => item.tier === "controlled" && (item.status === "approved" || item.status === "executed"))) {
      void onMutated();
    }
  }

  async function sendPrompt(rawPrompt: string) {
    const content = rawPrompt.trim();
    if (!content || busy || pendingApprovals.length > 0) return;
    setError(null);
    const nextUser: TranscriptEntry = {
      id: `user-${Date.now()}-${entries.length}`,
      role: "user",
      content,
    };
    const nextEntries = [...entries, nextUser];
    setEntries(nextEntries);
    setInput("");
    setBusy(true);
    try {
      const messages: ChatMessage[] = nextEntries
        .filter((item) => item.content.trim().length > 0)
        .map(({ role, content: text }) => ({ role, content: text }));
      const response = await command<AssistantTurnResponse>("assistant_chat", {
        request: { messages },
      });
      applyResponse(response);
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resolveApprovals(approve: boolean) {
    if (!continuation || busy) return;
    setError(null);
    setBusy(true);
    const ids = pendingApprovals.map((item) => item.id);
    try {
      const messages: ChatMessage[] = entries
        .filter((item) => item.content.trim().length > 0)
        .map(({ role, content: text }) => ({ role, content: text }));
      const response = await command<AssistantTurnResponse>("assistant_chat", {
        request: {
          messages,
          approvedCallIds: approve ? ids : [],
          deniedCallIds: approve ? [] : ids,
          pendingContinuation: continuation,
        },
      });
      applyResponse(response);
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void sendPrompt(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendPrompt(input);
    }
  }

  function clearConversation() {
    setEntries([]);
    setPendingApprovals([]);
    setContinuation(null);
    setError(null);
  }

  const quickPrompts = [
    t("shell:assistant.prompts.instances"),
    t("shell:assistant.prompts.resources"),
    t("shell:assistant.prompts.servers"),
  ];

  const permissionLabel = status
    ? t(`settings:assistant.permissions.${status.permission}`)
    : t("settings:assistant.permissions.readOnly");

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("shell:assistant.title")}
      description={t("shell:assistant.description")}
      closeLabel={t("common:a11y.closeDialog")}
      className="vx-assistant-dialog"
    >
      <div className="vx-assistant-shell" data-testid="assistant-dialog-body">
        <div className="vx-assistant-bar">
          <div className="vx-assistant-meta">
            <span className="vx-assistant-pill">
              {status
                ? t(`settings:assistant.providers.${status.provider}`)
                : t("settings:assistant.providers.openai")}
            </span>
            {status?.model ? (
              <span className="vx-assistant-pill">{status.model}</span>
            ) : (
              <span className="vx-assistant-pill vx-assistant-pill--warn">
                {t("shell:assistant.notConfigured")}
              </span>
            )}
            <span className="vx-assistant-pill">{permissionLabel}</span>
          </div>
          <Button
            variant="ghost"
            icon={<Settings size={14} />}
            onClick={() => {
              onOpenChange(false);
              onConfigure();
            }}
          >
            {t("shell:assistant.configure")}
          </Button>
        </div>

        <div className="vx-assistant-transcript" aria-live="polite">
          {entries.length === 0 ? (
            <div className="vx-assistant-empty">
              <p>
                {status?.ready
                  ? t("shell:assistant.emptyReady")
                  : t("shell:assistant.emptyUnconfigured")}
              </p>
              <div className="vx-assistant-prompts">
                {quickPrompts.map((prompt) => (
                  <Button
                    key={prompt}
                    variant="secondary"
                    disabled={busy || !status?.ready}
                    onClick={() => void sendPrompt(prompt)}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            entries.map((entry) => (
              <article
                key={entry.id}
                className={`vx-assistant-message vx-assistant-message--${entry.role}`}
              >
                <span className="vx-assistant-message__role">
                  {entry.role === "user"
                    ? t("shell:assistant.roleUser")
                    : t("shell:assistant.roleAssistant")}
                </span>
                {entry.traces && entry.traces.length > 0 ? (
                  <ul className="vx-assistant-traces" aria-label={t("shell:assistant.toolActivity")}>
                    {entry.traces.map((trace) => (
                      <li className="vx-assistant-trace" key={`${entry.id}-${trace.id}`}>
                        <span className="vx-assistant-trace__name">{trace.name}</span>
                        <span className="vx-assistant-trace__status">
                          {t(`shell:assistant.traceStatus.${trace.status}`)}
                        </span>
                        <span className="vx-assistant-trace__summary">{trace.summary}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {entry.content ? (
                  <p className="vx-assistant-message__body">{entry.content}</p>
                ) : null}
              </article>
            ))
          )}

          {pendingApprovals.length > 0 ? (
            <section className="vx-assistant-approval" aria-label={t("shell:assistant.approvalTitle")}>
              <h3>{t("shell:assistant.approvalTitle")}</h3>
              <p>{t("shell:assistant.approvalDescription")}</p>
              <ul className="vx-assistant-approval__list">
                {pendingApprovals.map((call) => (
                  <li className="vx-assistant-approval__item" key={call.id}>
                    <span className="vx-assistant-trace__name">{call.name}</span>
                    {call.description ? <p>{call.description}</p> : null}
                    <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
                  </li>
                ))}
              </ul>
              <div className="vx-action-row">
                <Button
                  variant="primary"
                  icon={<Check size={14} />}
                  loading={busy}
                  onClick={() => void resolveApprovals(true)}
                >
                  {t("shell:assistant.approveAction")}
                </Button>
                <Button
                  variant="secondary"
                  icon={<X size={14} />}
                  disabled={busy}
                  onClick={() => void resolveApprovals(false)}
                >
                  {t("shell:assistant.denyAction")}
                </Button>
              </div>
            </section>
          ) : null}
        </div>

        <form className="vx-assistant-composer" onSubmit={handleSubmit}>
          {error ? <p className="vx-assistant-error" role="alert">{errorMessage(error)}</p> : null}
          <textarea
            aria-label={t("shell:assistant.inputLabel")}
            placeholder={
              status?.ready
                ? t("shell:assistant.inputPlaceholder")
                : t("shell:assistant.inputUnconfiguredPlaceholder")
            }
            value={input}
            disabled={busy || pendingApprovals.length > 0}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="vx-assistant-composer__actions">
            <Button
              variant="ghost"
              icon={<Trash2 size={14} />}
              disabled={busy || (entries.length === 0 && pendingApprovals.length === 0)}
              onClick={clearConversation}
            >
              {t("shell:assistant.clear")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={<Send size={14} />}
              loading={busy}
              disabled={!input.trim() || pendingApprovals.length > 0 || !status?.ready}
            >
              {t("shell:assistant.send")}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
