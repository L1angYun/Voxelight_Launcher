// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { command, searchResources, type ResourceProject } from "../../lib/launcher";
import { useDiscover } from "./useDiscover";

vi.mock("../../lib/launcher", () => ({ command: vi.fn(), searchResources: vi.fn() }));
vi.mock("../../app/controller/LauncherProvider", () => ({ useLauncher: () => ({
  selectedVersionId: "1.21.1", selectedInstance: { id: "fixture", loader: "fabric" },
  run: async (_name: string, action: () => Promise<void>) => action(), reload: async () => {}, selectInstance: () => {}, selectVersion: () => {},
}) }));
const project: ResourceProject = { project_id: "old-mod", slug: "old-mod", title: "Old mod", description: "", author: "", downloads: 0, icon_url: null, project_type: "mod", versions: [] };
let current: ReturnType<typeof useDiscover>;
let root: Root;
let container: HTMLDivElement;
function Harness() { current = useDiscover(); return null; }
function deferredSearch() {
  let resolve!: (items: ResourceProject[]) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<ResourceProject[]>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(searchResources).mockReset().mockResolvedValue([project]);
  vi.mocked(command).mockReset().mockImplementation(async name => name === "get_resource_context" ? { gameVersion: "1.21.1", loader: "fabric" } : null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("rejects a stale card action in the same event that changes the resource type", async () => {
  await act(async () => root.render(<Harness />));
  expect(current.resources).toEqual([project]);
  const previous = current;
  await act(async () => {
    previous.setResourceType("resourcepack");
    await previous.installProject(project);
  });
  expect(command).not.toHaveBeenCalledWith("install_resource", expect.anything());
});

it("rejects a card action in the same event that retries its search", async () => {
  await act(async () => root.render(<Harness />));
  expect(current.resources).toEqual([project]);
  const previous = current;
  await act(async () => {
    previous.setSearch("");
    await previous.installProject(project);
  });
  expect(command).not.toHaveBeenCalledWith("install_resource", expect.anything());
});

it("does not cancel an in-flight search when closing a project drawer", async () => {
  let finish!: (items: ResourceProject[]) => void;
  vi.mocked(searchResources).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Harness />));
  act(() => current.closeProject());
  await act(async () => finish([project]));
  expect(current.resources).toEqual([project]);
  expect(current.loading).toBe(false);
});

it("ignores an older search response after a more recent query succeeds", async () => {
  await act(async () => root.render(<Harness />));
  const finish = new Map<string, (items: ResourceProject[]) => void>();
  vi.mocked(searchResources).mockImplementation((query) => new Promise((resolve) => { finish.set(query, resolve); }));
  await act(async () => current.setSearch("a"));
  await act(async () => current.setSearch("ab"));
  const latest = { ...project, project_id: "latest", title: "Latest" };
  await act(async () => finish.get("ab")!([latest]));
  await act(async () => finish.get("a")!([project]));
  expect(current.resources).toEqual([latest]);
});

it.each(["success", "failure"] as const)("ignores a superseded same-query %s after the retry succeeds", async (outcome) => {
  const first = deferredSearch();
  const retry = deferredSearch();
  vi.mocked(searchResources).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => current.setSearch(""));
  expect(searchResources).toHaveBeenNthCalledWith(2, "", "mod", "1.21.1", "fabric");
  const latest = { ...project, project_id: "retry-result", title: "Retry result" };
  await act(async () => retry.resolve([latest]));
  await act(async () => {
    if (outcome === "success") first.resolve([project]);
    else first.reject(new Error("superseded request failed"));
  });
  expect(current.resources).toEqual([latest]);
  expect(current.loading).toBe(false);
  expect(current.stale).toBe(false);
  expect(current.error).toBe("");
});

it("keeps the retry pending when a superseded same-query request fails", async () => {
  const first = deferredSearch();
  const retry = deferredSearch();
  vi.mocked(searchResources).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => current.setSearch(""));
  expect(searchResources).toHaveBeenNthCalledWith(2, "", "mod", "1.21.1", "fabric");
  await act(async () => first.reject(new Error("superseded request failed")));
  expect(current.loading).toBe(true);
  expect(current.error).toBe("");
  await act(async () => retry.resolve([project]));
  expect(current.resources).toEqual([project]);
  expect(current.loading).toBe(false);
});
