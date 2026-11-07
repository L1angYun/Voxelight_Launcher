import { useCallback, useEffect, useRef, useState } from "react";
import { command, searchResources, type ResourceProject } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { normalizeError, type LauncherError } from "../../lib/errors";
import type { DiscoverType, ResourceContext, ResourceCreateRequest, ResourceInstanceResult, ResourceProjectDetails, ResourceSource, ResourceTargetFlow, ResourceTargetPlan, TargetRow } from "./types";

const targetErrors = new Set(["resource.loaderRequired", "resource.noCompatibleVersion", "resource.versionMissing"]);

interface DiscoverFeedback { error: LauncherError; kind: "info" | "error"; retry?: () => void }
export function useDiscover(callbacks: { onNotice?: (code: string) => void; onFeedback?: (feedback: DiscoverFeedback) => void } = {}) {
  const { selectedVersionId, selectedInstance, run, reload, selectInstance, selectVersion } = useLauncher();
  const [source, updateSource] = useState<ResourceSource>("modrinth");
  const [resourceType, updateResourceType] = useState<DiscoverType>("mod");
  const [query, setQuery] = useState("");
  const [search, updateSearch] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [result, setResult] = useState<{ key: string; source?: ResourceSource; items: ResourceProject[] }>({ key: "", items: [] });
  const [requestState, setRequestState] = useState({ key: "", pending: true, error: "" });
  const [notice, setNotice] = useState("");
  const [feedback, setFeedback] = useState<DiscoverFeedback>();
  const [selection, setSelection] = useState<{ key: string; project: ResourceProject }>();
  const [details, setDetails] = useState<ResourceProjectDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [modpackProject, setModpackProject] = useState<ResourceProject>();
  const [targetFlow, setTargetFlow] = useState<ResourceTargetFlow>();
  const [resolvedContext, setResolvedContext] = useState<{ key: string; value?: ResourceContext }>();
  const searchGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const targetGeneration = useRef(0);
  const activeInstall = useRef(false);
  const contextKey = JSON.stringify([source, resourceType, search, selectedVersionId, selectedInstance?.id]);
  const selectionKey = JSON.stringify([selectedVersionId, selectedInstance?.id]);
  const latestContext = useRef(contextKey);
  latestContext.current = contextKey;
  const blocked = useRef(true);
  const resources = result.source === source ? result.items : [];
  const loading = requestState.key !== contextKey || requestState.pending;
  const stale = result.key !== contextKey;
  const error = requestState.key === contextKey ? requestState.error : "";
  const selectedProject = selection?.key === contextKey ? selection.project : undefined;
  const context = resolvedContext?.key === selectionKey ? resolvedContext.value : undefined;
  function reportFeedback(value: DiscoverFeedback) { setFeedback(value); callbacks.onFeedback?.(value); }
  function reportNotice(code: string) { setNotice(code); callbacks.onNotice?.(code); }

  const setSource = useCallback((next: ResourceSource) => {
    if (next !== source) { blocked.current = true; ++targetGeneration.current; updateSource(next); }
  }, [source]);
  const setResourceType = useCallback((next: DiscoverType) => {
    if (next !== resourceType) { blocked.current = true; ++targetGeneration.current; updateResourceType(next); }
  }, [resourceType]);
  const setSearch = useCallback((next: string) => {
    blocked.current = true; ++targetGeneration.current;
    if (next !== search) updateSearch(next); else setRetryNonce(nonce => nonce + 1);
  }, [search]);
  const clearNotice = useCallback(() => setNotice(""), []);
  const clearFeedback = useCallback(() => setFeedback(undefined), []);
  const closeProject = useCallback(() => {
    ++detailGeneration.current;
    setSelection(undefined); setDetails(undefined); setDetailsError(""); setDetailsLoading(false);
  }, []);
  const closeTarget = useCallback(() => {
    ++targetGeneration.current;
    setTargetFlow(current => current ? { ...current, open: false } : undefined);
  }, []);

  useEffect(() => {
    const request = ++searchGeneration.current;
    ++targetGeneration.current; blocked.current = true; closeProject();
    setTargetFlow(current => current?.status === "creating" || current?.status === "installing" ? { ...current, open: false } : undefined);
    setRequestState({ key: contextKey, pending: true, error: "" });
    setNotice("");
    const current = () => request === searchGeneration.current && latestContext.current === contextKey;
    void (async () => {
      let value: ResourceContext | undefined;
      if (selectedVersionId) {
        try { value = await command<ResourceContext>("get_resource_context", { versionId: selectedVersionId, instanceId: selectedInstance?.id }); }
        catch { /* A missing target must not block browsing. */ }
      }
      if (!current()) return;
      setResolvedContext({ key: selectionKey, value });
      const items = source === "modrinth"
        ? await searchResources(search, resourceType, value?.gameVersion, resourceType === "mod" ? value?.loader ?? undefined : undefined)
        : (await command<{ hits: ResourceProject[] }>("search_curseforge", { query: search, resourceType, gameVersion: value?.gameVersion, loader: value?.loader ?? undefined })).hits;
      if (current()) setResult({ key: contextKey, source, items });
    })().catch(cause => {
      if (current()) {
        setResult({ key: contextKey, source, items: [] });
        setRequestState({ key: contextKey, pending: false, error: normalizeError(cause).code });
      }
    }).finally(() => {
      if (current()) { blocked.current = false; setRequestState(current => ({ ...current, pending: false })); }
    });
    return () => { ++searchGeneration.current; };
  }, [closeProject, contextKey, resourceType, retryNonce, search, selectedInstance?.id, selectedVersionId, selectionKey, source]);

  const canUseProject = useCallback((project: ResourceProject) => !blocked.current
    && latestContext.current === contextKey && result.key === contextKey && result.items.includes(project), [contextKey, result]);

  const loadProject = useCallback(async (project: ResourceProject) => {
    if (!canUseProject(project)) return;
    ++targetGeneration.current;
    setTargetFlow(current => current?.status === "creating" ? { ...current, open: false } : undefined);
    setSelection({ key: contextKey, project }); setDetails(undefined); setDetailsError("");
    const request = ++detailGeneration.current;
    setDetailsLoading(true);
    try {
      const result = await command<ResourceProjectDetails>(source === "modrinth" ? "get_modrinth_project_details" : "get_curseforge_project_details", {
        projectId: project.project_id, versionId: selectedVersionId || undefined, instanceId: selectedInstance?.id, resourceType,
      });
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetails(result);
    } catch (cause) {
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetailsError(normalizeError(cause).code);
    } finally {
      if (request === detailGeneration.current && latestContext.current === contextKey) setDetailsLoading(false);
    }
  }, [canUseProject, contextKey, resourceType, selectedInstance?.id, selectedVersionId, source]);

  async function resolveTargets(flow: ResourceTargetFlow, trySelected: boolean, key = contextKey) {
    const plan = await command<ResourceTargetPlan>("resolve_resource_targets", { source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType });
    if (targetGeneration.current !== flow.id || latestContext.current !== key) return;
    const next = { ...flow, plan, status: "choose" as const, open: true, error: undefined };
    const selected = plan.targets.find(row => row.compatible && row.versionId === selectedVersionId && (row.instanceId ?? undefined) === selectedInstance?.id);
    if (trySelected && selected) await executeInstall(next, selected);
    else setTargetFlow(next);
  }

  async function executeInstall(flow: ResourceTargetFlow, row: TargetRow) {
    if (activeInstall.current) return;
    activeInstall.current = true;
    const flowContext = latestContext.current;
    setTargetFlow(current => current?.id === flow.id ? { ...flow, open: current.open && current.status !== "resolving", status: "installing" } : current);
    await run("resource.install", async () => {
      try {
        await command(flow.source === "modrinth" ? "install_resource" : "install_curseforge_resource", {
          projectId: flow.project.project_id, versionId: row.versionId, instanceId: row.instanceId ?? undefined, resourceType: flow.resourceType,
        });
        if (row.instanceId) selectInstance(row.instanceId); else selectVersion(row.versionId);
        reportNotice("resourceInstalled");
        setTargetFlow(current => current?.id === flow.id ? { ...current, open: false, status: "choose" } : current);
      } catch (cause) {
        const error = normalizeError(cause);
        if (targetErrors.has(error.code) && latestContext.current === flowContext && targetGeneration.current === flow.id) {
          if (flow.source === "curseforge") setTargetFlow({ ...flow, open: true, status: "curseforge", error });
          else {
            const next = { ...flow, id: ++targetGeneration.current, status: "resolving" as const };
            try { await resolveTargets(next, false); }
            catch (cause) {
              if (targetGeneration.current === next.id && latestContext.current === flowContext) setTargetFlow({ ...next, open: true, status: "error", error: normalizeError(cause) });
            }
          }
        } else reportFeedback({ error, kind: error.code === "download.cancelled" ? "info" : "error" });
        setTargetFlow(current => current?.id === flow.id && current.status === "installing" ? { ...current, status: "choose" } : current);
      } finally { activeInstall.current = false; }
    });
  }

  async function installProject(project: ResourceProject) {
    if (!canUseProject(project) || activeInstall.current) return;
    if (resourceType === "modpack") { setModpackProject(project); return; }
    const flow: ResourceTargetFlow = { id: ++targetGeneration.current, open: true, status: "resolving", source, resourceType, project };
    if (source === "curseforge") {
      if (!selectedVersionId) { setTargetFlow({ ...flow, status: "curseforge", error: normalizeError({ code: "resource.versionMissing" }) }); return; }
      await executeInstall(flow, { kind: selectedInstance ? "instance" : "version", instanceId: selectedInstance?.id, versionId: selectedVersionId, name: selectedInstance?.name ?? selectedVersionId, gameVersion: context?.gameVersion ?? "", loader: context?.loader ?? null, compatible: true });
      return;
    }
    setTargetFlow(flow);
    try { await resolveTargets(flow, true); }
    catch (cause) { if (targetGeneration.current === flow.id && latestContext.current === contextKey) setTargetFlow({ ...flow, status: "error", error: normalizeError(cause) }); }
  }

  async function installInto(row: TargetRow) { if (targetFlow) await executeInstall(targetFlow, row); }

  async function createAndInstall(request: ResourceCreateRequest) {
    const flow = targetFlow;
    if (!flow || flow.source !== "modrinth" || activeInstall.current) return;
    activeInstall.current = true;
    setTargetFlow({ ...flow, status: "creating", error: undefined });
    await run("resource.install", async () => {
      try {
        const result = await command<ResourceInstanceResult>("create_instance_for_resource", { source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType, ...request });
        await reload(); selectVersion(result.instance.versionId); selectInstance(result.instance.id); reportNotice("resourceInstalledNew");
        setTargetFlow(current => current?.id === flow.id ? { ...current, open: false, status: "choose" } : current);
      } catch (cause) {
        const error = normalizeError(cause);
        if (error.code === "resource.installAfterCreate" && typeof error.params.instanceId === "string") {
          await reload();
          if (typeof error.params.versionId === "string") selectVersion(error.params.versionId);
          selectInstance(error.params.instanceId);
          const row: TargetRow = { kind: "instance", instanceId: error.params.instanceId, versionId: typeof error.params.versionId === "string" ? error.params.versionId : "", name: String(error.params.instanceName ?? request.name), gameVersion: request.gameVersion, loader: request.loader, compatible: true };
          reportFeedback({ error, kind: "error", retry: () => {
            void (async () => {
              let target = row;
              if (!target.versionId) {
                const plan = await command<ResourceTargetPlan>("resolve_resource_targets", { source: flow.source, projectId: flow.project.project_id, resourceType: flow.resourceType });
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
      } finally { activeInstall.current = false; }
    });
  }

  const installed = useCallback(async (versionId: string, instanceId?: string) => {
    await reload();
    if (instanceId) selectInstance(instanceId); else selectVersion(versionId);
    setModpackProject(undefined); reportNotice("instanceInstalled");
  }, [reload, selectInstance, selectVersion]);

  return { source, setSource, resourceType, setResourceType, query, setQuery, search, setSearch,
    resources, loading, stale, resultKey: result.key, error, notice, feedback, clearFeedback, context,
    selectedProject, details, detailsLoading, detailsError, modpackProject, setModpackProject,
    targetFlow, closeTarget, installInto, createAndInstall,
    loadProject, closeProject, installProject, installed, clearNotice };
}
