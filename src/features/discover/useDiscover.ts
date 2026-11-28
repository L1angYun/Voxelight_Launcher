import { useCallback, useEffect, useRef, useState } from "react";
import { command, type ResourceProject } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { normalizeError, type LauncherError } from "../../lib/errors";
import type { DiscoverType, ResourceContext, ResourceCreateRequest, ResourceInstallResult, ResourceInstanceResult, ResourceProjectDetails, ResourceSource, ResourceTargetFlow, ResourceTargetPlan, ResourceTaskTarget, ResourceVersionPage, TargetRow } from "./types";

const targetErrors = new Set(["resource.loaderRequired", "resource.noCompatibleVersion", "resource.versionMissing"]);

/** One search request; the backend caps limits at 50. */
const SEARCH_PAGE_SIZE = 24;
/** Both sources index at most this many search results. */
export const DISCOVER_RESULT_LIMIT = 10_000;

export type DiscoverSort =
  | "relevance" | "downloads" | "follows" | "newest" | "updated"
  | "featured" | "popularity" | "name";

/**
 * One logical sort list per source. `downloads` and `updated` mean the same
 * order on both sources, so they survive a source switch instead of being
 * reset to the default.
 */
export const DISCOVER_SORTS: Record<ResourceSource, readonly DiscoverSort[]> = {
  modrinth: ["relevance", "downloads", "follows", "newest", "updated"],
  curseforge: ["downloads", "updated", "featured", "popularity", "name"],
};
export const DEFAULT_SORT: Record<ResourceSource, DiscoverSort> = {
  modrinth: "relevance",
  curseforge: "downloads",
};

interface SearchPage { hits: ResourceProject[]; totalHits?: number; nextOffset?: number }
interface DiscoverResult {
  key: string;
  source?: ResourceSource;
  items: ResourceProject[];
  total?: number;
  /** The raw index after the hits the source returned, not the shown count. */
  nextOffset?: number;
  hasMore: boolean;
  context?: ResourceContext;
}

async function fetchSearchPage(request: {
  source: ResourceSource;
  query: string;
  resourceType: DiscoverType;
  context?: ResourceContext;
  sort: DiscoverSort;
  offset: number;
  limit: number;
}): Promise<SearchPage> {
  const args = {
    query: request.query,
    resourceType: request.resourceType,
    gameVersion: request.context?.gameVersion,
    loader: request.resourceType === "mod" ? request.context?.loader ?? undefined : undefined,
    offset: request.offset,
    limit: request.limit,
    sort: request.sort,
  };
  return request.source === "modrinth"
    ? command<SearchPage>("search_modrinth", args)
    : command<SearchPage>("search_curseforge", args);
}

/**
 * Whether another page exists and can still be requested. `nextOffset` is the
 * raw index after the hits the source returned; it is not the shown count when
 * a source page is filtered or a duplicate was dropped. Load more stops at the
 * shared 10000-result window instead of sending a request the backend refuses.
 */
function pageHasMore(page: SearchPage, offset: number, limit: number): boolean {
  const next = page.nextOffset ?? offset + page.hits.length;
  if (next <= offset) return false;
  if (next >= DISCOVER_RESULT_LIMIT) return false;
  if (page.totalHits !== undefined) return next < page.totalHits;
  return next - offset >= limit;
}

interface InstallRequest {
  flowId: number;
  reservation: Promise<string>;
  id?: string;
  cancellation?: Promise<void>;
}

function filePin(flow: ResourceTargetFlow) {
  if (flow.pinnedVersionId === undefined) return {};
  return flow.source === "modrinth"
    ? { resourceVersionId: flow.pinnedVersionId }
    : { fileId: Number(flow.pinnedVersionId) };
}

