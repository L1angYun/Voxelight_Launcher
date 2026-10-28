import { useCallback, useEffect, useRef, useState } from "react";
import { command, searchResources, type ResourceProject } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { normalizeError } from "../../lib/errors";
import type { DiscoverType, ResourceProjectDetails, ResourceSource } from "./types";

export function useDiscover() {
  const { selectedVersionId, selectedInstance, run, reload, selectInstance, selectVersion } = useLauncher();
  const [source, setSource] = useState<ResourceSource>("modrinth");
  const [resourceType, setResourceType] = useState<DiscoverType>("mod");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [resources, setResources] = useState<ResourceProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedProject, setSelectedProject] = useState<ResourceProject>();
  const [details, setDetails] = useState<ResourceProjectDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [modpackProject, setModpackProject] = useState<ResourceProject>();
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setResources([]);
    setSelectedProject(undefined);
    setDetails(undefined);
    setDetailsError("");
    setLoading(true);
    setError("");
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
      if (request === generation.current) setResources(items);
    }).catch((cause) => {
      if (request === generation.current) {
        setResources([]);
        setError(normalizeError(cause).code);
      }
    }).finally(() => {
      if (request === generation.current) setLoading(false);
    });
    return () => {
      generation.current++;
    };
  }, [resourceType, search, selectedInstance?.loader, selectedVersionId, source]);

  const loadProject = useCallback(async (project: ResourceProject) => {
    setSelectedProject(project);
    setDetails(undefined);
    setDetailsError("");
    if (!selectedVersionId) {
      setDetailsError("instance.required");
      return;
    }
    const request = ++generation.current;
    setDetailsLoading(true);
    try {
      const commandName = source === "modrinth" ? "get_modrinth_project_details" : "get_curseforge_project_details";
      const result = await command<ResourceProjectDetails>(commandName, {
        projectId: project.project_id,
        versionId: selectedVersionId,
        instanceId: selectedInstance?.id,
        resourceType,
      });
      if (request === generation.current) setDetails(result);
    } catch (cause) {
      if (request === generation.current) setDetailsError(normalizeError(cause).code);
    } finally {
      if (request === generation.current) setDetailsLoading(false);
    }
  }, [resourceType, selectedInstance?.id, selectedVersionId, source]);

  const closeProject = useCallback(() => {
    ++generation.current;
    setSelectedProject(undefined);
    setDetails(undefined);
    setDetailsError("");
    setDetailsLoading(false);
  }, []);

  const installProject = useCallback(async (project: ResourceProject) => {
    if (!selectedVersionId) {
      setError("instance.required");
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
  }, [resourceType, run, selectedInstance?.id, selectedVersionId, source]);

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
    resources, loading, error, notice,
    selectedProject, details, detailsLoading, detailsError,
    modpackProject, setModpackProject,
    loadProject, closeProject, installProject, installed,
    clearNotice: () => setNotice(""),
  };
}
