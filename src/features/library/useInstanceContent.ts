import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pickLauncherPaths, pickLauncherPath } from "../../lib/nativePaths";
import { command, desktop } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import type {
  InstanceBackupList,
  LocalResource,
  Preview,
  ResourceHistory,
  ResourceKind,
  ResourceUpdate,
  ResourceUpdateCheck,
  ResourceView,
  RollbackResult,
  Screenshot,
  World,
} from "./types";

export function useResourceManager(versionId: string, instanceId?: string) {
  const { t } = useTranslation();
  const [kind, setKindState] = useState<ResourceKind>("resourcepack");
  const [view, setView] = useState<ResourceView>("files");
  const [files, setFiles] = useState<LocalResource[]>([]);
  const [selectedFileNames, setSelectedFileNames] = useState<ReadonlySet<string>>(() => new Set());
  const [updates, setUpdates] = useState<ResourceUpdate[] | null>(null);
  const [curseforgeSkipped, setCurseforgeSkipped] = useState(false);
  const [curseforgeFailed, setCurseforgeFailed] = useState(false);
  const [history, setHistory] = useState<ResourceHistory[] | null>(null);
  const [busy, setBusy] = useState(versionId && desktop ? "files" : "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  const selectionArgs = useCallback(() => ({ versionId, instanceId, resourceType: kind }), [instanceId, kind, versionId]);
  const report = useCallback((request: number, cause: unknown) => {
    if (request === generation.current) setError(normalizeError(cause).code);
  }, []);

  // Selection is keyed by fileName: `name` strips the `.disabled` suffix, so an
  // enabled file and its disabled twin can legitimately share it.
  const selectedFiles = files.filter((file) => selectedFileNames.has(file.fileName));
  const setKind = useCallback((next: ResourceKind) => {
    setSelectedFileNames(new Set());
    setKindState(next);
  }, []);
  const selectFile = useCallback((file: LocalResource, selected: boolean) => {
    setSelectedFileNames((previous) => {
      const next = new Set(previous);
      if (selected) next.add(file.fileName);
      else next.delete(file.fileName);
      return next;
    });
  }, []);
  const selectVisible = useCallback((visible: readonly LocalResource[], selected: boolean) => {
    setSelectedFileNames((previous) => {
      const next = new Set(previous);
      for (const file of visible) {
        if (selected) next.add(file.fileName);
        else next.delete(file.fileName);
      }
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedFileNames(new Set()), []);

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
    setSelectedFileNames(new Set());
    setUpdates(null);
    setCurseforgeSkipped(false);
    setCurseforgeFailed(false);
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
    setCurseforgeSkipped(false);
    setCurseforgeFailed(false);
    setBusy("updates");
    setError("");
    setNotice("");
    try {
      const result = await command<ResourceUpdateCheck>("check_resource_updates", selectionArgs());
      if (request === generation.current) {
        setUpdates(result.updates);
        setCurseforgeSkipped(result.curseforgeSkipped);
        setCurseforgeFailed(Boolean(result.curseforgeError));
      }
    } catch (cause) {
      if (request === generation.current) {
        setUpdates(null);
        setCurseforgeSkipped(false);
        setCurseforgeFailed(false);
      }
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
      // The backend renames the file when it is enabled or disabled. Keep the
      // selected file selected across that rename, like a batch toggle does.
      const renamed = file.enabled
        ? `${file.fileName}.disabled`
        : file.fileName.replace(/\.disabled$/, "");
      if (renamed !== file.fileName) {
        setSelectedFileNames((previous) => {
          if (!previous.has(file.fileName)) return previous;
          const next = new Set(previous);
          next.delete(file.fileName);
          next.add(renamed);
          return next;
        });
      }
      setNotice("resourceToggled");
      await refresh();
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, refresh, report, selectionArgs]);

  const toggleMany = useCallback(async (targets: LocalResource[], enabled: boolean) => {
    if (!desktop || busy) return;
    const pending = targets.filter((file) => file.enabled !== enabled);
    if (!pending.length) return;
    const request = ++generation.current;
    const target = selectionArgs();
    setBusy("toggle:batch");
    setError("");
    setNotice("");
    let failed = false;
    try {
      for (const file of pending) {
        // The user committed the whole batch. A generation bump (unmount or a
        // tab change) only invalidates this component's state updates; it must
        // not leave the remaining files silently untoggled.
        await command("toggle_resource", { ...target, fileName: file.fileName });
      }
      setNotice("resourceToggled");
    } catch (cause) {
      failed = true;
      report(request, cause);
    }
    if (request !== generation.current) return;
    try {
      // Refresh once for the whole batch, without clearing an error already
      // reported for the failed command.
      const nextFiles = await command<LocalResource[]>("list_local_resources", target);
      if (request !== generation.current) return;
      setFiles(nextFiles);
      const present = new Set(nextFiles.map((file) => file.fileName));
      const toggled = new Set(pending.map((file) => file.fileName));
      const renamed = (fileName: string) => enabled
        ? fileName.replace(/\.disabled$/, "")
        : fileName.endsWith(".disabled") ? fileName : `${fileName}.disabled`;
      setSelectedFileNames((previous) => {
        const next = new Set<string>();
        let changed = false;
        for (const fileName of previous) {
          if (present.has(fileName)) {
            next.add(fileName);
          } else if (toggled.has(fileName) && present.has(renamed(fileName))) {
            // Keep the selection on a file that was renamed by this batch.
            next.add(renamed(fileName));
            changed = true;
          } else {
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    } catch (cause) {
      if (request === generation.current) {
        setFiles([]);
        setSelectedFileNames(new Set());
        if (!failed) report(request, cause);
      }
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, report, selectionArgs]);

  const applyUpdate = useCallback(async (update: ResourceUpdate) => {
    if (!desktop || busy || update.manualOnly) return;
    const request = ++generation.current;
    const target = selectionArgs();
    setBusy(`update:${update.fileName}`);
    setError("");
    setNotice("");
    try {
      await command("update_resource", {
        ...target,
        fileName: update.fileName,
        newVersionId: update.newVersionId,
        source: update.source,
        newFileId: update.newFileId ?? null,
      });
      if (request !== generation.current) return;
      setUpdates((previous) => previous?.filter((item) => item.fileName !== update.fileName) ?? previous);
      setHistory(null);
      setNotice("resourceUpdated");
      let newFiles: LocalResource[];
      try {
        newFiles = await command<LocalResource[]>("list_local_resources", target);
      } catch (cause) {
        // The update happened but the folder could not be read again: nothing
        // listed from before it is shown as still there.
        if (request === generation.current) {
          setFiles([]);
          setUpdates(null);
          setCurseforgeSkipped(false);
          setCurseforgeFailed(false);
        }
        throw cause;
      }
      if (request !== generation.current) return;
      setFiles(newFiles);
      setUpdates((previous) => previous?.filter((item) => newFiles.some((file) => file.fileName === item.fileName)) ?? previous);
    } catch (cause) {
      report(request, cause);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, report, selectionArgs]);

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
      setCurseforgeSkipped(false);
      setCurseforgeFailed(false);
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
      setCurseforgeSkipped(false);
      setCurseforgeFailed(false);
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
    let paths: string[] | null = null;
    try { paths = await pickLauncherPaths("localResources"); }
    catch (cause) { setError(normalizeError(cause).code); return; }
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

  return {
    kind, setKind, view, setView, files, updates, curseforgeSkipped, curseforgeFailed, history, busy, error, notice,
    selectedFiles, selectedFileNames, selectFile, selectVisible, clearSelection, toggleMany,
    refresh, checkUpdates, showHistory, toggle, applyUpdate, rollback, recover, importFiles,
  };
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
    let path: string | null = null;
    try { path = await pickLauncherPath("worldRead"); }
    catch (cause) { setError(normalizeError(cause).code); return; }
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
    let outputPath: string | null = null;
    try { outputPath = await pickLauncherPath("worldWrite", `${world.folderName}.zip`); }
    catch (cause) { setError(normalizeError(cause).code); return; }
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
