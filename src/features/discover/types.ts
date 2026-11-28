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
  /** The backend's first page ended before the project's last version. */
  hasMoreVersions?: boolean;
}

export interface ResourceVersionPage {
  versions: ResourceVersion[];
  hasMore: boolean;
  /** The raw index after the versions the source returned. */
  nextOffset?: number;
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
/** A CurseForge file the user downloads from its page and puts in place by hand. */
export interface ManualDownload {
  reason: "distributionForbidden" | "noDownloadUrl" | "untrustedUrl";
  url: string;
  displayName: string;
  fileName: string;
}
export interface ResourceTargetPlan {
  projectId: string;
  title: string;
  projectType: string;
  targets: TargetRow[];
  suggestion?: NewInstanceSuggestion | null;
  manifestUnavailable: boolean;
  manualOnly?: boolean;
  manualDownload?: ManualDownload | null;
  unsupportedReason?: "datapack" | "noSupportedLoader" | "noVersions" | "noReleaseVersions" | "noPinnedCreationLoader" | "manifestUnavailable" | null;
}
export interface ResourceCreateRequest { loader: Loader; gameVersion: string; loaderVersion?: string; name: string }
export type ResourceTaskTarget =
  | { mode: "existing"; versionId: string; instanceId?: string; fileId?: number; resourceVersionId?: string }
  | ({ mode: "create"; resourceVersionId?: string; fileId?: number } & ResourceCreateRequest);
export interface ResourceInstallResult {
  name?: string;
  fileName?: string;
  path?: string;
  warning?: string | null;
  updateId?: string | null;
  dependencyCount?: number;
  changedCount?: number;
  alreadyInstalled?: boolean;
}
export interface ResourceInstanceResult { instance: Instance; install?: ResourceInstallResult | null }
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
