import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { command, desktop, events } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import type { AssistantStatus } from "./types";

export interface LumenWakeRequest {
  id: number;
  reason?: string;
  prompt?: string;
  autoSend?: boolean;
}

export interface LumenContextValue {
  /** True inside LumenProvider; false in standalone unit tests without a provider. */
  managed: boolean;
  /** True only once the user has configured Lumen (model + API key or local loopback endpoint). */
  configured: boolean;
  proactive: boolean;
  status: AssistantStatus | null;
  open: boolean;
  wakeRequest: LumenWakeRequest | null;
  refreshStatus: () => Promise<AssistantStatus | null>;
  openLumen: (request?: Omit<LumenWakeRequest, "id">) => void;
  closeLumen: () => void;
  consumeWakeRequest: () => void;
}

const inactiveContext: LumenContextValue = {
  managed: false,
  configured: false,
  proactive: false,
  status: null,
  open: false,
  wakeRequest: null,
  refreshStatus: async () => null,
  openLumen: () => {},
  closeLumen: () => {},
  consumeWakeRequest: () => {},
};

const LumenContext = createContext<LumenContextValue>(inactiveContext);

export function LumenProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { bootstrapped, config, running, data } = useLauncher();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [wakeRequest, setWakeRequest] = useState<LumenWakeRequest | null>(null);
  const wakeCounter = useRef(0);
  const refreshGen = useRef(0);
  const gameTargets = useRef(new Map<string, { instanceId?: string | null; versionId: string }>());
  const instancesRef = useRef(data.instances);
  instancesRef.current = data.instances;

  useEffect(() => {
    for (const game of running) {
      gameTargets.current.set(game.gameId, {
        instanceId: game.instanceId,
        versionId: game.versionId,
      });
    }
  }, [running]);

  const refreshStatus = useCallback(async (): Promise<AssistantStatus | null> => {
    const gen = ++refreshGen.current;
    if (!desktop) {
      setStatus(null);
      setOpen(false);
      setWakeRequest(null);
      return null;
    }
    try {
      const next = await command<AssistantStatus>("get_assistant_status");
      if (gen !== refreshGen.current) return null;
      setStatus(next);
      if (!next?.ready) {
        setOpen(false);
        setWakeRequest(null);
      }
      return next;
    } catch {
      if (gen !== refreshGen.current) return null;
      // Fail closed: never keep stale configured=true state when status cannot be verified.
      setStatus(null);
      setOpen(false);
      setWakeRequest(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!bootstrapped) return;
    void refreshStatus();
  }, [
    bootstrapped,
    config.assistantProvider,
    config.assistantBaseUrl,
    config.assistantModel,
    config.assistantPermission,
    config.assistantProactive,
    refreshStatus,
  ]);

  const configured = Boolean(status?.ready);
  const proactive = Boolean(status?.ready && status?.proactive);

  const openLumen = useCallback(
    (request?: Omit<LumenWakeRequest, "id">) => {
      if (!configured) return;
      if (request && (request.prompt || request.reason)) {
        wakeCounter.current += 1;
        setWakeRequest({ id: wakeCounter.current, ...request });
      }
      setOpen(true);
    },
    [configured],
  );

  const closeLumen = useCallback(() => {
    setOpen(false);
    setWakeRequest(null);
  }, []);

  const consumeWakeRequest = useCallback(() => {
    setWakeRequest(null);
  }, []);

  // Proactively wake Lumen on abnormal game exits (non-zero exit code) only when
  // the user has configured Lumen and kept proactive wake-up enabled.
  useEffect(() => {
    if (!configured || !proactive || !desktop) return;
    let active = true;
    const promise = events<{ gameId: string; pid: number; code: number | null }>(
      "launcher://game-exit",
      (event) => {
        const tracked = gameTargets.current.get(event.gameId);
        gameTargets.current.delete(event.gameId);
        if (!active) return;
        if (event.code === null || event.code === 0) return;
        if (document.querySelector("dialog[open], .vx-tour__card")) return;
        const instance = tracked?.instanceId
          ? instancesRef.current.find((item) => item.id === tracked.instanceId)
          : undefined;
        const target = instance?.name ?? tracked?.versionId ?? "Minecraft";
        const instanceHint = instance ? ` (instanceId: ${instance.id})` : "";
        openLumen({
          reason: t("shell:assistant.wake.crashReason", { target, code: event.code }),
          prompt: t("shell:assistant.wake.crashPrompt", { target: `${target}${instanceHint}`, code: event.code }),
          autoSend: true,
        });
      },
    );
    return () => {
      active = false;
      void promise.then((dispose) => dispose());
    };
  }, [configured, proactive, openLumen, t]);

  const value = useMemo<LumenContextValue>(
    () => ({
      managed: true,
      configured,
      proactive,
      status,
      open: configured && open,
      wakeRequest,
      refreshStatus,
      openLumen,
      closeLumen,
      consumeWakeRequest,
    }),
    [configured, proactive, status, open, wakeRequest, refreshStatus, openLumen, closeLumen, consumeWakeRequest],
  );

  return <LumenContext.Provider value={value}>{children}</LumenContext.Provider>;
}

export function useLumen(): LumenContextValue {
  return useContext(LumenContext);
}
