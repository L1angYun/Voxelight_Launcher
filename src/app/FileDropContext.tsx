// SPDX-License-Identifier: GPL-3.0-only
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { desktop } from "../lib/launcher";
import "./file-drop.css";

export interface DroppedFiles {
  mods: string[];
  zips: string[];
  modpacks: string[];
  skins: string[];
  unsupported: number;
}

export interface FileDragState {
  active: boolean;
  count: number;
}

export type FileDropHandler = (files: DroppedFiles) => boolean | void;

interface HandlerRegistration {
  id: number;
  priority: number;
  hintKey?: string;
  handle: FileDropHandler;
}

interface FileDropContextValue {
  register: (entry: HandlerRegistration) => void;
  unregister: (id: number) => void;
}

const FileDropContext = createContext<FileDropContextValue | null>(null);

export function droppedFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function FileDropProvider({
  onUnhandled,
  children,
}: {
  onUnhandled?: (files: DroppedFiles) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const handlersRef = useRef<HandlerRegistration[]>([]);
  const unhandledRef = useRef(onUnhandled);
  unhandledRef.current = onUnhandled;
  const [drag, setDrag] = useState<FileDragState>({ active: false, count: 0 });
  const [hintKey, setHintKey] = useState<string>("shell:drop.hintGeneral");

  const syncHint = () => {
    const sorted = [...handlersRef.current].sort((a, b) => b.priority - a.priority);
    const chosen = sorted.find((entry) => entry.hintKey)?.hintKey ?? "shell:drop.hintGeneral";
    setHintKey(chosen);
  };

  const context = useMemo<FileDropContextValue>(() => ({
    register(entry) {
      handlersRef.current = [
        ...handlersRef.current.filter((item) => item.id !== entry.id),
        entry,
      ];
      syncHint();
    },
    unregister(id) {
      handlersRef.current = handlersRef.current.filter((item) => item.id !== id);
      syncHint();
    },
  }), []);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const unlisteners: Array<() => void> = [];
    void listen<FileDragState>("launcher://file-drag", (event) => {
      if (!active) return;
      const payload = event.payload;
      setDrag({ active: Boolean(payload?.active), count: Number(payload?.count) || 0 });
    }).then((unlisten) => {
      if (active) unlisteners.push(unlisten);
      else unlisten();
    });
    void listen<DroppedFiles>("launcher://file-drop", (event) => {
      if (!active) return;
      setDrag({ active: false, count: 0 });
      const payload = event.payload;
      if (!payload) return;
      const files: DroppedFiles = {
        mods: Array.isArray(payload.mods) ? payload.mods : [],
        zips: Array.isArray(payload.zips) ? payload.zips : [],
        modpacks: Array.isArray(payload.modpacks) ? payload.modpacks : [],
        skins: Array.isArray(payload.skins) ? payload.skins : [],
        unsupported: Number(payload.unsupported) || 0,
      };
      const sorted = [...handlersRef.current].sort((a, b) => b.priority - a.priority);
      for (const entry of sorted) {
        if (entry.handle(files) === true) return;
      }
      unhandledRef.current?.(files);
    }).then((unlisten) => {
      if (active) unlisteners.push(unlisten);
      else unlisten();
    });
    return () => {
      active = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  return (
    <FileDropContext.Provider value={context}>
      {children}
      {drag.active ? (
        <div className="vx-file-drop-overlay" role="status" aria-live="polite" data-file-drop-overlay>
          <div className="vx-file-drop-overlay__card">
            <Upload size={28} aria-hidden="true" />
            <strong>{t("shell:drop.title")}</strong>
            <span>{t(hintKey, { count: drag.count })}</span>
          </div>
        </div>
      ) : null}
    </FileDropContext.Provider>
  );
}

let nextHandlerId = 1;

export function useFileDrop(
  handler: FileDropHandler,
  options: { priority?: number; hintKey?: string; enabled?: boolean } = {},
) {
  const context = useContext(FileDropContext);
  const idRef = useRef<number>(0);
  if (!idRef.current) idRef.current = nextHandlerId++;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { priority = 0, hintKey, enabled = true } = options;

  useEffect(() => {
    if (!context || !enabled) return;
    const id = idRef.current;
    context.register({
      id,
      priority,
      hintKey,
      handle: (files) => handlerRef.current(files),
    });
    return () => context.unregister(id);
  }, [context, enabled, hintKey, priority]);
}
