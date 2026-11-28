// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { command, type ResourceProject } from "../../lib/launcher";
import { useDiscover } from "./useDiscover";
import type { ResourceProjectDetails, ResourceVersion, ResourceVersionPage } from "./types";

vi.mock("../../lib/launcher", () => ({ command: vi.fn() }));
vi.mock("../../app/controller/LauncherProvider", () => ({ useLauncher: () => ({
  selectedVersionId: "1.21.1", selectedInstance: { id: "fixture", loader: "fabric" },
  run: async (_name: string, action: () => Promise<void>) => action(), reload: async () => {}, selectInstance: () => {}, selectVersion: () => {},
}) }));
const project: ResourceProject = { project_id: "old-mod", slug: "old-mod", title: "Old mod", description: "", author: "", downloads: 0, icon_url: null, project_type: "mod", versions: [] };
const second: ResourceProject = { ...project, project_id: "second-mod", title: "Second mod" };
const fresh: ResourceProject = { ...project, project_id: "fresh-mod", title: "Fresh mod" };
const more: ResourceProject = { ...project, project_id: "more-mod", title: "More mod" };
let current: ReturnType<typeof useDiscover>;
let root: Root;
let container: HTMLDivElement;
const searchMock = vi.fn<(name: string, args: Record<string, unknown>) => Promise<Page>>();
const detailsMock = vi.fn<(args: Record<string, unknown> | undefined) => Promise<ResourceProjectDetails>>();
const versionsMock = vi.fn<(args: Record<string, unknown> | undefined) => Promise<ResourceVersionPage>>();

interface Page { hits: ResourceProject[]; totalHits?: number; nextOffset?: number }
function page(hits: ResourceProject[], totalHits?: number, nextOffset?: number): Page { return { hits, totalHits, nextOffset }; }
function version(id: string): ResourceVersion {
  return { id, name: id, versionNumber: id, datePublished: "2026-01-01", gameVersions: ["1.21.1"], loaders: ["fabric"], compatible: true };
}
function projectDetails(project: ResourceProject, versions: ResourceVersion[], hasMoreVersions = false): ResourceProjectDetails {
  return { project, versions, dependencies: [], hasMoreVersions };
}
function Harness() { current = useDiscover(); return null; }
function deferredPage() {
  let resolve!: (value: Page) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Page>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function deferredVersions() {
  let resolve!: (value: ResourceVersionPage) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<ResourceVersionPage>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function render() {
  await act(async () => root.render(<Harness />));
  await flush();
}
function lastSearch() {
  return searchMock.mock.calls.at(-1);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  searchMock.mockReset().mockResolvedValue(page([project], 1));
  detailsMock.mockReset().mockResolvedValue(projectDetails(project, [version("v1")]));
  versionsMock.mockReset().mockResolvedValue({ versions: [], hasMore: false });
  vi.mocked(command).mockReset().mockImplementation(async (name, args) => {
    if (name === "get_resource_context") return { gameVersion: "1.21.1", loader: "fabric" };
    if (name === "search_modrinth" || name === "search_curseforge") {
      return searchMock(name, (args ?? {}) as Record<string, unknown>);
    }
    if (name === "get_modrinth_project_details" || name === "get_curseforge_project_details") {
      return detailsMock((args ?? {}) as Record<string, unknown>);
    }
    if (name === "get_modrinth_project_versions" || name === "get_curseforge_project_versions") {
      return versionsMock((args ?? {}) as Record<string, unknown>);
    }
    return null;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("searches the first page with the active sort and bounded page size", async () => {
  await render();
  expect(current.resources).toEqual([project]);
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({
    query: "", resourceType: "mod", gameVersion: "1.21.1", loader: "fabric",
    offset: 0, limit: 24, sort: "relevance",
  })]);
});

it("appends the next page, updates the total, and hides load more at the end", async () => {
  searchMock.mockResolvedValueOnce(page([project, second], 4)).mockResolvedValueOnce(page([fresh, more], 4));
  await render();
  expect(current.resources).toEqual([project, second]);
  expect(current.total).toBe(4);
  expect(current.hasMore).toBe(true);

  await act(async () => { await current.loadMore(); });

  expect(current.resources).toEqual([project, second, fresh, more]);
  expect(current.total).toBe(4);
  expect(current.hasMore).toBe(false);
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ offset: 2, limit: 24, sort: "relevance" })]);
});

