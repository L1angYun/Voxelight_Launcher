import type { LocalResource } from "./types";

export type ResourceStateFilter = "all" | "enabled" | "disabled";
export type ResourceSort = "name" | "size" | "modified";

export interface LocalContentFilter {
  query: string;
  state: ResourceStateFilter;
  sort: ResourceSort;
}

export interface ResourceFilterCounts {
  all: number;
  enabled: number;
  disabled: number;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The name the list shows: the mod's declared name, or the file name without its state suffix. */
export function displayName(file: LocalResource): string {
  return file.metadata?.name || file.name;
}

function matchesQuery(file: LocalResource, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  const metadata = file.metadata;
  const fields: (string | undefined)[] = [
    displayName(file),
    file.fileName,
    metadata?.modId,
    metadata?.version,
    ...(metadata?.authors ?? []),
    ...(metadata?.dependencies ?? []).map((dependency) => dependency.id),
  ];
  return fields.some((field) => field?.toLocaleLowerCase().includes(term));
}

function compareNames(left: LocalResource, right: LocalResource): number {
  return nameCollator.compare(displayName(left), displayName(right))
    || nameCollator.compare(left.fileName, right.fileName);
}

function compareFiles(left: LocalResource, right: LocalResource, sort: ResourceSort): number {
  if (sort === "size") return right.size - left.size || compareNames(left, right);
  if (sort === "modified") return (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0) || compareNames(left, right);
  return compareNames(left, right);
}

/** How many files the current search matches, before the enabled/disabled filter is applied. */
export function resourceCounts(files: readonly LocalResource[], query: string): ResourceFilterCounts {
  let all = 0;
  let enabled = 0;
  for (const file of files) {
    if (!matchesQuery(file, query)) continue;
    all += 1;
    if (file.enabled) enabled += 1;
  }
  return { all, enabled, disabled: all - enabled };
}

/** Search, state-filter and sort the files of one resource kind without mutating the input. */
export function visibleResources(files: readonly LocalResource[], filter: LocalContentFilter): LocalResource[] {
  const state = filter.state ?? "all";
  const sort = filter.sort ?? "name";
  const matched = files.filter((file) => matchesQuery(file, filter.query ?? "")
    && (state === "all" || (state === "enabled") === file.enabled));
  return [...matched].sort((left, right) => compareFiles(left, right, sort));
}
