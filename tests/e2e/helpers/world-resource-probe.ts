// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";

export interface WorldResourceSnapshot {
  worldContexts: number;
  worldCanvasCount: number;
  contextId: number | null;
  live: Record<string, number>;
  totalCreated: Record<string, number>;
  totalDeleted: Record<string, number>;
  duplicateDeletes: number;
  glErrors: number[];
  persistentListeners: Record<string, number>;
  listenerScope: string;
  /** Cumulative add observations excluded because they use once or signal. */
  ignoredOnceOrSignal: number;
}

type ProbeWindow = Window & {
  __voxelightWorldResourceProbe?: { snapshot(): WorldResourceSnapshot };
};

/** Install before navigation so allocations are observed from the first frame. */
export async function installWorldResourceProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as ProbeWindow;
    if (target.__voxelightWorldResourceProbe) return;

    const kinds = [
      ["texture", "Texture"], ["framebuffer", "Framebuffer"],
      ["renderbuffer", "Renderbuffer"], ["program", "Program"],
      ["shader", "Shader"], ["buffer", "Buffer"],
      ["vertexArray", "VertexArray"], ["query", "Query"],
    ] as const;
    const counts = (): Record<string, number> => Object.fromEntries(kinds.map(([kind]) => [kind, 0]));
    interface ContextState {
      id: number;
      gl: WebGL2RenderingContext;
      world: boolean;
      resources: Map<string, { live: Set<object>; deleted: WeakSet<object> }>;
      created: Record<string, number>;
      deleted: Record<string, number>;
      duplicateDeletes: number;
      errors: number[];
    }
    // Keep old context identities after their canvases detach to expose remounts
    // and allocations that were never released.
    const contexts = new Map<WebGL2RenderingContext, ContextState>();
    const isWorldCanvas = (canvas: HTMLCanvasElement | OffscreenCanvas) =>
      canvas instanceof HTMLCanvasElement && canvas.matches(".world-scene__canvas");

    interface ListenerState {
      target: WeakRef<EventTarget>;
      scope: "window" | "document" | "worldCanvas";
      world: boolean;
      registrations: WeakMap<object, Map<string, ListenerRegistration>>;
      aliases: WeakMap<object, object>;
      counts: Map<string, number>;
      ignoredOnceOrSignal: number;
    }
    interface ListenerRegistration {
      nativeListener: EventListener;
      counted: boolean;
      once: boolean;
      abort?: { signal: AbortSignal; listener: EventListener };
    }
    const listenerStates: ListenerState[] = [];
    const listenersByTarget = new WeakMap<EventTarget, ListenerState>();
    const listenerStateFor = (eventTarget: EventTarget, create: boolean) => {
      const scope = eventTarget === window ? "window" : eventTarget === document ? "document"
        : eventTarget instanceof HTMLCanvasElement ? "worldCanvas" : null;
      if (!scope) return undefined;
      let state = listenersByTarget.get(eventTarget);
      if (!state && create) {
        state = {
          target: new WeakRef(eventTarget), scope, world: false,
          registrations: new WeakMap(), aliases: new WeakMap(), counts: new Map(), ignoredOnceOrSignal: 0,
        };
        listenersByTarget.set(eventTarget, state);
        listenerStates.push(state);
      }
      if (state && eventTarget instanceof HTMLCanvasElement) state.world ||= isWorldCanvas(eventTarget);
      return state;
    };
    const nativeAddListener = EventTarget.prototype.addEventListener;
    const nativeRemoveListener = EventTarget.prototype.removeEventListener;
    function retireListener(state: ListenerState, callback: object, key: string, registration: ListenerRegistration) {
      const registrations = state.registrations.get(callback);
      if (registrations?.get(key) !== registration) return;
      registrations.delete(key);
      state.aliases.delete(registration.nativeListener);
      if (registration.counted) {
        const count = state.counts.get(key)! - 1;
        if (count) state.counts.set(key, count);
        else state.counts.delete(key);
      }
      if (registration.abort) {
        Reflect.apply(nativeRemoveListener, registration.abort.signal, ["abort", registration.abort.listener]);
        registration.abort = undefined;
      }
    }
    EventTarget.prototype.addEventListener = function (...args) {
      const [type, listener, options] = args;
      if (!listener || typeof listener !== "function" && typeof listener !== "object")
        return Reflect.apply(nativeAddListener, this, args);
      const state = listenerStateFor(this, true);
      if (!state) return Reflect.apply(nativeAddListener, this, args);
      const settings = typeof options === "object" && options ? options : undefined;
      const capture = settings ? Boolean(settings.capture) : Boolean(options);
      const key = `${type}:capture=${capture}`;
      const registrations = state.registrations.get(listener);
      const existing = registrations?.get(key);
      if (existing) return Reflect.apply(nativeAddListener, this, [type, existing.nativeListener, options]);
      const once = Boolean(settings?.once), signal = settings?.signal;
      let registration: ListenerRegistration;
      const nativeListener: EventListener = function (this: EventTarget, event) {
        // Native once listeners retire before invocation, including reentrant adds.
        if (registration.once) retireListener(state, listener, key, registration);
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      registration = { nativeListener, once, counted: !once && !signal };
      const result = Reflect.apply(nativeAddListener, this, [type, nativeListener, options]);
      // The native add performs validation and ignores an already-aborted signal.
      if (signal?.aborted) return result;
      if (registrations) registrations.set(key, registration);
      else state.registrations.set(listener, new Map([[key, registration]]));
      state.aliases.set(nativeListener, listener);
      if (registration.counted) state.counts.set(key, (state.counts.get(key) ?? 0) + 1);
      else state.ignoredOnceOrSignal++;
      if (signal) {
        const aborted: EventListener = () => retireListener(state, listener, key, registration);
        registration.abort = { signal, listener: aborted };
        Reflect.apply(nativeAddListener, signal, ["abort", aborted, { once: true }]);
      }
      return result;
    };
    EventTarget.prototype.removeEventListener = function (...args) {
      const [type, listener, options] = args;
      if (!listener) return Reflect.apply(nativeRemoveListener, this, args);
      const state = listenerStateFor(this, false);
      if (!state) return Reflect.apply(nativeRemoveListener, this, args);
      const capture = typeof options === "object" && options ? Boolean(options.capture) : Boolean(options);
      const key = `${type}:capture=${capture}`;
      // Node's native signal cleanup can call remove with the registered wrapper.
      const callback = state.aliases.get(listener) ?? listener;
      const registration = state.registrations.get(callback)?.get(key);
      const result = Reflect.apply(nativeRemoveListener, this, [type, registration?.nativeListener ?? listener, options]);
      if (registration) retireListener(state, callback, key, registration);
      return result;
    };

    const stateFor = (gl: WebGL2RenderingContext) => {
      let state = contexts.get(gl);
      if (!state) {
        state = {
          id: contexts.size + 1, gl, world: false,
          resources: new Map(kinds.map(([kind]) => [kind, { live: new Set<object>(), deleted: new WeakSet<object>() }])),
          created: counts(), deleted: counts(), duplicateDeletes: 0, errors: [],
        };
        contexts.set(gl, state);
      }
      state.world ||= isWorldCanvas(gl.canvas);
      return state;
    };

    const prototype = typeof WebGL2RenderingContext === "undefined" ? null : WebGL2RenderingContext.prototype;
    const nativeGetError = prototype?.getError;
    if (prototype) {
      type NativeMethod = (this: WebGL2RenderingContext, ...args: unknown[]) => unknown;
      const methods = prototype as unknown as Record<string, NativeMethod>;
      for (const [kind, suffix] of kinds) {
        const create = methods[`create${suffix}`];
        const remove = methods[`delete${suffix}`];
        methods[`create${suffix}`] = function (...args) {
          // Forward every argument, including the required createShader type.
          const resource = Reflect.apply(create, this, args) as object | null;
          const state = stateFor(this);
          if (resource !== null) {
            state.resources.get(kind)!.live.add(resource);
            state.created[kind]++;
          }
          return resource;
        };
        methods[`delete${suffix}`] = function (...args) {
          const result = Reflect.apply(remove, this, args);
          const resource = args[0];
          if (resource !== null && typeof resource === "object") {
            const state = stateFor(this);
            const resources = state.resources.get(kind)!;
            if (resources.live.delete(resource)) {
              resources.deleted.add(resource);
              state.deleted[kind]++;
            } else if (resources.deleted.has(resource)) {
              state.duplicateDeletes++;
            }
          }
          return result;
        };
      }

      // Record contexts with no allocations too; snapshots never call getContext.
      const canvasPrototype = HTMLCanvasElement.prototype as unknown as {
        getContext(this: HTMLCanvasElement, ...args: unknown[]): unknown;
      };
      const getContext = canvasPrototype.getContext;
      canvasPrototype.getContext = function (...args) {
        const context = Reflect.apply(getContext, this, args);
        if (context instanceof WebGL2RenderingContext) stateFor(context);
        return context;
      };
    }

    target.__voxelightWorldResourceProbe = {
      snapshot() {
        const canvases = document.querySelectorAll<HTMLCanvasElement>("canvas.world-scene__canvas");
        const world = [...contexts.values()].filter(state => {
          // The application can assign the canvas class after getting its context.
          state.world ||= isWorldCanvas(state.gl.canvas);
          return state.world;
        });
        const live = counts(), totalCreated = counts(), totalDeleted = counts();
        for (const state of world) {
          for (const [kind] of kinds) {
            live[kind] += state.resources.get(kind)!.live.size;
            totalCreated[kind] += state.created[kind];
            totalDeleted[kind] += state.deleted[kind];
          }
          // Probe error state only on request, with a fixed bound per context.
          if (nativeGetError) for (let i = 0; i < 32; i++) {
            const error = Reflect.apply(nativeGetError, state.gl, []) as number;
            if (error === state.gl.NO_ERROR) break;
            state.errors.push(error);
          }
        }
        const persistentListeners: Record<string, number> = {};
        let ignoredOnceOrSignal = 0;
        for (const state of listenerStates) {
          if (state.scope === "worldCanvas") {
            const canvas = state.target.deref();
            if (canvas instanceof HTMLCanvasElement) state.world ||= isWorldCanvas(canvas);
            if (!state.world) continue;
          }
          for (const [key, count] of state.counts) {
            const name = `${state.scope}:${key}`;
            persistentListeners[name] = (persistentListeners[name] ?? 0) + count;
          }
          ignoredOnceOrSignal += state.ignoredOnceOrSignal;
        }
        return {
          worldContexts: world.length,
          worldCanvasCount: canvases.length,
          contextId: world.find(state => state.gl.canvas === canvases[0])?.id ?? null,
          live, totalCreated, totalDeleted,
          duplicateDeletes: world.reduce((sum, state) => sum + state.duplicateDeletes, 0),
          glErrors: world.flatMap(state => state.errors),
          persistentListeners,
          listenerScope: "window/document/worldCanvas; non-once/no-signal registrations only; once/signal lifetimes excluded",
          ignoredOnceOrSignal,
        };
      },
    };
  });
}

export async function snapshotWorldResources(page: Page): Promise<WorldResourceSnapshot> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__voxelightWorldResourceProbe;
    if (!probe) throw new Error("Install the world resource probe before navigation.");
    return probe.snapshot();
  });
}
