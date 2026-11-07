import type { Instance, ResourceProject } from "../../lib/launcher";
import type { LauncherError } from "../../lib/errors";
import type { Loader } from "../library/types";

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

export type ResourceSource = "modrinth" | "curseforge";
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
  unsupportedReason?: "datapack" | "noSupportedLoader" | "noVersions" | null;
}
export interface ResourceCreateRequest { loader: Loader; gameVersion: string; loaderVersion?: string; name: string }
export interface ResourceInstanceResult { instance: Instance; install: unknown }
export interface ResourceTargetFlow {
  id: number;
  open: boolean;
  status: "resolving" | "choose" | "installing" | "creating" | "error" | "curseforge";
  project: ResourceProject;
  source: ResourceSource;
  resourceType: DiscoverType;
  plan?: ResourceTargetPlan;
  error?: LauncherError;
}
