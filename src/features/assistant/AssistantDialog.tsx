import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Send, Settings, Sparkles, Trash2, X } from "lucide-react";
import { command } from "../../lib/launcher";
import { normalizeError, type LauncherError } from "../../lib/errors";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useLumen, type LumenWakeRequest } from "./LumenContext";
import type {
  ApprovalDetailField,
  AssistantStatus,
  AssistantTurnRequest,
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

function formatArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function AssistantDialog({
  open,
  onOpenChange,
  onConfigure,
  onMutated,
  wakeRequest,
  onConsumeWake,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigure: () => void;
  onMutated: () => Promise<void>;
  wakeRequest?: LumenWakeRequest | null;
  onConsumeWake?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { managed, status: contextStatus, refreshStatus } = useLumen();
  const [localStatus, setLocalStatus] = useState<AssistantStatus | null>(null);
  const status = managed ? contextStatus : localStatus;
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LauncherError | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingToolCall[]>([]);
  const [allowedIds, setAllowedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [continuation, setContinuation] = useState<PendingContinuation | null>(null);
  const [wakeReason, setWakeReason] = useState<string | null>(null);
  const entriesRef = useRef<TranscriptEntry[]>(entries);
  entriesRef.current = entries;
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const handledWakeId = useRef<number>(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const approvalHeadingRef = useRef<HTMLHeadingElement>(null);
  const approvalBaseId = useId();
  const prevBusyRef = useRef(false);
  const prevPendingCountRef = useRef(0);
  const prevProviderRef = useRef<string | undefined>(status?.provider);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (status?.provider && prevProviderRef.current && status.provider !== prevProviderRef.current) {
      setPendingApprovals([]);
      setAllowedIds(new Set());
      setContinuation(null);
    }
    if (status?.provider) {
      prevProviderRef.current = status.provider;
    }
  }, [status?.provider]);

  useEffect(() => {
    if (open) {
      let active = true;
      if (managed) {
        void refreshStatus();
      } else {
        // Standalone usage (e.g. unit tests outside LumenProvider) fetches status directly.
        void command<AssistantStatus>("get_assistant_status")
          .then((fallback) => { if (active && fallback) setLocalStatus(fallback); })
          .catch((cause) => { if (active) setError(normalizeError(cause)); });
      }
      return () => { active = false; };
    } else {
      setWakeReason(null);
    }
  }, [open, managed, refreshStatus]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !open) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, pendingApprovals.length, busy, open]);

  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    const prevPending = prevPendingCountRef.current;
    prevBusyRef.current = busy;
    prevPendingCountRef.current = pendingApprovals.length;
    if (!open || busy) return;
    if (pendingApprovals.length > 0 && (wasBusy || prevPending === 0)) {
      // Focus the card heading, never an action button, so a stray key press cannot approve.
      approvalHeadingRef.current?.focus();
    } else if (wasBusy && pendingApprovals.length === 0) {
      textareaRef.current?.focus();
    }
  }, [open, busy, pendingApprovals.length]);

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

  const applyResponse = useCallback(async (response: AssistantTurnResponse) => {
    if (!mountedRef.current) return;
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
    setAllowedIds(new Set());
    setContinuation(response.continuation);
    if (response.traces.some((item) => item.tier === "controlled" && (item.status === "approved" || item.status === "executed"))) {
      try {
        await onMutated();
      } catch (cause) {
        if (mountedRef.current) setError(normalizeError(cause));
      }
    }
  }, [onMutated]);

  const sendPrompt = useCallback(async (rawPrompt: string, options: { wake?: boolean } = {}) => {
    const content = rawPrompt.trim();
    if (!content || inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    const currentEntries = entriesRef.current;
    const nextUser: TranscriptEntry = {
      id: `user-${Date.now()}-${currentEntries.length}`,
      role: "user",
      content,
    };
    const nextEntries = [...currentEntries, nextUser];
    entriesRef.current = nextEntries;
    setEntries(nextEntries);
    setInput("");
    setBusy(true);
    try {
      const messages: ChatMessage[] = nextEntries
        .filter((item) => item.content.trim().length > 0)
        .map(({ role, content: text }) => ({ role, content: text }));
      const request: AssistantTurnRequest = options.wake ? { messages, wake: true } : { messages };
      const response = await command<AssistantTurnResponse>("assistant_chat", { request });
      await applyResponse(response);
    } catch (cause) {
      if (mountedRef.current) setError(normalizeError(cause));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    if (!open || !wakeRequest || handledWakeId.current === wakeRequest.id) return;
    if (!status?.ready) return;
    handledWakeId.current = wakeRequest.id;
    setWakeReason(wakeRequest.reason ?? null);
    onConsumeWake?.();
    if (wakeRequest.prompt) {
      if (wakeRequest.autoSend && !busy && pendingApprovals.length === 0) {
        // A prompt the launcher sends by itself runs as a read-only wake turn.
        void sendPrompt(wakeRequest.prompt, { wake: true });
      } else {
        setInput(wakeRequest.prompt);
      }
    }
  }, [open, wakeRequest, status?.ready, busy, pendingApprovals.length, onConsumeWake, sendPrompt]);

  async function resolveApprovals(approvedIds: readonly string[]) {
    if (!continuation || inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setBusy(true);
    const ids = pendingApprovals.map((item) => item.id);
    const approved = new Set(approvedIds);
    try {
      const messages: ChatMessage[] = entriesRef.current
        .filter((item) => item.content.trim().length > 0)
        .map(({ role, content: text }) => ({ role, content: text }));
      const request: AssistantTurnRequest = {
        messages,
        approvedCallIds: ids.filter((id) => approved.has(id)),
        deniedCallIds: ids.filter((id) => !approved.has(id)),
        pendingContinuation: continuation,
      };
      const response = await command<AssistantTurnResponse>("assistant_chat", { request });
      await applyResponse(response);
    } catch (cause) {
      if (mountedRef.current) setError(normalizeError(cause));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || pendingApprovals.length > 0) return;
    void sendPrompt(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (busy || pendingApprovals.length > 0) return;
      void sendPrompt(input);
    }
  }

  function toggleAllowed(id: string, allowed: boolean) {
    setAllowedIds((current) => {
      const next = new Set(current);
      if (allowed) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function detailLabel(field: ApprovalDetailField): string {
    const key = `shell:assistant.approvalFields.${field}`;
    return i18n.exists(key) ? t(key) : field;
  }

  function reasonNote(call: PendingToolCall): string | null {
    if (call.reason === "alwaysAsk") return t("shell:assistant.approvalReason.alwaysAsk");
    if (call.reason === "limit") return t("shell:assistant.approvalReason.limit");
    return null;
  }

  function clearConversation() {
    entriesRef.current = [];
    setEntries([]);
    setPendingApprovals([]);
    setAllowedIds(new Set());
    setContinuation(null);
    setError(null);
    setWakeReason(null);
  }

  const quickPrompts = [
    t("shell:assistant.prompts.instances"),
    t("shell:assistant.prompts.resources"),
    t("shell:assistant.prompts.servers"),
  ];

  const permissionLabel = status
    ? t(`settings:assistant.permissions.${status.permission}`)
    : t("settings:assistant.permissions.readOnly");

  const activeToolCount = status?.tools
    ? status.permission === "readOnly"
      ? status.tools.filter((item) => item.tier === "readOnly").length
      : status.tools.length
    : 0;

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
              <span className="vx-assistant-pill vx-assistant-pill--mono">{status.model}</span>
            ) : (
              <span className="vx-assistant-pill vx-assistant-pill--warn">
                {t("shell:assistant.notConfigured")}
              </span>
            )}
            <span className="vx-assistant-pill">{permissionLabel}</span>
            {activeToolCount > 0 ? (
              <span className="vx-assistant-pill vx-assistant-pill--mono">
                {t("shell:assistant.toolCount", { count: activeToolCount })}
              </span>
            ) : null}
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

        {wakeReason ? (
          <div className="vx-assistant-wake" role="status" data-testid="lumen-wake-banner">
            <Sparkles size={14} aria-hidden="true" />
            <span>{wakeReason}</span>
          </div>
        ) : null}

        <div ref={transcriptRef} className="vx-assistant-transcript" aria-live="polite">
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
                  <ol className="vx-assistant-traces" aria-label={t("shell:assistant.toolActivity")}>
                    {entry.traces.map((trace) => (
                      <li
                        className="vx-assistant-trace"
                        data-status={trace.status}
                        key={`${entry.id}-${trace.id}`}
                      >
                        <span className="vx-assistant-trace__node" aria-hidden="true" />
                        <div className="vx-assistant-trace__content">
                          <div className="vx-assistant-trace__head">
                            <span className="vx-assistant-trace__name">{trace.name}</span>
                            <span className="vx-assistant-trace__status" data-status={trace.status}>
                              {t(`shell:assistant.traceStatus.${trace.status}`)}
                            </span>
                          </div>
                          {trace.summary ? (
                            <span className="vx-assistant-trace__summary">{trace.summary}</span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {entry.content ? (
                  <p className="vx-assistant-message__body">{entry.content}</p>
                ) : null}
              </article>
            ))
          )}

          {busy ? (
            <div className="vx-assistant-thinking">
              <span className="vx-assistant-thinking__dot" aria-hidden="true" />
              <span>{t("common:status.loading")}</span>
            </div>
          ) : null}

          {pendingApprovals.length > 0 ? (
            <section
              className="vx-assistant-approval"
              role="region"
              aria-labelledby={`${approvalBaseId}-heading`}
              data-testid="lumen-approval"
            >
              <h3 id={`${approvalBaseId}-heading`} ref={approvalHeadingRef} tabIndex={-1}>
                {t("shell:assistant.approvalTitle")}
              </h3>
              <p>
                {pendingApprovals.every((call) => (call.reason ?? "controlled") === "controlled")
                  ? t("shell:assistant.approvalDescription")
                  : t("shell:assistant.approvalDescriptionFullAccess")}
              </p>
              <ul className="vx-assistant-approval__list">
                {pendingApprovals.map((call, index) => {
                  const argEntries = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                    ? Object.entries(call.arguments as Record<string, unknown>)
                    : [];
                  const details = call.details ?? [];
                  const itemId = `${approvalBaseId}-call-${index}`;
                  const note = reasonNote(call);
                  return (
                    <li className="vx-assistant-approval__item" key={call.id} data-call-id={call.id}>
                      <div className="vx-assistant-approval__head">
                        <span className="vx-assistant-trace__name" id={`${itemId}-name`}>{call.name}</span>
                        {pendingApprovals.length > 1 ? (
                          <label className="vx-assistant-approval__allow">
                            <input
                              type="checkbox"
                              checked={allowedIds.has(call.id)}
                              disabled={busy}
                              aria-labelledby={`${itemId}-allow ${itemId}-name`}
                              onChange={(event) => toggleAllowed(call.id, event.target.checked)}
                            />
                            <span id={`${itemId}-allow`}>{t("shell:assistant.approvalAllow")}</span>
                          </label>
                        ) : null}
                      </div>
                      {call.description ? <p>{call.description}</p> : null}
                      {note ? <p className="vx-assistant-approval__reason">{note}</p> : null}
                      {details.length > 0 ? (
                        <dl className="vx-assistant-approval__details">
                          {details.map((detail, detailIndex) => (
                            <div key={`${detail.field}-${detailIndex}`} data-unresolved={detail.unresolved ? "true" : undefined}>
                              <dt>{detailLabel(detail.field)}</dt>
                              <dd>
                                {detail.value === "" ? t("shell:assistant.approvalEmptyValue") : detail.value}
                                {detail.unresolved ? (
                                  <span className="vx-assistant-approval__unconfirmed">
                                    {t("shell:assistant.approvalUnconfirmed")}
                                  </span>
                                ) : null}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {call.unresolved ? (
                        <p className="vx-assistant-approval__warning" role="note">
                          <AlertTriangle size={14} aria-hidden="true" />
                          <span>{t("shell:assistant.approvalUnresolved")}</span>
                        </p>
                      ) : null}
                      <details className="vx-assistant-approval__technical">
                        <summary>{t("shell:assistant.approvalTechnical")}</summary>
                        {argEntries.length > 0 ? (
                          <dl className="vx-assistant-approval__args">
                            {argEntries.map(([key, value]) => (
                              <div key={key}>
                                <dt>{key}</dt>
                                <dd>{formatArgValue(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
                        )}
                      </details>
                    </li>
                  );
                })}
              </ul>
              {pendingApprovals.length === 1 ? (
                <div className="vx-action-row">
                  <Button
                    variant="primary"
                    icon={<Check size={14} />}
                    loading={busy}
                    onClick={() => void resolveApprovals([pendingApprovals[0].id])}
                  >
                    {t("shell:assistant.approveAction")}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<X size={14} />}
                    disabled={busy}
                    onClick={() => void resolveApprovals([])}
                  >
                    {t("shell:assistant.denyAction")}
                  </Button>
                </div>
              ) : (
                <div className="vx-action-row">
                  <Button
                    variant="primary"
                    icon={<Check size={14} />}
                    loading={busy}
                    disabled={allowedIds.size === 0}
                    onClick={() => void resolveApprovals([...allowedIds])}
                  >
                    {t("shell:assistant.approvalRunAllowed")}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={<X size={14} />}
                    disabled={busy}
                    onClick={() => void resolveApprovals([])}
                  >
                    {t("shell:assistant.approvalDenyAll")}
                  </Button>
                </div>
              )}
            </section>
          ) : null}
        </div>

        <form className="vx-assistant-composer" onSubmit={handleSubmit}>
          {error ? <p className="vx-assistant-error" role="alert">{errorMessage(error)}</p> : null}
          <textarea
            ref={textareaRef}
            data-dialog-autofocus=""
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
