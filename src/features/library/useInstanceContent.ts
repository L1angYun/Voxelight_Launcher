import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import { command, desktop } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import type {
  InstanceBackupList,
  LocalResource,
  Preview,
  ResourceHistory,
  ResourceKind,
  ResourceUpdate,
  ResourceView,
  RollbackResult,
  Screenshot,
  World,
} from "./types";

export function useResourceManager(versionId: string, instanceId?: string) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ResourceKind>("resourcepack");
  const [view, setView] = useState<ResourceView>("files");
  const [files, setFiles] = useState<LocalResource[]>([]);
  const [updates, setUpdates] = useState<ResourceUpdate[] | null>(null);
  const [history, setHistory] = useState<ResourceHistory[] | null>(null);
  const [busy, setBusy] = useState(versionId && desktop ? "files" : "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  const selectionArgs = useCallback(() => ({ versionId, instanceId, resourceType: kind }), [instanceId, kind, versionId]);
  const report = useCallback((request: number, cause: unknown) => {
    if (request === generation.current) setError(normalizeError(cause).code);
  }, []);

  const refresh = useCallback(async () => {
    if (!versionId || !desktop) return;
    const request = ++generation.current;
    setBusy("files");
    setError("");
    try {
      const result = await command<LocalResource[]>("list_local_resources", selectionArgs());
      if (request === generation.current) setFiles(result);
    } catch (cause) {
      if (request === generation.current) setFiles([]);
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [report, selectionArgs, versionId]);

  useEffect(() => {
    ++generation.current;
    setFiles([]);
    setUpdates(null);
    setHistory(null);
    setView("files");
    setBusy("");
    setError("");
    setNotice("");
    if (versionId && desktop) void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh, versionId]);

  const checkUpdates = useCallback(async () => {
    if (!versionId || !desktop || busy) return;
    const request = ++generation.current;
    setView("updates");
    setUpdates(null);
    setBusy("updates");
    setError("");
    setNotice("");
    try {
      const result = await command<ResourceUpdate[]>("check_resource_updates", selectionArgs());
      if (request === generation.current) setUpdates(result);
    } catch (cause) {
      if (request === generation.current) setUpdates(null);
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, report, selectionArgs, versionId]);

  const showHistory = useCallback(async () => {
    if (!versionId || !desktop || busy) return;
    const request = ++generation.current;
    setView("history");
    setHistory(null);
    setBusy("history");
    setError("");
    setNotice("");
    try {
      const result = await command<ResourceHistory[]>("list_resource_update_history", selectionArgs());
      if (request === generation.current) setHistory(result);
    } catch (cause) {
      if (request === generation.current) setHistory(null);
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, report, selectionArgs, versionId]);

  const toggle = useCallback(async (file: LocalResource) => {
    if (!desktop || busy) return;
    const request = ++generation.current;
    setBusy(`toggle:${file.fileName}`);
    setError("");
    setNotice("");
    try {
      await command("toggle_resource", { ...selectionArgs(), fileName: file.fileName });
      if (request !== generation.current) return;
      setNotice("resourceToggled");
      await refresh();
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, refresh, report, selectionArgs]);

  const applyUpdate = useCallback(async (update: ResourceUpdate) => {
    if (!desktop || busy) return;
    const request = ++generation.current;
    setBusy(`update:${update.fileName}`);
    setError("");
    setNotice("");
    try {
      await command("update_resource", { ...selectionArgs(), fileName: update.fileName, newVersionId: update.newVersionId });
      if (request !== generation.current) return;
      setUpdates((previous) => previous?.filter((item) => item.fileName !== update.fileName) ?? previous);
      setHistory(null);
      setNotice("resourceUpdated");
      await refresh();
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, refresh, report, selectionArgs]);

  const rollback = useCallback(async (entry: ResourceHistory, confirmation = entry.name) => {
    if (!desktop || busy || entry.canRecover || entry.status !== "committed" || !window.confirm(confirmation)) return;
    const request = ++generation.current;
    setBusy(`rollback:${entry.updateId}`);
    setError("");
    setNotice("");
    try {
      const result = await command<RollbackResult>("rollback_resource_update", { ...selectionArgs(), updateId: entry.updateId });
      if (request !== generation.current) return;
      setHistory((previous) => previous?.map((item) => item.updateId === result.updateId ? { ...item, status: result.status } : item) ?? previous);
      setUpdates(null);
      setNotice("resourceRolledBack");
      await refresh();
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, refresh, report, selectionArgs]);

  const recover = useCallback(async (entry: ResourceHistory, confirmation: string) => {
    if (!desktop || busy || !entry.canRecover || !window.confirm(confirmation)) return;
    const request = ++generation.current;
    const target = selectionArgs();
    setBusy(`recover:${entry.updateId}`);
    setError("");
    setNotice("");
    try {
      const result = await command<RollbackResult>("recover_resource_update", { ...target, updateId: entry.updateId });
      if (request !== generation.current) return;
      setHistory((previous) => previous?.map((item) => item.updateId === result.updateId
        ? { ...item, status: result.status, canRecover: false } : item) ?? previous);
      setUpdates(null);
      setNotice("resourceRecovered");
      const [newHistory, newFiles] = await Promise.all([
        command<ResourceHistory[]>("list_resource_update_history", target),
        command<LocalResource[]>("list_local_resources", target),
      ]);
      if (request !== generation.current) return;
      setHistory(newHistory);
      setFiles(newFiles);
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, report, selectionArgs]);

  const importFiles = useCallback(async () => {
    if (!desktop || busy) return;
    const paths = await open({
      title: t("library:selectResources"),
      multiple: true,
      filters: [{ name: kind === "mod" ? t("library:jarMods") : t("library:zipResources"), extensions: [kind === "mod" ? "jar" : "zip"] }],
    });
    if (!paths?.length) return;
    const request = ++generation.current;
    setBusy("import");
    setError("");
    try {
      await command("import_local_resources", { ...selectionArgs(), paths });
      if (request !== generation.current) return;
      setNotice("resourceImported");
      await refresh();
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, kind, refresh, report, selectionArgs, t]);

  return { kind, setKind, view, setView, files, updates, history, busy, error, notice, refresh, checkUpdates, showHistory, toggle, applyUpdate, rollback, recover, importFiles };
}

export function useWorlds(versionId: string, instanceId?: string) {
  const { t } = useTranslation();
  const [worlds, setWorlds] = useState<World[]>([]);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [worldName, setWorldName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!versionId || !desktop) return;
    const request = ++generation.current;
    setBusy("worlds");
    setError("");
    try {
      const [nextWorlds, nextScreenshots] = await Promise.all([
        command<World[]>("list_worlds", { versionId, instanceId }),
        command<Screenshot[]>("list_screenshots", { versionId, instanceId }),
      ]);
      if (request === generation.current) {
        setWorlds(nextWorlds);
        setScreenshots(nextScreenshots);
      }
    } catch (cause) {
      if (request === generation.current) {
        setWorlds([]);
        setScreenshots([]);
        setError(normalizeError(cause).code);
      }
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [instanceId, versionId]);

  useEffect(() => {
    ++generation.current;
    setWorlds([]);
    setScreenshots([]);
    setPreview(null);
    setError("");
    setNotice("");
    if (versionId && desktop) void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh, versionId]);

  const importWorld = useCallback(async () => {
    if (!desktop || busy) return;
    const path = await open({ title: t("library:selectWorldZip"), multiple: false, filters: [{ name: t("library:worldZipFileType"), extensions: ["zip"] }] });
    if (typeof path !== "string") return;
    const request = ++generation.current;
    setBusy("import");
    setError("");
    try {
      await command("import_world", { versionId, instanceId, path, name: worldName.trim() || undefined });
      if (request !== generation.current) return;
      setWorldName("");
      setNotice("worldImported");
      await refresh();
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, instanceId, refresh, t, versionId, worldName]);

  const backupWorld = useCallback(async (world: World) => {
    if (!desktop || busy) return;
    const outputPath = await save({ title: t("library:backupWorld"), defaultPath: `${world.folderName}.zip`, filters: [{ name: t("library:worldZipFileType"), extensions: ["zip"] }] });
    if (!outputPath) return;
    const request = ++generation.current;
    setBusy(`backup:${world.folderName}`);
    setError("");
    try {
      await command("backup_world", { versionId, instanceId, worldFolder: world.folderName, outputPath });
      if (request !== generation.current) return;
      setNotice("worldBackedUp");
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, instanceId, t, versionId]);

  const readScreenshot = useCallback(async (fileName: string) => {
    if (!desktop || busy) return;
    const request = ++generation.current;
    setBusy("preview");
    setError("");
    try {
      const result = await command<Preview>("read_screenshot", { versionId, instanceId, fileName });
      if (request === generation.current) setPreview(result);
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, instanceId, versionId]);

  return { worlds, screenshots, preview, worldName, setWorldName, busy, error, notice, refresh, importWorld, backupWorld, readScreenshot, clearPreview: () => setPreview(null) };
}

export function useInstanceBackups(instanceId: string) {
  const [snapshot, setSnapshot] = useState<InstanceBackupList>({ backups: [], warnings: [], recovery: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await command<InstanceBackupList>("list_instance_backups", { instanceId });
      if (request === generation.current) setSnapshot(next);
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [instanceId]);
  useEffect(() => {
    setSnapshot({ backups: [], warnings: [], recovery: null });
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  return { ...snapshot, busy, error, refresh };
}