it("uses the next card as the focus target after appending", async () => {
  searchMock.mockResolvedValueOnce(page([project], 2)).mockResolvedValueOnce(page([fresh], 2));
  await render();
  expect(current.focusId).toBeUndefined();
  await act(async () => { await current.loadMore(); });
  expect(current.focusId).toBe("fresh-mod");
});

it.each(["query", "sort", "source"] as const)("resets paging when the %s changes", async (change) => {
  searchMock.mockResolvedValueOnce(page([project, second], 8)).mockResolvedValueOnce(page([fresh], 1));
  await render();
  expect(current.hasMore).toBe(true);
  if (change === "query") {
    await act(async () => current.setSearch("new"));
  } else if (change === "sort") {
    await act(async () => current.setSort("downloads"));
  } else {
    await act(async () => current.setSource("curseforge"));
  }
  await flush();
  expect(current.resources).toEqual([fresh]);
  expect(current.hasMore).toBe(false);
  expect(lastSearch()).toEqual([
    change === "source" ? "search_curseforge" : "search_modrinth",
    expect.objectContaining({
      offset: 0,
      sort: change === "sort" ? "downloads" : change === "source" ? "downloads" : "relevance",
    }),
  ]);
});

it.each(["query", "sort", "source"] as const)("drops a page that resolves after the %s changed", async (change) => {
  searchMock.mockResolvedValueOnce(page([project, second], 8));
  const late = deferredPage();
  searchMock.mockImplementationOnce(() => late.promise);
  await render();
  expect(current.hasMore).toBe(true);
  let pending!: Promise<void>;
  act(() => { pending = current.loadMore(); });

  searchMock.mockResolvedValue(page([fresh], 1));
  if (change === "query") {
    await act(async () => current.setSearch("new"));
  } else if (change === "sort") {
    await act(async () => current.setSort("downloads"));
  } else {
    await act(async () => current.setSource("curseforge"));
  }
  await flush();

  await act(async () => { late.resolve(page([more], 8)); await pending; });
  expect(current.resources).toEqual([fresh]);
});

it("refuses a second page while one is already loading", async () => {
  searchMock.mockResolvedValueOnce(page([project], 3));
  const first = deferredPage();
  searchMock.mockImplementationOnce(() => first.promise);
  await render();
  let firstLoad!: Promise<void>;
  act(() => { firstLoad = current.loadMore(); });
  await act(async () => { await current.loadMore(); });
  expect(searchMock).toHaveBeenCalledTimes(2);
  await act(async () => { first.resolve(page([second], 3)); await firstLoad; });
  expect(current.resources).toEqual([project, second]);
});

it("reports a failed page without dropping the current results", async () => {
  searchMock.mockResolvedValueOnce(page([project], 2));
  const failing = deferredPage();
  searchMock.mockImplementationOnce(() => failing.promise);
  await render();
  let pending!: Promise<void>;
  act(() => { pending = current.loadMore(); });
  await act(async () => { failing.reject({ code: "discover.modrinthUnreachable" }); await pending; });
  expect(current.resources).toEqual([project]);
  expect(current.loadMoreError).toBe("discover.modrinthUnreachable");
  expect(current.hasMore).toBe(true);
});

it("rejects a stale card action in the same event that changes the resource type", async () => {
  await render();
  expect(current.resources).toEqual([project]);
  const previous = current;
  await act(async () => {
    previous.setResourceType("resourcepack");
    await previous.installProject(project);
  });
  expect(command).not.toHaveBeenCalledWith("install_resource", expect.anything());
});

it("rejects a card action in the same event that retries its search", async () => {
  await render();
  expect(current.resources).toEqual([project]);
  const previous = current;
  await act(async () => {
    previous.setSearch("");
    await previous.installProject(project);
  });
  expect(command).not.toHaveBeenCalledWith("install_resource", expect.anything());
});

