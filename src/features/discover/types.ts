import type { Instance, ResourceProject, ResourceSource } from "../../lib/launcher";
import type { LauncherError } from "../../lib/errors";
import type { Loader } from "../library/types";

export type { ResourceSource };

export interface ResourceVersion {
  id: string;
  name: string;
  versionNumber: string;
  datePublished: string;
  gameVersions: string[];
  loaders: string[];
  compatible: boolean;
}

export interface ResourceDependency {
  projectId: string;
  kind: "required" | "optional" | "incompatible" | "embedded" | "unknown";
  name?: string | null;
}

export interface ResourceProjectDetails {
  project: ResourceProject;
  versions: ResourceVersion[];
  dependencies: ResourceDependency[];
}

export type DiscoverType = "mod" | "resourcepack" | "shader" | "modpack";

export interface ResourceContext { gameVersion: string; loader: string | null }
export interface TargetRow {
  kind: "instance" | "version";
  instanceId?: string | null;
  versionId: string;
  name: string;
  gameVersion: string;
  loader: string | null;
  compatible: boolean;
  reason?: "vanilla" | "loaderMismatch" | "gameVersionMismatch" | "running" | "metadataMissing" | null;
  resourceVersionId?: string | null;
}
export interface NewInstanceSuggestion {
  loader: Loader;
  gameVersion: string;
  name: string;
  matrix: { loader: Loader; gameVersions: string[] }[];
}
export interface ResourceTargetPlan {
  projectId: string;
  title: string;
  projectType: string;
  targets: TargetRow[];
  suggestion?: NewInstanceSuggestion | null;
  manifestUnavailable: boolean;
  unsupportedReason?: "datapack" | "noSupportedLoader" | "noVersions" | "noReleaseVersions" | "noPinnedCreationLoader" | "curseforgeRequiredDependencies" | "manifestUnavailable" | null;
}
export interface ResourceCreateRequest { loader: Loader; gameVersion: string; loaderVersion?: string; name: string }
export type ResourceTaskTarget =
  | { mode: "existing"; versionId: string; instanceId?: string; fileId?: number; resourceVersionId?: string }
  | ({ mode: "create"; resourceVersionId?: string; fileId?: number } & ResourceCreateRequest);
export interface ResourceInstanceResult { instance: Instance; install: unknown }
export interface ResourceTargetFlow {
  id: number;
  open: boolean;
  status: "resolving" | "choose" | "installing" | "creating" | "error" | "curseforge";
  project: ResourceProject;
  source: ResourceSource;
  resourceType: DiscoverType;
  pinnedVersionId?: string;
  plan?: ResourceTargetPlan;
  taskId?: string;
  error?: LauncherError;
}
