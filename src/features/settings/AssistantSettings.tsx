import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Copy, KeyRound, Play, RefreshCw, Square } from "lucide-react";
import { command, type Config } from "../../lib/launcher";
import { useLeaveGuard, useSharedSave } from "../../app/leaveGuard";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { Segmented } from "../../components/ui/Segmented";
import { useLumen } from "../assistant/LumenContext";
import type { AssistantPermission, AssistantProvider, AssistantStatus, McpStatus } from "../assistant/types";
import type { SettingsSectionProps } from "./types";

export function AssistantSettings({
  config,
  savedConfig,
  onChange,
  onError,
  onNotice,
  onOpenAssistant,
}: SettingsSectionProps & { savedConfig?: Config; onOpenAssistant?: () => void }) {
  const { t } = useTranslation();
  const lumen = useLumen();
  const [apiKey, setApiKey] = useState("");
  const [localStatus, setLocalStatus] = useState<AssistantStatus | null>(null);
  const [mcpOverride, setMcpOverride] = useState<McpStatus | null>(null);
  const [busyKey, setBusyKey] = useState(false);
  const [busyMcp, setBusyMcp] = useState(false);
  const mountedRef = useRef(true);
  const loadGenRef = useRef(0);
  const keySave = useSharedSave<boolean>();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadStandaloneStatus = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      const next = await command<AssistantStatus>("get_assistant_status");
      if (!mountedRef.current || gen !== loadGenRef.current) return;
      setLocalStatus(next);
    } catch (cause) {
      if (mountedRef.current && gen === loadGenRef.current) onError(cause);
    }
  }, [onError]);

  useEffect(() => {
    if (lumen.managed) {
      setMcpOverride(null);
    }
  }, [lumen.managed, lumen.status]);

  useEffect(() => {
    if (lumen.managed) {
      void lumen.refreshStatus();
    } else {
      void loadStandaloneStatus();
    }
  }, [lumen.managed, lumen.refreshStatus, loadStandaloneStatus]);

  const effectiveStatus = lumen.managed ? lumen.status : localStatus;
  const apiKeyConfigured = Boolean(effectiveStatus?.apiKeyConfigured);
  const ready = Boolean(effectiveStatus?.ready);
  const tools = effectiveStatus?.tools ?? [];
  const mcp: McpStatus = mcpOverride ?? effectiveStatus?.mcp ?? {
    running: false,
    port: config.assistantMcpPort || 25590,
    url: null,
    tokenMasked: null,
  };

  function saveApiKey(secret: string): Promise<boolean> {
    return keySave.run(async () => {
      setBusyKey(true);
      try {
        const configured = await command<boolean>("set_assistant_api_key", { secret });
        if (lumen.managed) {
          await lumen.refreshStatus();
        } else {
          await loadStandaloneStatus();
          if (mountedRef.current) {
            setLocalStatus((prev) => (prev ? { ...prev, apiKeyConfigured: configured } : prev));
          }
        }
        if (!mountedRef.current) return true;
        if (secret.trim()) {
          setApiKey("");
          onNotice("assistantKeySaved");
        } else {
          onNotice("assistantKeyCleared");
        }
        return true;
      } catch (cause) {
        if (mountedRef.current) onError(cause);
        return false;
      } finally {
        if (mountedRef.current) setBusyKey(false);
      }
    });
  }

  async function toggleMcp() {
    setBusyMcp(true);
    try {
      const next = mcp.running
        ? await command<McpStatus>("stop_mcp_server")
        : await command<McpStatus>("start_mcp_server", { port: config.assistantMcpPort });
      if (!mountedRef.current) return;
      setMcpOverride(next);
      if (lumen.managed) {
        void lumen.refreshStatus();
      } else {
        setLocalStatus((prev) => (prev ? { ...prev, mcp: next } : prev));
      }
      onNotice(next.running ? "mcpStarted" : "mcpStopped", { port: next.port });
    } catch (cause) {
      if (mountedRef.current) onError(cause);
    } finally {
      if (mountedRef.current) setBusyMcp(false);
    }
  }

  async function rotateToken() {
    setBusyMcp(true);
    try {
      const next = await command<McpStatus>("rotate_mcp_token");
      if (!mountedRef.current) return;
      setMcpOverride(next);
      if (lumen.managed) {
        void lumen.refreshStatus();
      } else {
        setLocalStatus((prev) => (prev ? { ...prev, mcp: next } : prev));
      }
      onNotice("mcpTokenRotated");
    } catch (cause) {
      if (mountedRef.current) onError(cause);
    } finally {
      if (mountedRef.current) setBusyMcp(false);
    }
  }

  async function copyMcpConfig() {
    try {
      const token = await command<string | null>("get_mcp_token");
      if (!token || !mcp.url) return;
      const snippet = JSON.stringify(
        {
          mcpServers: {
            "voxelight-lumen": {
              type: "http",
              url: mcp.url,
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          },
        },
        null,
        2,
      );
      await navigator.clipboard.writeText(snippet);
      onNotice("mcpConfigCopied");
    } catch (cause) {
      onError(cause);
    }
  }

  const baseUrlPlaceholder = config.assistantProvider === "anthropic"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1";
  const readOnlyCount = tools.filter((item) => item.tier === "readOnly").length;
  const controlledCount = tools.filter((item) => item.tier === "controlled").length;
  const lumenActive = ready && (!lumen.managed || lumen.configured);
  const assistantDraftDirty = Boolean(
    savedConfig && (
      config.assistantProvider !== savedConfig.assistantProvider
      || config.assistantModel.trim() !== savedConfig.assistantModel.trim()
      || config.assistantBaseUrl.trim() !== savedConfig.assistantBaseUrl.trim()
      || config.assistantPermission !== savedConfig.assistantPermission
      || config.assistantProactive !== savedConfig.assistantProactive
      || config.assistantMcpPort !== savedConfig.assistantMcpPort
    ),
  );
  // The API key is component-local: it is not part of the shared settings draft,
  // so this section registers its own unsaved text with the leave guard. The
  // provider fields are in the draft, which the page itself guards and which
  // survives a section switch, so they must not make a switch ask.
  useLeaveGuard(apiKey.trim().length > 0, {
    save: async () => {
      const running = keySave.current();
      if (running) return (await running) ? { ok: true } : { ok: false };
      if (!apiKey.trim()) return { ok: true };
      return (await saveApiKey(apiKey)) ? { ok: true } : { ok: false };
    },
    discard: () => setApiKey(""),
    running: keySave.current,
  });

  return (
    <div className="vx-settings-section">
      <header>
        <h2>{t("settings:section.assistant")}</h2>
        <p>{t("settings:assistant.description")}</p>
      </header>

      <section className="vx-settings-group">
        <h3>{t("settings:assistant.providerTitle")}</h3>
        <p>{t("settings:assistant.providerDescription")}</p>

        <div className="vx-settings-fields">
          <label data-settings-target="assistant-provider">
            {t("settings:assistant.provider")}
            <Select
              aria-label={t("settings:assistant.provider")}
              value={config.assistantProvider}
              onChange={(value) => onChange({ ...config, assistantProvider: value as AssistantProvider })}
              options={[
                { value: "openai", label: t("settings:assistant.providers.openai") },
                { value: "anthropic", label: t("settings:assistant.providers.anthropic") },
              ]}
            />
          </label>
          <label data-settings-target="assistant-model">
            {t("settings:assistant.model")}
            <input
              aria-label={t("settings:assistant.model")}
              value={config.assistantModel}
              placeholder={t("settings:assistant.modelPlaceholder")}
              onChange={(event) => onChange({ ...config, assistantModel: event.target.value })}
            />
          </label>
        </div>

        <label data-settings-target="assistant-base-url">
          {t("settings:assistant.baseUrl")}
          <input
            aria-label={t("settings:assistant.baseUrl")}
            value={config.assistantBaseUrl}
            placeholder={baseUrlPlaceholder}
            onChange={(event) => onChange({ ...config, assistantBaseUrl: event.target.value })}
          />
        </label>
        <p>{t("settings:assistant.baseUrlHint")}</p>

        <label data-settings-target="assistant-api-key">
          {t("settings:assistant.apiKey")}
          <span className="vx-settings-input-action">
            <input
              aria-label={t("settings:assistant.apiKey")}
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={
                apiKeyConfigured
                  ? t("settings:service.keyConfiguredPlaceholder")
                  : t("settings:assistant.apiKeyPlaceholder")
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button
              variant="secondary"
              icon={<KeyRound size={14} />}
              loading={busyKey}
              disabled={!apiKey.trim()}
              onClick={() => void saveApiKey(apiKey)}
            >
              {t("settings:service.saveKey")}
            </Button>
          </span>
        </label>
        <p>{t("settings:assistant.apiKeyHint")}</p>
        {apiKeyConfigured ? (
          <p role="status">
            {t("settings:service.configured")}{" "}
            <Button variant="ghost" disabled={busyKey} onClick={() => void saveApiKey("")}>
              {t("settings:service.clearKey")}
            </Button>
          </p>
        ) : null}

        <div className="vx-settings-labelled" data-settings-target="assistant-permission">
          <span>{t("settings:assistant.permission")}</span>
          <Segmented
            semantic="toggle"
            label={t("settings:assistant.permission")}
            value={config.assistantPermission}
            onChange={(value) => onChange({ ...config, assistantPermission: value as AssistantPermission })}
            options={[
              { value: "readOnly", label: t("settings:assistant.permissions.readOnly") },
              { value: "controlled", label: t("settings:assistant.permissions.controlled") },
              { value: "fullAccess", label: t("settings:assistant.permissions.fullAccess") },
            ]}
          />
        </div>
        <p>{t(`settings:assistant.permissionHints.${config.assistantPermission}`)}</p>
        {tools.length > 0 ? (
          <p>
            {t("settings:assistant.toolSummary", {
              total: tools.length,
              readOnly: readOnlyCount,
              controlled: controlledCount,
            })}
          </p>
        ) : null}

        <label className="vx-settings-check" data-settings-target="assistant-proactive">
          <input
            type="checkbox"
            aria-label={t("settings:assistant.proactive")}
            checked={config.assistantProactive}
            onChange={(event) => onChange({ ...config, assistantProactive: event.target.checked })}
          />
          <span>
            {t("settings:assistant.proactive")}
            <small>{t("settings:assistant.proactiveDescription")}</small>
          </span>
        </label>

        {assistantDraftDirty ? <p role="status">{t("settings:unsaved")}</p> : null}

        {lumenActive && onOpenAssistant ? (
          <div className="vx-action-row">
            <Button variant="secondary" icon={<Bot size={15} />} onClick={onOpenAssistant}>
              {t("settings:assistant.openDialog")}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="vx-settings-group">
        <h3>{t("settings:assistant.mcpTitle")}</h3>
        <p>{t("settings:assistant.mcpDescription")}</p>

        <label data-settings-target="assistant-mcp-port">
          {t("settings:assistant.mcpPort")}
          <input
            aria-label={t("settings:assistant.mcpPort")}
            type="number"
            min={1024}
            max={65535}
            value={config.assistantMcpPort}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              onChange({
                ...config,
                assistantMcpPort: Number.isFinite(parsed) ? Math.trunc(parsed) : config.assistantMcpPort,
              });
            }}
          />
        </label>

        {/* The status row holds only the state and its start or stop action, so both stay on one line;
            the running server's details and their actions sit in the well below. */}
        <div className="vx-mcp-server" data-testid="mcp-status-card">
          <div className="vx-mcp-status">
            <span className="vx-mcp-status__badge" role="status" data-running={mcp.running || undefined}>
              <span className="vx-status-pixel" aria-hidden="true" />
              <span>{mcp.running ? t("settings:assistant.mcpRunningShort") : t("settings:assistant.mcpStopped")}</span>
            </span>
            <div className="vx-action-row" data-settings-target="assistant-mcp-actions">
              <Button
                variant={mcp.running ? "secondary" : "primary"}
                data-settings-primary=""
                icon={mcp.running ? <Square size={14} /> : <Play size={14} />}
                loading={busyMcp}
                onClick={() => void toggleMcp()}
              >
                {mcp.running ? t("settings:assistant.mcpStop") : t("settings:assistant.mcpStart")}
              </Button>
            </div>
          </div>

          {mcp.running ? (
            <div className="vx-mcp-details">
              {mcp.url || mcp.tokenMasked ? (
                <dl>
                  {mcp.url ? (
                    <div>
                      <dt>{t("settings:assistant.mcpEndpoint")}</dt>
                      <dd><code>{mcp.url}</code></dd>
                    </div>
                  ) : null}
                  {mcp.tokenMasked ? (
                    <div>
                      <dt>{t("settings:assistant.mcpToken")}</dt>
                      <dd><code>{mcp.tokenMasked}</code></dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
              <div className="vx-action-row">
                <Button
                  variant="secondary"
                  icon={<Copy size={14} />}
                  disabled={busyMcp}
                  onClick={() => void copyMcpConfig()}
                >
                  {t("settings:assistant.mcpCopyConfig")}
                </Button>
                <Button
                  variant="ghost"
                  icon={<RefreshCw size={14} />}
                  disabled={busyMcp}
                  onClick={() => void rotateToken()}
                >
                  {t("settings:assistant.mcpRotateToken")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
