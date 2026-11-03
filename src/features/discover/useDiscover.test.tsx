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
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(searchResources).mockReset().mockResolvedValue([project]);
  vi.mocked(command).mockReset().mockResolvedValue(null);
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