interface DiscoverFeedback { error: LauncherError; kind: "info" | "error"; retry?: () => void }
export function useDiscover(callbacks: { onNotice?: (code: string, params?: Record<string, unknown>) => void; onFeedback?: (feedback: DiscoverFeedback) => void } = {}) {
  const { selectedVersionId, selectedInstance, run, reload, selectInstance, selectVersion } = useLauncher();
  const [source, updateSource] = useState<ResourceSource>("modrinth");
  const [resourceType, updateResourceType] = useState<DiscoverType>("mod");
  const [query, setQuery] = useState("");
  const [search, updateSearch] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [rawSort, updateSort] = useState<DiscoverSort>(DEFAULT_SORT.modrinth);
  const sort = DISCOVER_SORTS[source].includes(rawSort) ? rawSort : DEFAULT_SORT[source];
  const [result, setResult] = useState<DiscoverResult>({ key: "", items: [], hasMore: false });
  const [requestState, setRequestState] = useState({ key: "", pending: true, error: "" });
  const [notice, setNotice] = useState("");
  const [feedback, setFeedback] = useState<DiscoverFeedback>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [focusId, setFocusId] = useState<string>();
  const [selection, setSelection] = useState<{ key: string; project: ResourceProject }>();
  const [details, setDetails] = useState<ResourceProjectDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [versionsHasMore, setVersionsHasMore] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [modpack, setModpack] = useState<{ project: ResourceProject; source: ResourceSource }>();
  const closeModpack = useCallback(() => setModpack(undefined), []);
  const [targetFlow, setTargetFlow] = useState<ResourceTargetFlow>();
  const [resolvedContext, setResolvedContext] = useState<{ key: string; value?: ResourceContext }>();
  const searchGeneration = useRef(0);
  const pageGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const versionsGeneration = useRef(0);
  const targetGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  const versionsLoadingRef = useRef(false);
  /** The raw index after the version hits received, not the shown row count. */
  const versionsNextOffset = useRef(0);
  const activeInstall = useRef<InstallRequest>(undefined);
  const contextKey = JSON.stringify([source, resourceType, search, sort, selectedVersionId, selectedInstance?.id]);
  const selectionKey = JSON.stringify([selectedVersionId, selectedInstance?.id]);
  const latestContext = useRef(contextKey);
  latestContext.current = contextKey;
  const blocked = useRef(true);
  const resources = result.source === source ? result.items : [];
  const loading = requestState.key !== contextKey || requestState.pending;
  const stale = result.key !== contextKey;
  const error = requestState.key === contextKey ? requestState.error : "";
  const total = result.key === contextKey && result.source === source ? result.total : undefined;
  const hasMore = result.key === contextKey && result.source === source && result.hasMore;
  const selectedProject = selection?.key === contextKey ? selection.project : undefined;
  const context = resolvedContext?.key === selectionKey ? resolvedContext.value : undefined;
  function reportFeedback(value: DiscoverFeedback) { setFeedback(value); callbacks.onFeedback?.(value); }
  function reportNotice(code: string, params?: Record<string, unknown>) { setNotice(code); callbacks.onNotice?.(code, params); }

  const setSource = useCallback((next: ResourceSource) => {
    if (next !== source) {
      blocked.current = true; ++targetGeneration.current; ++pageGeneration.current; updateSource(next);
      updateSort(current => DISCOVER_SORTS[next].includes(current) ? current : DEFAULT_SORT[next]);
    }
  }, [source]);
  const setSort = useCallback((next: DiscoverSort) => {
    if (next !== sort && DISCOVER_SORTS[source].includes(next)) {
      blocked.current = true; ++targetGeneration.current; ++pageGeneration.current; updateSort(next);
    }
  }, [sort, source]);
  const setResourceType = useCallback((next: DiscoverType) => {
    if (next !== resourceType) { blocked.current = true; ++targetGeneration.current; ++pageGeneration.current; updateResourceType(next); }
  }, [resourceType]);
  const setSearch = useCallback((next: string) => {
    blocked.current = true; ++targetGeneration.current; ++pageGeneration.current;
    if (next !== search) updateSearch(next); else setRetryNonce(nonce => nonce + 1);
  }, [search]);
  const clearNotice = useCallback(() => setNotice(""), []);
  const clearFeedback = useCallback(() => setFeedback(undefined), []);
  const clearFocus = useCallback(() => setFocusId(undefined), []);
  const closeProject = useCallback(() => {
    ++detailGeneration.current;
    ++versionsGeneration.current;
    versionsLoadingRef.current = false;
    versionsNextOffset.current = 0;
    setSelection(undefined); setDetails(undefined); setDetailsError(""); setDetailsLoading(false);
    setVersionsHasMore(false); setVersionsLoading(false); setVersionsError("");
  }, []);
  const closeTarget = useCallback(() => {
    ++targetGeneration.current;
    setTargetFlow(current => current ? { ...current, open: false } : undefined);
  }, []);

  useEffect(() => {
    const request = ++searchGeneration.current;
    ++pageGeneration.current;
    ++targetGeneration.current; blocked.current = true; closeProject();
    setTargetFlow(current => current?.status === "creating" || current?.status === "installing" ? { ...current, open: false } : undefined);
    setRequestState({ key: contextKey, pending: true, error: "" });
    setNotice("");
    setLoadMoreError("");
    setFocusId(undefined);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    const current = () => request === searchGeneration.current && latestContext.current === contextKey;
    void (async () => {
      let value: ResourceContext | undefined;
      if (selectedVersionId) {
        try { value = await command<ResourceContext>("get_resource_context", { versionId: selectedVersionId, instanceId: selectedInstance?.id }); }
        catch { /* A missing target must not block browsing. */ }
      }
      if (!current()) return;
      setResolvedContext({ key: selectionKey, value });
      const page = await fetchSearchPage({ source, query: search, resourceType, context: value, sort, offset: 0, limit: SEARCH_PAGE_SIZE });
      if (current()) setResult({
        key: contextKey, source, items: page.hits, total: page.totalHits,
        nextOffset: page.nextOffset ?? page.hits.length,
        hasMore: pageHasMore(page, 0, SEARCH_PAGE_SIZE), context: value,
      });
    })().catch(cause => {
      if (current()) {
        setResult({ key: contextKey, source, items: [], total: undefined, hasMore: false });
        setRequestState({ key: contextKey, pending: false, error: normalizeError(cause).code });
      }
    }).finally(() => {
      if (current()) { blocked.current = false; setRequestState(current => ({ ...current, pending: false })); }
    });
    return () => { ++searchGeneration.current; ++pageGeneration.current; };
  }, [closeProject, contextKey, resourceType, retryNonce, search, selectedInstance?.id, selectedVersionId, selectionKey, sort, source]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMoreRef.current) return;
    if (latestContext.current !== contextKey || result.key !== contextKey || result.source !== source || !result.hasMore) return;
    const key = contextKey;
    const offset = result.nextOffset ?? result.items.length;
    const limit = Math.min(SEARCH_PAGE_SIZE, DISCOVER_RESULT_LIMIT - offset);
    if (limit <= 0) return;
    const request = ++pageGeneration.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const page = await fetchSearchPage({ source, query: search, resourceType, context: result.context, sort, offset, limit });
      if (request !== pageGeneration.current || latestContext.current !== key) return;
      const nextOffset = page.nextOffset ?? offset + page.hits.length;
      const seen = new Set(result.items.map(project => project.project_id));
      const added = page.hits.filter(project => {
        if (seen.has(project.project_id)) return false;
        seen.add(project.project_id);
        return true;
      });
      setResult(current => current.key === key && current.source === source
        ? {
          ...current,
          items: [...current.items, ...added],
          total: page.totalHits ?? current.total,
          nextOffset,
          hasMore: pageHasMore(page, offset, limit),
        }
        : current);
      if (added.length) setFocusId(added[0].project_id);
    } catch (cause) {
      if (request === pageGeneration.current && latestContext.current === key) setLoadMoreError(normalizeError(cause).code);
    } finally {
      // A stale page must not clear the guard of the request that replaced it.
      if (request === pageGeneration.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [contextKey, loading, resourceType, result, search, sort, source]);

  const canUseProject = useCallback((project: ResourceProject) => !blocked.current
    && latestContext.current === contextKey && result.key === contextKey && result.items.includes(project), [contextKey, result]);

  const loadProject = useCallback(async (project: ResourceProject) => {
    if (!canUseProject(project)) return;
    ++targetGeneration.current;
    setTargetFlow(current => current?.status === "creating" ? { ...current, open: false } : undefined);
    setSelection({ key: contextKey, project }); setDetails(undefined); setDetailsError("");
    ++versionsGeneration.current;
    versionsLoadingRef.current = false;
    versionsNextOffset.current = 0;
    setVersionsHasMore(false); setVersionsLoading(false); setVersionsError("");
    const request = ++detailGeneration.current;
    setDetailsLoading(true);
    try {
      const result = await command<ResourceProjectDetails>(source === "modrinth" ? "get_modrinth_project_details" : "get_curseforge_project_details", {
        projectId: project.project_id, versionId: selectedVersionId || undefined, instanceId: selectedInstance?.id, resourceType,
      });
      if (request === detailGeneration.current && latestContext.current === contextKey) {
        versionsNextOffset.current = result.versions.length;
        setDetails(result);
        setVersionsHasMore(Boolean(result.hasMoreVersions));
      }
    } catch (cause) {
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetailsError(normalizeError(cause).code);
    } finally {
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetailsLoading(false);
    }
  }, [canUseProject, contextKey, resourceType, selectedInstance?.id, selectedVersionId, source]);

  const loadMoreVersions = useCallback(async () => {
    if (!selectedProject || !details || !versionsHasMore || versionsLoadingRef.current) return;
    const request = detailGeneration.current;
    const token = ++versionsGeneration.current;
    const key = contextKey;
    const offset = versionsNextOffset.current;
    const shown = details.versions.length;
    versionsLoadingRef.current = true;
    setVersionsLoading(true);
    setVersionsError("");
    try {
      const page = await command<ResourceVersionPage>(source === "modrinth" ? "get_modrinth_project_versions" : "get_curseforge_project_versions", {
        projectId: selectedProject.project_id, versionId: selectedVersionId || undefined, instanceId: selectedInstance?.id, resourceType, offset,
      });
      if (request !== detailGeneration.current || token !== versionsGeneration.current || latestContext.current !== key) return;
      const added = page.versions.filter(version => !details.versions.some(shown => shown.id === version.id));
      setDetails(current => {
        if (!current || current.versions.length !== shown) return current;
        const seen = new Set(current.versions.map(version => version.id));
        return {
          ...current,
          versions: [...current.versions, ...added.filter(version => {
            if (seen.has(version.id)) return false;
            seen.add(version.id);
            return true;
          })],
        };
      });
      // Count every hit the source returned, including a duplicate dropped at
      // the page boundary, so the next raw index stays aligned.
      versionsNextOffset.current = page.nextOffset ?? offset + page.versions.length;
      setVersionsHasMore(page.hasMore);
    } catch (cause) {
      if (request === detailGeneration.current && token === versionsGeneration.current && latestContext.current === key) setVersionsError(normalizeError(cause).code);
    } finally {
      // A stale request must not re-enable the button of a newer page.
      if (token === versionsGeneration.current) {
        versionsLoadingRef.current = false;
        setVersionsLoading(false);
      }
    }
  }, [contextKey, details, resourceType, selectedInstance?.id, selectedProject, selectedVersionId, source, versionsHasMore]);

  async function resolveTargets(flow: ResourceTargetFlow, trySelected: boolean, key = contextKey) {
    const plan = await command<ResourceTargetPlan>("resolve_resource_targets", { ...{ source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType }, ...filePin(flow) });
    if (targetGeneration.current !== flow.id || latestContext.current !== key) return;
    const next = { ...flow, plan, status: "choose" as const, open: true, error: undefined };
    const selected = plan.targets.find(row => row.compatible && row.versionId === selectedVersionId && (row.instanceId ?? undefined) === selectedInstance?.id);
    if (trySelected && selected && !plan.manualOnly) await executeInstall(next, selected);
    else setTargetFlow(next);
  }

  function reserveInstall(flow: ResourceTargetFlow, target: ResourceTaskTarget) {
    const request: InstallRequest = {
      flowId: flow.id,
      reservation: Promise.resolve().then(() => command<string>("reserve_resource_task", {
        request: { source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType, target },
      })),
    };
    activeInstall.current = request;
    return request;
  }

  async function reservedId(request: InstallRequest) {
    const id = await request.reservation;
    request.id = id;
    if (request.cancellation) {
      await request.cancellation;
      throw { code: "download.cancelled" };
    }
    setTargetFlow(current => current?.id === request.flowId ? { ...current, taskId: id } : current);
    return id;
  }

  async function cancelInstall(flowId: number) {
    const request = activeInstall.current;
    if (!request || request.flowId !== flowId) return;
    request.cancellation ??= request.reservation.then(async id => {
      await command("cancel_download_task", { taskId: id });
    });
    try { await request.cancellation; }
    finally { request.cancellation = undefined; }
  }

  function releaseUnclaimed(request: InstallRequest, error: LauncherError) {
    if (request.id && !request.cancellation && error.code !== "download.cancelled") {
      // Dispatch may fail before the command claims its reservation. The
      // request ID cannot name another installation of the same project.
      void command("cancel_download_task", { taskId: request.id }).catch(() => {});
    }
  }

  async function executeInstall(flow: ResourceTargetFlow, row: TargetRow) {
    if (activeInstall.current) return;
    const pin = filePin(flow);
    const request = reserveInstall(flow, { mode: "existing", versionId: row.versionId, instanceId: row.instanceId ?? undefined, ...pin });
    const flowContext = latestContext.current;
    setTargetFlow(current => current?.id === flow.id ? { ...flow, taskId: undefined, open: current.open && current.status !== "resolving", status: "installing" } : current);
    await run("resource.install", async () => {
      try {
        const taskId = await reservedId(request);
        const installed = await command<ResourceInstallResult | null>(flow.source === "modrinth" ? "install_resource" : "install_curseforge_resource", {
          projectId: flow.project.project_id, versionId: row.versionId, instanceId: row.instanceId ?? undefined, resourceType: flow.resourceType, taskId, ...pin,
        });
        if (row.instanceId) selectInstance(row.instanceId); else selectVersion(row.versionId);
        const dependencies = installed?.dependencyCount ?? 0;
        if (installed?.alreadyInstalled) {
          reportNotice("resourceAlreadyInstalled");
        } else if (dependencies > 0) {
          reportNotice("resourceInstalledWithDependencies", {
            count: dependencies,
            changed: installed?.changedCount ?? dependencies + 1,
          });
        } else {
          reportNotice("resourceInstalled");
        }
        setTargetFlow(current => current?.id === flow.id ? { ...current, open: false, status: "choose" } : current);
      } catch (cause) {
        const error = normalizeError(cause);
        releaseUnclaimed(request, error);
        // A file to download by hand is shown in the picker, which explains it.
        const manualFile = error.code === "resource.manualDownload" && flow.source === "curseforge"
          && typeof error.params.fileId === "string" && /^[1-9]\d*$/.test(error.params.fileId) ? error.params.fileId : undefined;
        if ((targetErrors.has(error.code) || manualFile) && latestContext.current === flowContext && targetGeneration.current === flow.id) {
          if (!manualFile && flow.source === "curseforge" && flow.pinnedVersionId === undefined) setTargetFlow({ ...flow, open: true, status: "curseforge", error });
          else {
            const next = { ...flow, id: ++targetGeneration.current, status: "resolving" as const, pinnedVersionId: flow.pinnedVersionId ?? manualFile };
            try { await resolveTargets(next, false); }
            catch (cause) {
              if (targetGeneration.current === next.id && latestContext.current === flowContext) setTargetFlow({ ...next, open: true, status: "error", error: normalizeError(cause) });
            }
          }
        } else reportFeedback({ error, kind: error.code === "download.cancelled" ? "info" : "error" });
        setTargetFlow(current => current?.id === flow.id && current.status === "installing" ? { ...current, status: "choose" } : current);
      } finally { if (activeInstall.current === request) activeInstall.current = undefined; }
    });
  }

  async function installProject(project: ResourceProject, pinnedVersionId?: string) {
    if (!canUseProject(project) || activeInstall.current) return;
    if (resourceType === "modpack") { setModpack({ project, source }); return; }
    if (source === "curseforge" && pinnedVersionId !== undefined &&
      (!/^[1-9]\d*$/.test(pinnedVersionId) || Number(pinnedVersionId) > 0xffff_ffff)) return;
    const flow: ResourceTargetFlow = { id: ++targetGeneration.current, open: true, status: "resolving", source, resourceType, project, pinnedVersionId };
    if (source === "curseforge" && pinnedVersionId === undefined) {
      if (!selectedVersionId) { setTargetFlow({ ...flow, status: "curseforge", error: normalizeError({ code: "resource.versionMissing" }) }); return; }
      await executeInstall(flow, { kind: selectedInstance ? "instance" : "version", instanceId: selectedInstance?.id, versionId: selectedVersionId, name: selectedInstance?.name ?? selectedVersionId, gameVersion: context?.gameVersion ?? "", loader: context?.loader ?? null, compatible: true });
      return;
    }
    setTargetFlow(flow);
    try { await resolveTargets(flow, true); }
    catch (cause) { if (targetGeneration.current === flow.id && latestContext.current === contextKey) setTargetFlow({ ...flow, status: "error", error: normalizeError(cause) }); }
  }

  async function installInto(row: TargetRow) { if (targetFlow) await executeInstall(targetFlow, row); }

  async function createAndInstall(creation: ResourceCreateRequest) {
    const flow = targetFlow;
    if (!flow || activeInstall.current) return;
    const target = { ...creation, ...filePin(flow) };
    const request = reserveInstall(flow, { mode: "create", ...target });
    setTargetFlow({ ...flow, taskId: undefined, status: "creating", error: undefined });
    await run("resource.install", async () => {
      try {
        const taskId = await reservedId(request);
        const result = await command<ResourceInstanceResult>("create_instance_for_resource", { source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType, ...target, taskId });
        await reload(); selectVersion(result.instance.versionId); selectInstance(result.instance.id);
        const dependencies = result.install?.dependencyCount ?? 0;
        if (dependencies > 0) {
          reportNotice("resourceInstalledNewWithDependencies", {
            count: dependencies,
            changed: result.install?.changedCount ?? dependencies + 1,
          });
        } else {
          reportNotice("resourceInstalledNew");
        }
        setTargetFlow(current => current?.id === flow.id ? { ...current, open: false, status: "choose" } : current);
      } catch (cause) {
        const error = normalizeError(cause);
        releaseUnclaimed(request, error);
        if (error.code === "resource.installAfterCreate" && typeof error.params.instanceId === "string") {
          await reload();
          if (typeof error.params.versionId === "string") selectVersion(error.params.versionId);
          selectInstance(error.params.instanceId);
          const row: TargetRow = { kind: "instance", instanceId: error.params.instanceId, versionId: typeof error.params.versionId === "string" ? error.params.versionId : "", name: String(error.params.instanceName ?? creation.name), gameVersion: creation.gameVersion, loader: creation.loader, compatible: true };
          reportFeedback({ error, kind: "error", retry: () => {
            void (async () => {
              let target = row;
              if (!target.versionId) {
                const plan = await command<ResourceTargetPlan>("resolve_resource_targets", { ...{ source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType }, ...filePin(flow) });
                const retained = plan.targets.find(candidate => candidate.instanceId === row.instanceId && candidate.compatible);
                if (!retained) throw normalizeError({ code: "resource.versionMissing" });
                target = retained;
                selectVersion(target.versionId); selectInstance(target.instanceId ?? undefined);
              }
              await executeInstall(flow, target);
            })().catch(cause => reportFeedback({ error: normalizeError(cause), kind: "error" }));
          } });
          setTargetFlow(current => current?.id === flow.id ? { ...current, open: false, status: "choose" } : current);
        } else {
          reportFeedback({ error, kind: error.code === "download.cancelled" ? "info" : "error" });
          setTargetFlow(current => current?.id === flow.id ? { ...current, status: "choose" } : current);
        }
      } finally { if (activeInstall.current === request) activeInstall.current = undefined; }
    });
  }

  const installed = useCallback(async (versionId: string, instanceId?: string) => {
    await reload();
    if (instanceId) selectInstance(instanceId); else selectVersion(versionId);
    closeModpack(); reportNotice("instanceInstalled");
  }, [closeModpack, reload, selectInstance, selectVersion]);

  return { source, setSource, resourceType, setResourceType, query, setQuery, search, setSearch,
    sort, setSort, resources, loading, loadingMore, loadMore, loadMoreError, hasMore, total, focusId, clearFocus,
    stale, resultKey: result.key, error, notice, feedback, clearFeedback, context,
    selectedProject, details, detailsLoading, detailsError, versionsHasMore, versionsLoading, versionsError, loadMoreVersions,
    modpack, closeModpack, targetFlow, closeTarget, installInto, createAndInstall, cancelInstall,
    loadProject, closeProject, installProject, installed, clearNotice };
}
