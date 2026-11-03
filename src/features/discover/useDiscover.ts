import { useCallback, useEffect, useRef, useState } from "react";
import { command, searchResources, type ResourceProject } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { normalizeError } from "../../lib/errors";
import type { DiscoverType, ResourceProjectDetails, ResourceSource } from "./types";

export function useDiscover() {
  const { selectedVersionId, selectedInstance, run, reload, selectInstance, selectVersion } = useLauncher();
  const [source, updateSource] = useState<ResourceSource>("modrinth");
  const [resourceType, updateResourceType] = useState<DiscoverType>("mod");
  const [query, setQuery] = useState("");
  const [search, updateSearch] = useState("");
  const [result, setResult] = useState<{ key: string; source?: ResourceSource; items: ResourceProject[] }>({ key: "", items: [] });
  const [requestState, setRequestState] = useState({ key: "", pending: true, error: "" });
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<{ key: string; project: ResourceProject }>();
  const [details, setDetails] = useState<ResourceProjectDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [modpackProject, setModpackProject] = useState<ResourceProject>();
  const searchGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const contextKey = JSON.stringify([source, resourceType, search, selectedVersionId, selectedInstance?.id, selectedInstance?.loader]);
  const latestContext = useRef(contextKey);
  latestContext.current = contextKey;
  const blocked = useRef(true);
  const resources = result.source === source ? result.items : [];
  const loading = requestState.key !== contextKey || requestState.pending;
  const stale = result.key !== contextKey;
  const error = (requestState.key === contextKey ? requestState.error : "") || actionError;
  const selectedProject = selection?.key === contextKey ? selection.project : undefined;

  // Invalidate in the event itself, before React commits the new selection or
  // starts the next effect. A queued click must not install an old result.
  const setSource = useCallback((next: ResourceSource) => {
    if (next !== source) { blocked.current = true; updateSource(next); }
  }, [source]);
  const setResourceType = useCallback((next: DiscoverType) => {
    if (next !== resourceType) { blocked.current = true; updateResourceType(next); }
  }, [resourceType]);
  const setSearch = useCallback((next: string) => {
    if (next !== search) { blocked.current = true; updateSearch(next); }
  }, [search]);
  const clearNotice = useCallback(() => setNotice(""), []);
  const closeProject = useCallback(() => {
    ++detailGeneration.current;
    setSelection(undefined);
    setDetails(undefined);
    setDetailsError("");
    setDetailsLoading(false);
  }, []);

  useEffect(() => {
    const request = ++searchGeneration.current;
    blocked.current = true;
    closeProject();
    setRequestState({ key: contextKey, pending: true, error: "" });
    setActionError("");
    setNotice("");
    const load = source === "modrinth"
      ? searchResources(search, resourceType, selectedVersionId || undefined)
      : command<{ hits: ResourceProject[] }>("search_curseforge", {
          query: search,
          resourceType,
          gameVersion: selectedVersionId || undefined,
          loader: selectedInstance?.loader || undefined,
        }).then((result) => result.hits);
    void load.then((items) => {
      if (request === searchGeneration.current && latestContext.current === contextKey) {
        setResult({ key: contextKey, source, items });
      }
    }).catch((cause) => {
      if (request === searchGeneration.current && latestContext.current === contextKey) {
        setRequestState({ key: contextKey, pending: false, error: normalizeError(cause).code });
      }
    }).finally(() => {
      if (request === searchGeneration.current && latestContext.current === contextKey) {
        blocked.current = false;
        setRequestState((current) => ({ ...current, pending: false }));
      }
    });
    return () => {
      searchGeneration.current++;
    };
  }, [closeProject, contextKey, resourceType, search, selectedInstance?.loader, selectedVersionId, source]);

  const canUseProject = useCallback((project: ResourceProject) => !blocked.current
    && latestContext.current === contextKey && result.key === contextKey && result.items.includes(project), [contextKey, result]);

  const loadProject = useCallback(async (project: ResourceProject) => {
    if (!canUseProject(project)) return;
    setSelection({ key: contextKey, project });
    setDetails(undefined);
    setDetailsError("");
    setDetailsLoading(false);
    if (!selectedVersionId) {
      setDetailsError("instance.required");
      return;
    }
    const request = ++detailGeneration.current;
    setDetailsLoading(true);
    try {
      const commandName = source === "modrinth" ? "get_modrinth_project_details" : "get_curseforge_project_details";
      const result = await command<ResourceProjectDetails>(commandName, {
        projectId: project.project_id,
        versionId: selectedVersionId,
        instanceId: selectedInstance?.id,
        resourceType,
      });
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetails(result);
    } catch (cause) {
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetailsError(normalizeError(cause).code);
    } finally {
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetailsLoading(false);
    }
  }, [canUseProject, contextKey, resourceType, selectedInstance?.id, selectedVersionId, source]);

  const installProject = useCallback(async (project: ResourceProject) => {
    if (!canUseProject(project)) return;
    if (!selectedVersionId) {
      setActionError("instance.required");
      return;
    }
    if (resourceType === "modpack") {
      setModpackProject(project);
      return;
    }
    await run("resource.install", async () => {
      const commandName = source === "modrinth" ? "install_resource" : "install_curseforge_resource";
      await command(commandName, {
        projectId: project.project_id,
        versionId: selectedVersionId,
        instanceId: selectedInstance?.id,
        resourceType,
      });
      setNotice("resourceInstalled");
    });
  }, [canUseProject, resourceType, run, selectedInstance?.id, selectedVersionId, source]);

  const installed = useCallback(async (versionId: string, instanceId?: string) => {
    await reload();
    if (instanceId) selectInstance(instanceId);
    else selectVersion(versionId);
    setModpackProject(undefined);
    setNotice("instanceInstalled");
  }, [reload, selectInstance, selectVersion]);

  return {
    source, setSource,
    resourceType, setResourceType,
    query, setQuery,
    search, setSearch,
    resources, loading, stale, resultKey: result.key, error, notice,
    selectedProject, details, detailsLoading, detailsError,
    modpackProject, setModpackProject,
    loadProject, closeProject, installProject, installed,
    clearNotice,
  };
}
