import type { ResourceProject } from "../../lib/launcher";

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