it("does not cancel an in-flight search when closing a project drawer", async () => {
  const pending = deferredPage();
  searchMock.mockImplementation(() => pending.promise);
  await act(async () => root.render(<Harness />));
  act(() => current.closeProject());
  await act(async () => pending.resolve(page([project])));
  expect(current.resources).toEqual([project]);
  expect(current.loading).toBe(false);
});

it("ignores an older search response after a more recent query succeeds", async () => {
  const pending = new Map<string, (value: Page) => void>();
  searchMock.mockImplementation((_name, args) => new Promise((resolve) => { pending.set(String(args.query), resolve); }));
  await act(async () => root.render(<Harness />));
  await act(async () => current.setSearch("a"));
  await act(async () => current.setSearch("ab"));
  const latest = { ...project, project_id: "latest", title: "Latest" };
  await act(async () => pending.get("ab")!({ hits: [latest] }));
  await act(async () => pending.get("a")!({ hits: [project] }));
  expect(current.resources).toEqual([latest]);
});

it.each(["success", "failure"] as const)("ignores a superseded same-query %s after the retry succeeds", async (outcome) => {
  let first!: ReturnType<typeof deferredPage>;
  let retry!: ReturnType<typeof deferredPage>;
  searchMock.mockImplementationOnce(() => (first = deferredPage()).promise)
    .mockImplementationOnce(() => (retry = deferredPage()).promise);
  await act(async () => root.render(<Harness />));
  await act(async () => current.setSearch(""));
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ query: "", offset: 0 })]);
  const latest = { ...project, project_id: "retry-result", title: "Retry result" };
  await act(async () => retry.resolve(page([latest])));
  await act(async () => {
    if (outcome === "success") first.resolve(page([project]));
    else first.reject(new Error("superseded request failed"));
  });
  expect(current.resources).toEqual([latest]);
  expect(current.loading).toBe(false);
  expect(current.stale).toBe(false);
  expect(current.error).toBe("");
});

it("keeps the retry pending when a superseded same-query request fails", async () => {
  const first = deferredPage();
  const retry = deferredPage();
  searchMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => retry.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => current.setSearch(""));
  await act(async () => first.reject(new Error("superseded request failed")));
  expect(current.loading).toBe(true);
  expect(current.error).toBe("");
  await act(async () => retry.resolve(page([project])));
  expect(current.resources).toEqual([project]);
  expect(current.loading).toBe(false);
});

it("uses the raw source offset and drops projects that are already shown", async () => {
  searchMock.mockResolvedValueOnce(page([project, second], 8, 3))
    .mockResolvedValueOnce(page([second, fresh], 8, 5))
    .mockResolvedValueOnce(page([], 8, 5));
  await render();
  expect(current.hasMore).toBe(true);

  await act(async () => { await current.loadMore(); });
  expect(current.resources.map(item => item.project_id)).toEqual(["old-mod", "second-mod", "fresh-mod"]);
  expect(current.focusId).toBe("fresh-mod");
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ offset: 3, limit: 24 })]);

  await act(async () => { await current.loadMore(); });
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ offset: 5, limit: 24 })]);
});

it("stops at the 10000 result window and requests only the remaining rows", async () => {
  searchMock.mockResolvedValueOnce(page([project], 20_000, 9_984))
    .mockResolvedValueOnce(page([fresh], 20_000, 10_000));
  await render();
  expect(current.hasMore).toBe(true);

  await act(async () => { await current.loadMore(); });
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ offset: 9_984, limit: 16 })]);
  expect(current.resources).toEqual([project, fresh]);
  expect(current.hasMore).toBe(false);
});

