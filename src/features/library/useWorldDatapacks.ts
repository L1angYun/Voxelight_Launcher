import { useCallback, useEffect, useRef, useState } from "react";
import { command, desktop } from "../../lib/launcher";
import { pickLauncherPaths } from "../../lib/nativePaths";
import { normalizeError } from "../../lib/errors";

export interface WorldDatapack {
  fileName: string;
  name: string;
  isDirectory: boolean;
  enabled: boolean;
  sizeBytes: number;
  description?: string | null;
  packFormat?: number | null;
}

export function useWorldDatapacks(versionId: string, instanceId: string | undefined, worldFolder: string | null) {
  const [datapacks, setDatapacks] = useState<WorldDatapack[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!versionId || !worldFolder || !desktop) return;
    const request = ++generation.current;
    setBusy("list");
    setError("");
    try {
      const next = await command<WorldDatapack[]>("list_world_datapacks", {
        versionId,
        instanceId,
        worldFolder,
      });
      if (request === generation.current) setDatapacks(next);
    } catch (cause) {
      if (request === generation.current) {
        setDatapacks([]);
        setError(normalizeError(cause).code);
      }
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [instanceId, versionId, worldFolder]);

  useEffect(() => {
    ++generation.current;
    setDatapacks([]);
    setBusy("");
    setError("");
    setNotice("");
    if (versionId && worldFolder && desktop) void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh, versionId, worldFolder]);

  const importDatapacks = useCallback(async () => {
    if (!versionId || !worldFolder || !desktop || busy) return;
    let paths: string[] | null = null;
    try {
      paths = await pickLauncherPaths("datapack");
    } catch (cause) {
      setError(normalizeError(cause).code);
      return;
    }
    if (!paths?.length) return;
    const request = ++generation.current;
    setBusy("import");
    setError("");
    setNotice("");
    try {
      await command<WorldDatapack[]>("import_world_datapacks", {
        versionId,
        instanceId,
        worldFolder,
        paths,
      });
      if (request !== generation.current) return;
      setNotice("datapacksImported");
      await refresh();
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, instanceId, refresh, versionId, worldFolder]);

  const toggleDatapack = useCallback(async (pack: WorldDatapack) => {
    if (!versionId || !worldFolder || !desktop || busy) return;
    const request = ++generation.current;
    setBusy(`toggle:${pack.fileName}`);
    setError("");
    setNotice("");
    try {
      await command<WorldDatapack>("toggle_world_datapack", {
        versionId,
        instanceId,
        worldFolder,
        fileName: pack.fileName,
      });
      if (request !== generation.current) return;
      setNotice("datapackToggled");
      await refresh();
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, instanceId, refresh, versionId, worldFolder]);

  const deleteDatapack = useCallback(async (pack: WorldDatapack, confirmation: string) => {
    if (!versionId || !worldFolder || !desktop || busy || !window.confirm(confirmation)) return;
    const request = ++generation.current;
    setBusy(`delete:${pack.fileName}`);
    setError("");
    setNotice("");
    try {
      await command("delete_world_datapack", {
        versionId,
        instanceId,
        worldFolder,
        fileName: pack.fileName,
      });
      if (request !== generation.current) return;
      setNotice("datapackDeleted");
      await refresh();
    } catch (cause) {
      if (request === generation.current) setError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setBusy("");
    }
  }, [busy, instanceId, refresh, versionId, worldFolder]);

  return { datapacks, busy, error, notice, refresh, importDatapacks, toggleDatapack, deleteDatapack };
}