it("does not let a stale page clear the loading guard of a newer one", async () => {
  searchMock.mockResolvedValueOnce(page([project], 8, 1));
  const stale = deferredPage();
  searchMock.mockImplementationOnce(() => stale.promise);
  await render();
  let staleLoad!: Promise<void>;
  act(() => { staleLoad = current.loadMore(); });

  searchMock.mockResolvedValueOnce(page([second], 8, 1));
  await act(async () => current.setSearch("new"));
  await flush();
  const newer = deferredPage();
  searchMock.mockImplementationOnce(() => newer.promise);
  let newerLoad!: Promise<void>;
  act(() => { newerLoad = current.loadMore(); });

  await act(async () => { stale.resolve(page([more], 8, 2)); await staleLoad; });
  expect(current.loadingMore).toBe(true);
  await act(async () => { newer.resolve(page([more], 8, 2)); await newerLoad; });
  expect(current.resources.map(item => item.project_id)).toEqual(["second-mod", "more-mod"]);
  expect(current.loadingMore).toBe(false);
});

it("versions page uses the raw offset and drops rows that are already shown", async () => {
  searchMock.mockResolvedValueOnce(page([project], 1, 1));
  detailsMock.mockResolvedValueOnce(projectDetails(project, [version("v1")], true));
  versionsMock.mockResolvedValueOnce({ versions: [version("v1"), version("v2")], hasMore: true })
    .mockResolvedValueOnce({ versions: [version("v3")], hasMore: false });
  await render();
  await act(async () => { await current.loadProject(project); });
  await flush();
  expect(current.details?.versions.map(item => item.id)).toEqual(["v1"]);

  await act(async () => { await current.loadMoreVersions(); });
  expect(current.details?.versions.map(item => item.id)).toEqual(["v1", "v2"]);
  await act(async () => { await current.loadMoreVersions(); });
  expect(versionsMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ offset: 3 }));
  expect(current.details?.versions.map(item => item.id)).toEqual(["v1", "v2", "v3"]);
});

it("does not let a stale version page clear the loading guard of a newer one", async () => {
  searchMock.mockResolvedValueOnce(page([project, second], 2, 2));
  detailsMock.mockImplementation(async args => args?.projectId === project.project_id
    ? projectDetails(project, [version("a1")], true)
    : projectDetails(second, [version("b1")], true));
  const stale = deferredVersions();
  versionsMock.mockImplementationOnce(() => stale.promise);
  await render();
  await act(async () => { await current.loadProject(project); });
  await flush();
  let staleLoad!: Promise<void>;
  act(() => { staleLoad = current.loadMoreVersions(); });

  await act(async () => current.closeProject());
  await act(async () => { await current.loadProject(second); });
  await flush();
  expect(current.details?.versions.map(item => item.id)).toEqual(["b1"]);
  const newer = deferredVersions();
  versionsMock.mockImplementationOnce(() => newer.promise);
  let newerLoad!: Promise<void>;
  act(() => { newerLoad = current.loadMoreVersions(); });

  await act(async () => { stale.resolve({ versions: [version("a2")], hasMore: true }); await staleLoad; });
  expect(current.versionsLoading).toBe(true);
  await act(async () => { await current.loadMoreVersions(); });
  expect(versionsMock).toHaveBeenCalledTimes(2);
  await act(async () => { newer.resolve({ versions: [version("b2")], hasMore: false }); await newerLoad; });
  expect(current.details?.versions.map(item => item.id)).toEqual(["b1", "b2"]);
  expect(current.versionsLoading).toBe(false);
});

it("keeps a sort shared by both sources when the source changes", async () => {
  await render();
  await act(async () => current.setSort("downloads"));
  await flush();
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ sort: "downloads" })]);
  await act(async () => current.setSource("curseforge"));
  await flush();
  expect(lastSearch()).toEqual(["search_curseforge", expect.objectContaining({ sort: "downloads" })]);
  await act(async () => current.setSource("modrinth"));
  await flush();
  expect(lastSearch()).toEqual(["search_modrinth", expect.objectContaining({ sort: "downloads" })]);
});

it("falls back to the source default when the current sort is unsupported", async () => {
  await render();
  await act(async () => current.setSort("follows"));
  await flush();
  await act(async () => current.setSource("curseforge"));
  await flush();
  expect(lastSearch()).toEqual(["search_curseforge", expect.objectContaining({ sort: "downloads" })]);
});
