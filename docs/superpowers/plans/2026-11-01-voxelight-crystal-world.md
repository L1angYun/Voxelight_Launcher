# Voxelight 结晶世界背景 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 WebGL2 结晶世界替换现有 Canvas 2D 方块墙，默认外观为地平线场景 + 点阵材质，并让背景响应真实启动进度。

**Architecture:** 纯逻辑（状态推导、导演、相机、字标、档位）与 WebGL2 渲染器分离，React 外壳只负责画布、观察器和指针事件。渲染器把导演每帧输出的 `WorldFrame` 画出来，不持有业务状态。粒子层只在点阵材质下启用，实体材质同时是不支持浮点渲染目标时的回退。

**Tech Stack:** React 19、TypeScript、原生 WebGL2（不引入 three.js 依赖）、Vitest、Playwright、Tauri 2 / Rust。

**Spec:** `docs/superpowers/specs/2026-11-01-voxelight-crystal-world-design.md`

**参考代码：** `docs/superpowers/reference/2026-11-01-crystal-world-concept.html` 是已确认观感的单文件概念实现，可运行查看，可移植其 GLSL、常量和算法，不要照搬其结构。它的模式 `A · 点阵` 和 `B · 点阵` 对应默认外观和山体外观。已知差异以规范为准：开场 6.6 秒（规范不超过 2.5 秒）、帧率不设上限、开场时隐藏启动按钮、无 scrim、未覆盖浅色主题，也没有接入真实进度。

**渲染参数：** 主要取值汇总在文末“附录：渲染参数”，与参考代码不一致时先告诉用户。

## Global Constraints

- 默认值：`worldScene: "horizon"`，`worldMaterial: "lattice"`；新安装和升级用户相同。
- 粒子预算：完全档 65,536 点（纹理 256²）+ 160×160 方块，DPR 上限 1.5；降档 DPR 1.0，再降 25,600 点（160²）+ 110×110 方块。
- 帧率：2026-11-02 用户明确取消 30/60 FPS 上限；完全档每个可用 rAF 绘制，静态、隐藏和运行后停绘规则保留。
- 开场全程不超过 2.5 秒，每次打开应用最多一次，只在首页播放；导航和启动按钮从第一帧起可用。
- 信号色只用 `--accent`，含用户自定义强调色；静止的点不使用信号色。
- 深色场景底色 `--world-ink: #07080b`，点色 `#ece7da`；不修改全局 `--bg-base`。
- 对比度：正文不低于 4.5:1，大标题不低于 3:1。
- 系统减少动态、精简档、高对比：单帧静态画面，无粒子模拟、无开场、无鼠标交互。
- 场景失败不能阻塞启动。玻璃系统不改动。
- 新代码放在 `src/components/world/`，TypeScript 文件首行沿用 `// SPDX-License-Identifier: GPL-3.0-only`。

## Review Focus

1. 在库页面启动、选中实例与运行实例不同、同时运行多个游戏：背景都应判定为运行中（Task 1）。
2. 准备到 80% 后取消或失败，再次启动：前沿应从 0 开始，而不是沿用上一次的最大值（Task 2）。
3. 开场中途开始启动游戏，或切到其他页面：开场立即结束，不与结晶前沿抢焦点（Task 2）。
4. 启动过程中 WebGL 上下文丢失：启动不受影响，背景恢复或退到 CSS 降级（Task 4）。
5. 运行时切换主题或强调色、按住文字或窗口拖动区：颜色即时更新且不重启；按压不触发融化（Task 5）。

---

## 前置条件

工作区存在大量未提交改动，涉及 `WorldScene.tsx`、`App.tsx`、`HomePage.tsx` 等本计划要修改的文件。开始第一个任务之前，由用户提交或确认这些改动，然后从结果上创建分支 `feat/crystal-world`。不要替用户提交或丢弃这些改动。

## 文件结构

| 路径 | 职责 |
|---|---|
| `src/components/world/types.ts` | 共享类型 |
| `src/components/world/deriveWorldState.ts` | 控制器状态 → 场景状态 |
| `src/components/world/presets.ts` | 场景预设常量 |
| `src/components/world/camera.ts` | 相机矩阵、射线求交 |
| `src/components/world/worldDirector.ts` | 目标值、弹簧、前沿、开场 |
| `src/components/world/wordmark.ts` | 字标粒子目标 |
| `src/components/world/qualityTier.ts` | 档位选择、降档、帧率上限 |
| `src/components/world/pointerTarget.ts` | 判断按压目标是否为空白处 |
| `src/components/world/shaders.ts` | GLSL 源码 |
| `src/components/world/renderer.ts` | WebGL2 上下文和各通道 |
| `src/components/WorldScene.tsx` | React 外壳（替换） |
| `src/components/WorldScene.css` | 画布和 CSS 降级样式（替换） |

删除：`src/components/cubeGeometry.ts`。

---

### Task 1: 配置字段与状态推导

**Files:**
- Create: `src/components/world/types.ts`, `src/components/world/deriveWorldState.ts`, `src/components/world/deriveWorldState.test.ts`
- Modify: `src/lib/launcher.ts:16-37,159`, `src-tauri/src/models.rs:22-27,55-60`, `src-tauri/src/storage.rs:66-84,555-566`, `src/features/settings/AppearanceSettings.tsx:78`, `src/i18n/locales/{zh-CN,en-US}/settings.json`, `tests/e2e/fixtures.ts:91`
- Test: `src/features/settings/SettingsPage.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type WorldSceneId = "horizon" | "massif";
  export type WorldMaterial = "lattice" | "solid";
  export type WorldPhase = "idle" | "preparing" | "running";
  export type WorldPage = "home" | "content";
  export interface WorldStatus { phase: WorldPhase; fraction: number | null } // fraction ∈ [0,1]；null 表示总量未知
  export function deriveWorldState(input: { busy: string; progress: Progress | null; running: readonly RunningGame[]; gamePid?: number }): WorldStatus;
  ```
- `Config` 增加 `worldScene: WorldSceneId`、`worldMaterial: WorldMaterial`。

- [ ] **Step 1: 写失败的测试**

`deriveWorldState.test.ts`：

```ts
const p = (o) => ({ operation: "", stage: "", completed: 0, total: 0, bytesCompleted: 0, bytesTotal: 0, message: "", versionId: "v", ...o });
it("running wins over preparing and needs no selected instance", () => {
  expect(deriveWorldState({ busy: "game.prepare", progress: null, running: [{} as RunningGame] }).phase).toBe("running");
  expect(deriveWorldState({ busy: "", progress: null, running: [], gamePid: 7 }).phase).toBe("running");
});
it("only game.prepare counts as preparing", () => {
  expect(deriveWorldState({ busy: "game.stop", progress: p({ completed: 1, total: 2 }), running: [] })).toEqual({ phase: "idle", fraction: null });
});
it("prefers bytes, then items, then unknown", () => {
  const f = (o) => deriveWorldState({ busy: "game.prepare", progress: p(o), running: [] }).fraction;
  expect(f({ bytesCompleted: 25, bytesTotal: 100, completed: 9, total: 10 })).toBe(.25);
  expect(f({ completed: 1, total: 4 })).toBe(.25);
  expect(f({})).toBeNull();
  expect(f({ completed: 5, total: 4 })).toBe(1);
});
```

`SettingsPage.test.tsx` 增加：选择场景和材质时 `onChange` 收到对应字段。`storage.rs` 的迁移测试在 `for field in [...]` 中加入 `"worldScene", "worldMaterial"`，并断言迁移后为 `"horizon"`、`"lattice"`。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/components/world src/features/settings/SettingsPage.test.tsx`；`cargo test --manifest-path src-tauri/Cargo.toml storage`
Expected: FAIL，模块或字段不存在。

- [ ] **Step 3: 实现**

Rust 字段名 `world_scene`、`world_material`，`storage.rs` 按 `effects` 的 `.entry().or_insert_with()` 写法补默认值。设置页在 `effects` 下方增加两个 `Select`，语言键：

| 键 | zh-CN | en-US |
|---|---|---|
| `fields.worldScene` | 世界场景 | World scene |
| `fields.worldMaterial` | 世界材质 | World material |
| `worldScene.horizon` | 地平线 | Horizon |
| `worldScene.massif` | 山体 | Massif |
| `worldMaterial.lattice` | 点阵 | Lattice |
| `worldMaterial.solid` | 实体 | Solid |

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/world src/lib/launcher.ts src-tauri/src src/features/settings src/i18n tests/e2e/fixtures.ts
git commit -m "feat: add world settings and derive world state"
```

### Task 2: 相机与导演

**Files:**
- Create: `src/components/world/presets.ts`, `camera.ts`, `camera.test.ts`, `worldDirector.ts`, `worldDirector.test.ts`（均在 `src/components/world/`）

**Interfaces:**
- Consumes: Task 1 的类型。
- Produces:
  ```ts
  export type Vec3 = [number, number, number];
  export interface Camera { viewProj: Float32Array; forward: Vec3; right: Vec3; up: Vec3; tanHalfFov: number; eye: Vec3 }
  export function makeCamera(eye: Vec3, at: Vec3, fovDeg: number, aspect: number): Camera;
  export function groundHit(cam: Camera, aspect: number, ndcX: number, ndcY: number, groundY?: number): [number, number] | null; // 射线不向下时返回 null

  export interface WorldInputs { phase: WorldPhase; fraction: number | null; page: WorldPage; scene: WorldSceneId; material: WorldMaterial }
  export interface WorldFrame {
    eye: Vec3; at: Vec3; fov: number; profile: number; mask: number; lat: number; island: number;
    exposure: number; fogD: number; bloom: number; horizon: number; runDim: number; dim: number;
    front: number; cry: number; charge: number; timeScale: number; simTime: number;
    ring: number;                                  // 粒子受力的环半径，非准备中为 0
    morph: { start: number; dur: number; toWord: boolean; fromWord: boolean; transit: number };
    introActive: boolean; settled: boolean; active: boolean;
  }
  export interface WorldDirector {
    setInputs(inputs: WorldInputs): void;
    beginIntro(): void; endIntro(): void;
    noteInteraction(now: number): void;
    step(dtSeconds: number, now: number): WorldFrame;
  }
  export function createWorldDirector(initial: WorldInputs): WorldDirector;
  export const FRONT_MAX = 165;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
const run = (d, s) => { let f; for (let i = 0; i < s * 60; i++) f = d.step(1 / 60, i); return f; };
const start = { phase: "idle", fraction: null, page: "home", scene: "horizon", material: "lattice" };

it("front follows real progress and never retreats within one preparation", () => {
  const d = createWorldDirector(start);
  d.setInputs({ ...start, phase: "preparing", fraction: .5 });
  expect(run(d, 3).front).toBeCloseTo(.5 * FRONT_MAX, 0);
  d.setInputs({ ...start, phase: "preparing", fraction: .2 });
  expect(run(d, 1).front).toBeCloseTo(.5 * FRONT_MAX, 0);
});
it("unknown totals creep up to 15%", () => {
  const d = createWorldDirector(start);
  d.setInputs({ ...start, phase: "preparing", fraction: null });
  expect(run(d, 120).front).toBeLessThanOrEqual(.15 * FRONT_MAX + 1e-6);
});
it("entering running fills the front within 600ms", () => {
  const d = createWorldDirector(start);
  d.setInputs({ ...start, phase: "preparing", fraction: .1 }); run(d, 1);
  d.setInputs({ ...start, phase: "running", fraction: null });
  expect(run(d, .6).front).toBeCloseTo(FRONT_MAX, 0);
});
it("cancel retreats, and the next launch restarts from zero", () => {
  const d = createWorldDirector(start);
  d.setInputs({ ...start, phase: "preparing", fraction: .8 }); run(d, 3);
  d.setInputs(start);
  expect(run(d, 3).cry).toBe(0);
  d.setInputs({ ...start, phase: "preparing", fraction: .05 });
  expect(run(d, 2).front).toBeCloseTo(.05 * FRONT_MAX, 0);
});
it("running settles so the renderer can stop", () => {
  const d = createWorldDirector({ ...start, phase: "running" });
  expect(run(d, 5).settled).toBe(true);
});
it("intro lasts at most 2.5s and ends early on launch or leaving home", () => {
  const d = createWorldDirector(start); d.beginIntro();
  expect(d.step(1 / 60, 0).introActive).toBe(true);
  expect(run(d, 2.5).introActive).toBe(false);
  const e = createWorldDirector(start); e.beginIntro(); e.step(.1, 0);
  e.setInputs({ ...start, phase: "preparing", fraction: 0 });
  expect(e.step(.01, 100).introActive).toBe(false);
  const g = createWorldDirector(start); g.beginIntro(); g.step(.1, 0);
  g.setInputs({ ...start, page: "content" });
  expect(g.step(.01, 100).introActive).toBe(false);
});
it("solid material has no lattice, and content page dims", () => {
  expect(run(createWorldDirector({ ...start, material: "solid" }), 5).lat).toBeCloseTo(0, 2);
  expect(run(createWorldDirector({ ...start, page: "content" }), 5).runDim).toBeCloseTo(.5, 2);
});
it("a huge dt after sleep does not jump the simulation", () => {
  const d = createWorldDirector(start);
  const a = d.step(0, 0).simTime;
  expect(d.step(30, 30000).simTime - a).toBeLessThanOrEqual(.05);
});
```

`camera.test.ts`：`groundHit` 对正下方射线返回眼点正下方；射线向上返回 `null`；`viewProj` 把 `at` 映射到 NDC 中心（x、y 约为 0）。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/components/world/camera.test.ts src/components/world/worldDirector.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `camera.ts`、`presets.ts` 和 `worldDirector.ts`**

预设取附录 A.1，lat 由材质决定。

导演规则：
- `step` 内把 dt 截断到 0.05；相机和标量用 `1 - exp(-dt * 2.4)` 趋近目标，push 用速率 1.3。
- 目标 `front`：准备中为 `max(已达值, fraction × FRONT_MAX)`；未知时每秒增加 `FRONT_MAX × 0.02`，封顶 15%；运行中 600ms 内线性到 `FRONT_MAX`。准备信号的收敛及未知总量推进同样使用真实经过时间，不随 GPU 帧数变慢；粒子模拟仍限制单步时间。
- 离开准备和运行后，`cry` 按真实经过时间每秒减 75；`cry` 归零时重置 `front`。数据前沿与物理步长分离，避免低帧率把停止／取消反馈拖长；`simTime` 单步仍限制到 0.05。
- 运行中 `exposure` 趋向 0.3，`bloom` 0.1，`runDim` 0.3，`timeScale` 0.12；曝光收敛后 `settled = true`。
- 内容页：`runDim` 0.5，`dim` 0.55，机位取 `LIST_CAM`。
- 场景、材质或页面变化时写入 `morph = { start: simTime, dur: 1.2, toWord: false, fromWord: false, transit: 26 }`。
- 开场时序：汇聚 0.9 秒（`toWord: true, transit: 10`）→ 停留至 1.4 秒 → 散开 1.1 秒（`fromWord: true, transit: 16`）。开场中 `island` 目标为 0。
- `active`：开场、准备中、切换后 2 秒内或距 `noteInteraction` 不到 1 秒时为 true。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/world
git commit -m "feat: add world camera and director"
```

### Task 3: 字标、档位与按压目标

**Files:**
- Create: `wordmark.ts`, `wordmark.test.ts`, `qualityTier.ts`, `qualityTier.test.ts`, `pointerTarget.ts`, `pointerTarget.test.ts`（均在 `src/components/world/`）

**Interfaces:**
- Consumes: Task 2 的 `Camera`。
- Produces:
  ```ts
  export function buildWordTargets(cam: Camera, aspect: number, side: number, random?: () => number): Float32Array; // side²×4；每第 9 个点 w=1

  export interface Tier { kind: "animated" | "static" | "css"; particleSide: 256 | 160 | 0; grid: 160 | 110; dprCap: 1.5 | 1; forceSolid: boolean }
  export function selectTier(cap: { webgl2: boolean; floatTargets: boolean; effects: EffectsLevel; reducedMotion: boolean; highContrast: boolean }): Tier;
  export function nextTier(tier: Tier): Tier | null;
  export function createFrameBudget(budgetMs: number, windowMs?: number): { sample(dtMs: number): "hold" | "downgrade" };

  export function isBlankPress(target: EventTarget | null): boolean;
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// qualityTier
it("full capability", () => expect(selectTier(full)).toEqual({ kind: "animated", particleSide: 256, grid: 160, dprCap: 1.5, forceSolid: false }));
it("lite, reduced motion, high contrast are static", () => {
  for (const o of [{ effects: "lite" }, { reducedMotion: true }, { highContrast: true }]) expect(selectTier({ ...full, ...o }).kind).toBe("static");
});
it("no webgl2 is css; no float targets forces solid", () => {
  expect(selectTier({ ...full, webgl2: false }).kind).toBe("css");
  expect(selectTier({ ...full, floatTargets: false })).toMatchObject({ forceSolid: true, particleSide: 0 });
});
it("ladder goes dpr first, then counts, then stops", () => {
  let t = selectTier(full);
  t = nextTier(t); expect(t).toMatchObject({ dprCap: 1, particleSide: 256 });
  t = nextTier(t); expect(t).toMatchObject({ particleSide: 160, grid: 110 });
  expect(nextTier(t)).toBeNull();
});
it("downgrades only after a sustained 2s overrun", () => {
  const b = createFrameBudget(16.7);
  expect(b.sample(40)).toBe("hold");
  let r; for (let i = 0; i < 60; i++) r = b.sample(40);
  expect(r).toBe("downgrade");
});
// 2026-11-02 用户取消帧率上限；外壳测试断言完全档每个可用 rAF 都绘制。
```

`wordmark.test.ts`：长度 `256*256*4`；`w=1` 的点数等于 `Math.ceil(65536/9)`；传入固定 `random` 时结果确定；所有目标在相机前方。

`pointerTarget.test.ts`（`// @vitest-environment jsdom`）：`button`、`a`、`input`、`select`、`[data-tauri-drag-region]`、带文本节点的元素及其子孙返回 `false`；`null` 返回 `false`；空的 `div` 返回 `true`。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/components/world/wordmark.test.ts src/components/world/qualityTier.test.ts src/components/world/pointerTarget.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

字形和几何取附录 A.5。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/world
git commit -m "feat: add wordmark targets, quality tiers and press filter"
```

### Task 4: 渲染器与实体材质，替换旧背景

**Files:**
- Create: `src/components/world/shaders.ts`, `src/components/world/renderer.ts`
- Modify（替换）: `src/components/WorldScene.tsx`, `src/components/WorldScene.css`, `src/components/WorldScene.test.tsx`
- Delete: `src/components/cubeGeometry.ts`, `src/visual/overture/OvertureScene.tsx`
- Modify: `src/app/App.tsx:36-42`, `tests/unit/character-animation.test.mjs:120,128-133,262,289`, `tests/e2e/global-glass.spec.ts:17,173-175`, `tests/e2e/round6-acceptance.spec.ts:130-184`, `tests/e2e/round12-runtime-probe.spec.ts:4`, `tests/e2e/round15-runtime.spec.ts:1-37`

**Interfaces:**
- Consumes: Task 2 的 `WorldFrame`、`createWorldDirector`，Task 3 的 `Tier`、`selectTier`、`nextTier`、`createFrameBudget`。
- Produces:
  ```ts
  export interface WorldPalette { ink: RGB; point: RGB; accent: RGB; haze: RGB; light: boolean }
  export interface WorldRenderer {
    resize(cssWidth: number, cssHeight: number, dpr: number): void;
    setTier(tier: Tier): void;
    setPalette(palette: WorldPalette): void;
    setAnchor(ndc: [number, number]): void;
    setPointer(ndc: [number, number] | null): void;
    draw(frame: WorldFrame, dtSeconds: number): void;
    dispose(): void;
  }
  export function createWorldRenderer(canvas: HTMLCanvasElement, callbacks: { onLost(): void; onRestored(): void }): WorldRenderer | null; // 无 WebGL2 返回 null
  ```
- `WorldScene` 整体重写，不兼容旧接口。属性：`{ className?: string; phase: WorldPhase; fraction: number | null; page: WorldPage; scene: WorldSceneId; material: WorldMaterial; paused?: boolean; effects?: EffectsLevel; reducedMotion?: boolean }`。旧的 `WorldSceneState`、`onCameraFrame`、`CUBE_*` 导出全部删除。
- 本任务中 `App.tsx` 传 `phase="idle"`、`fraction={null}`、`page` 由当前页面得出、`scene` 和 `material` 取自 `config`；Task 6 再接入真实状态。
- 删除 `OvertureScene.tsx` 后，从 `character-animation.test.mjs` 移除 `renderScene`、`Probe`（若不再使用）和第 262、289 行的两个用例；`CharacterCanvas` 自身的动画用例保留。`overture.css` 不动，其中的 `.vx-character-placeholder` 仍在使用。
- DOM 约定：单个画布 `.world-scene__canvas`；根节点 `data-world-tier`（`animated`、`static`、`css`）、`data-world-material`、`data-world-phase`、`data-world-frames`（已绘制帧数）、`data-motion`、`data-paused`。

- [ ] **Step 1: 重写单元测试（失败）**

`WorldScene.test.tsx` 整体替换（`// @vitest-environment jsdom`，`getContext` 用可控假对象）：

```tsx
it("falls back to css without WebGL2", ...)     // data-world-tier="css"，无抛错
it("static tier draws exactly one frame", ...)   // effects:"lite"：requestAnimationFrame 未被调度，draw 调用 1 次
it("paused requests no frames", ...)
it("disposes the renderer on unmount", ...)      // cancelAnimationFrame + 监听器移除
it("reads palette again when data-theme changes", ...)
```

`renderer` 通过 `vi.mock("./world/renderer")` 替换，这里只测外壳。

- [ ] **Step 2: 改写端到端测试（失败）**

- 选择器统一为 `.world-scene__canvas`；`global-glass` 的画布数量从 2 改为 1。
- `round15` 的 `canvasHash` 和 `round6` 的 `toDataURL` 改为 `data-world-frames` 断言，并用 `page.screenshot({ clip })` 比较可见像素（WebGL 画布不保留绘制缓冲，不能直接读取）。
- `round6` 第 164 行“四边留白”测试删除，新背景是满屏的。
- 减少动态：`data-world-frames` 在 400ms 内不增长，截图不变。
- 新增 `world context loss keeps launcher usable`：调用 `WEBGL_lose_context.loseContext()`，断言启动按钮可点、`data-world-tier` 为 `css` 或恢复后继续增长。

Run: `npx playwright test tests/e2e/global-glass.spec.ts tests/e2e/round15-runtime.spec.ts`
Expected: FAIL，找不到 `.world-scene__canvas`。

- [ ] **Step 3: 实现 `shaders.ts`**

按附录 A.2、A.3 编写地形、方块、天空和后处理着色器。保留热度衰减里的 `-2./255.`，否则 RGBA8 舍入会让热度卡住、地形残留信号色。网格大小由 uniform 传入，不写死 160。

- [ ] **Step 4: 实现 `renderer.ts`（实体材质）**

地形通道、天空、实例化方块、辉光、合成。`light` 时关闭辉光，雾色取 `--bg-base`。监听 `webglcontextlost`（调用 `preventDefault`）和 `webglcontextrestored`（重建全部资源）；恢复失败或第二次丢失后调用 `onLost`，由外壳切到 `css`。

- [ ] **Step 5: 实现 `WorldScene.tsx` 和 CSS**

外壳沿用现有的 `useMediaQuery`、可见性、`IntersectionObserver`、`ResizeObserver` 和主题 `MutationObserver` 写法。从 `--accent`、`--bg-base` 读调色板；无法解析的颜色回退 `#b4f17a`。按 2026-11-02 用户修订，主循环每个可用 rAF 绘制，`frame.settled` 或 `paused` 时停止调度。分别记录 CPU/GPU 耗时及回调间隔；GPU 计时不可用时以独立 rAF 间隔回退，预算窗口不混用来源。`createFrameBudget(16.7)` 返回 `downgrade` 时 `setTier(nextTier(tier))`，为 `null` 时保持。删除 `::before`、`::after` 光束。CSS 降级：`--world-ink` 底色加 `radial-gradient` 点阵，深浅主题都定义。

- [ ] **Step 6: 运行全部相关测试**

Run: `npx vitest run src/components`；`npx playwright test tests/e2e/global-glass.spec.ts tests/e2e/round6-acceptance.spec.ts tests/e2e/round12-runtime-probe.spec.ts tests/e2e/round15-runtime.spec.ts`；`npx tsc -b`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/components tests/e2e
git commit -m "feat: replace cube wall with WebGL2 solid world"
```

### Task 5: 粒子层与鼠标交互

**Files:**
- Modify: `src/components/world/shaders.ts`, `src/components/world/renderer.ts`, `src/components/WorldScene.tsx`, `src/components/WorldScene.test.tsx`
- Test: `tests/e2e/world-lattice.spec.ts`（新建）
- Create: `docs/world-performance.md`

**Interfaces:**
- Consumes: Task 3 的 `buildWordTargets`、`isBlankPress`，Task 4 的 `WorldRenderer`。
- Produces: `WorldRenderer` 增加 `press(ndc: [number, number]): void`、`release(): void`、`shock(ndc: [number, number]): void`。

- [ ] **Step 1: 写失败的测试**

`WorldScene.test.tsx`：
```tsx
it("press on blank area on home calls renderer.press", ...)
it("press on a button or text does not", ...)
it("press on content page does not", ...)
it("tap under 300ms with little melt calls shock; hold does not", ...)
it("no float targets renders solid and reports data-world-material=solid", ...)
```

`world-lattice.spec.ts`：默认 `data-world-material="lattice"`、`data-world-tier="animated"`；移动鼠标后 `data-world-frames` 增长；切换设置到实体后 `data-world-material="solid"`；运行时修改 `--accent` 后不报错且帧继续增长；按住 `.vx-home__console-name` 后拖动，文字选择结果不受影响。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/components/WorldScene.test.tsx`；`npx playwright test tests/e2e/world-lattice.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现粒子通道**

按附录 A.4 编写粒子模拟和点绘制：MRT 位置和速度纹理（RGBA32F，`EXT_color_buffer_float`）。点通道关闭深度写入，`blendFunc(ONE, ONE)`；`light` 时改为普通混合，点色取 `--text-primary`。粒子边长由 `tier.particleSide` 决定，变化时重建。降档重建时从当前地形生成初始位置，不触发散布。

- [ ] **Step 4: 实现指针事件**

沿用现有窗口级 `pointermove`。`pointerdown` 仅在 `page === "home"` 且 `isBlankPress(event.target)` 时调用 `renderer.press`。`pointerup`：按压不足 300ms 且融化值低于 0.3 时调用 `shock`。静态档和粗指针不注册。任何指针活动调用 `director.noteInteraction`。

- [ ] **Step 5: 运行并确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 6: 性能检查**

运行 `npm run desktop:dev`，在开发者工具中注入 rAF 差值采样，点阵和实体材质分别在空闲和鼠标交互下采样 10 秒，算 p50、p95。请用户在 Windows“图形设置”里分别把应用指定为高性能（RTX 5080）和节能（Intel 集成显卡），这是系统设置，由用户操作。把设备、WebView2 版本、分辨率和各档结果写入 `docs/world-performance.md`。

通过标准：集成显卡 25,600 点档 p95 不超过 33ms。未通过时停下，把数据告诉用户，由用户确认后再调整 `selectTier`（如该类设备默认回退实体材质）。

2026-11-02 用户确认：RTX 完整原生界面实测通过后，允许继续 Task 6–8，Intel 测量改为最终人工验收。Intel 未测不得标成通过；这项延期不授权擅自修改设备回退预算。

- [ ] **Step 7: Commit**

```bash
git add src/components tests/e2e/world-lattice.spec.ts docs/world-performance.md
git commit -m "feat: add lattice particle layer and pointer field"
```

### Task 6: 连接真实状态

**Files:**
- Modify: `src/app/App.tsx:28-42`, `src/features/home/HomePage.tsx:256`, `src/components/WorldScene.tsx`
- Test: `tests/e2e/world-lattice.spec.ts`, `src/components/WorldScene.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `deriveWorldState`、`Config.worldScene`、`Config.worldMaterial`。
- DOM 约定：首页 `.vx-home__char-col` 增加 `data-world-anchor`。`WorldScene` 在尺寸变化和页面变化时用其底部中点作为结晶起点；不存在时用 NDC `(0.62, -0.66)`。根节点增加 `data-world-front`（四舍五入的前沿值）。

- [ ] **Step 1: 写失败的测试**

`WorldScene.test.tsx`：`it("uses the anchor element and falls back when it is gone", ...)`，含窗口尺寸变化后重新测量。

`world-lattice.spec.ts`，使用 `fixtures.ts:335` 已有的进度事件：
```ts
test("launch drives the crystal front and stop returns to idle", async ({ page }) => {
  // 点击启动 → data-world-phase="preparing" → data-world-front 递增
  // → 游戏启动后 data-world-phase="running"，data-world-frames 最终停止增长
  // → 停止游戏 → data-world-phase="idle"，data-world-front 归零
});
test("launching from the library page also drives the world", ...);
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/components/WorldScene.test.tsx`；`npx playwright test tests/e2e/world-lattice.spec.ts`
Expected: FAIL，`data-world-phase` 始终是 `idle`。

- [ ] **Step 3: 实现**

`App.tsx` 从 `useLauncher` 取 `busy`、`progress`、`running`、`gamePid`、`config`，用 `useMemo` 调用 `deriveWorldState`，把 `phase` 和 `fraction` 传给 `WorldScene`，取代 Task 4 中写死的 `phase="idle"`。

- [ ] **Step 4: 运行并确认通过**

Run: 同 Step 2；再运行 `npx vitest run src/features/home`。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx src/features/home/HomePage.tsx src/components tests/e2e/world-lattice.spec.ts
git commit -m "feat: drive world state from launcher progress"
```

### Task 7: 开场、字体、scrim 与浅色主题

**Files:**
- Modify: `src/components/WorldScene.tsx`, `src/components/world/renderer.ts`, `src/design/fonts.css`, `src/design/tokens.css`, `src/features/home/home.css`, `src/features/home/HomePage.tsx`, `THIRD_PARTY_NOTICES.md`, `package.json`（如 `license:check` 需要）
- Create: `public/fonts/Doto-Black.woff2`, `licenses/fonts/Doto/OFL.txt`
- Test: `src/components/WorldScene.test.tsx`, `tests/e2e/world-lattice.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `beginIntro`、`endIntro`、`frame.introActive`。
- DOM 约定：`document.documentElement.dataset.worldIntro` 为 `"on"` 或 `"off"`；首页标题区在 `"on"` 时透明，启动控件不受影响。`--font-matrix: "Doto", var(--font-mono)`。

- [ ] **Step 1: 写失败的测试**

`WorldScene.test.tsx`：
```tsx
it("plays the intro once per process on home only", ...)   // 卸载重挂不再播放；挂载于内容页不播放
it("skips the intro on static tier", ...)
it("a press ends the intro", ...)
```

`world-lattice.spec.ts`：
- 开场中启动按钮可见且可点击；3 秒内 `dataset.worldIntro` 变为 `"off"`。
- `.vx-launch-console__progress-text` 计算字体包含 `Doto`，字号不小于 15px。

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run src/components/WorldScene.test.tsx`；`npx playwright test tests/e2e/world-lattice.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现开场**

模块级布尔值记录本进程是否已播放。开场中渲染器用 `buildWordTargets` 生成目标。任何按压、启动或离开首页调用 `endIntro`。

- [ ] **Step 4: 加入 Doto 字体**

从 Google Fonts 的 Doto 发布版取 Black 字重，转 woff2 放入 `public/fonts/`，附 OFL 许可证并更新 `THIRD_PARTY_NOTICES.md`，运行 `npm run license:check`。只用于 `.vx-launch-console__progress-text`。

- [ ] **Step 5: 加 scrim 与浅色主题**

`home.css` 给 `.vx-home__stage` 增加局部渐变 scrim，用 `--world-ink` 或浅色的 `--bg-base` 混合。`tokens.css` 定义 `--world-ink`（深色 `#07080b`，浅色取 `--bg-base`）。

- [ ] **Step 6: 运行并确认通过**

Run: 同 Step 2；再运行 `npm run license:check`。Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/components src/design src/features/home public/fonts licenses THIRD_PARTY_NOTICES.md package.json tests/e2e/world-lattice.spec.ts
git commit -m "feat: add world intro, matrix type and text scrim"
```

### Task 8: 验收

**Files:**
- Modify: `docs/world-performance.md`
- Create: `tests/e2e/world-acceptance.spec.ts`

**Interfaces:** 无新增接口。这一步可能修改 scrim 强度、点密度和浅色主题默认值。

- [ ] **Step 1: 写对比度和资源测试**

`world-acceptance.spec.ts`：
```ts
for (const theme of ["dark", "light"]) for (const size of [[1050, 720], [1440, 1000]]) {
  test(`${theme} ${size}: home text contrast holds at worst frames`, ...);
  // 空闲、准备中前沿经过、运行中，对标题和正文所在区域截图，取最不利像素计算：正文 ≥ 4.5，大标题 ≥ 3
}
test("repeated page and setting switches do not leak", ...);
// 往返切页 30 次、切换设置 10 次后：画布数量为 1，data-world-frames 继续增长，无新增控制台错误
```

- [ ] **Step 2: 运行并按结果调整**

Run: `npx playwright test tests/e2e/world-acceptance.spec.ts`
Expected: PASS。不达标时调整 `home.css` 的 scrim；浅色主题观感或对比度仍不达标时，按规范第 9 节让浅色主题默认实体材质，并把这个决定告诉用户。

- [ ] **Step 3: 完整界面性能测量**

重复 Task 5 的性能检查步骤，这次在全部功能完成后的完整应用中测量（含玻璃和角色）。标准：RTX 5080 完全档 p95 不超过 16.7ms；Intel 集成显卡自动降档后 p95 不超过 33ms。结果写入 `docs/world-performance.md`，注明不代表所有低配设备。显卡切换由用户操作。

- [ ] **Step 4: 全量回归**

Run: `npm test`；`npm run test:e2e`；`npm run build`；`cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 全部通过。失败项如实报告，不跳过。

- [ ] **Step 5: 人工视觉确认**

请用户在 `npm run desktop:dev` 中确认：两个场景、两种材质、深浅主题、1050×720 和最大化，以及完整启动流程。

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/world-acceptance.spec.ts docs/world-performance.md src
git commit -m "test: add crystal world acceptance checks"
```

---

## 附录：渲染参数

下列取值来自已确认观感的概念验证，是实现的起点。视觉验收时可以微调，但要保持规范第 3 节的表现。

### A.1 预设

| | 地平线 | 山体 |
|---|---|---|
| eye | (-6, 14, 37) | (-22, 33, 62) |
| at | (2, 18.5, -40) | (-3, 8, -12) |
| fov | 36 | 34 |
| profile / mask | 0 / 0 | 1 / 1 |
| exposure | 1 | 0.95 |
| fogD | 150 | 190 |
| bloom（实体 / 点阵） | 0.6 / 0.8 | 0.7 / 0.8 |
| horizon（实体 / 点阵） | 0.6 / -1 | -1 / -1 |
| island（点阵） | 9 | 5 |
| 内容页 eye | (-6, 34, 40) | (-22, 46, 66) |
| 内容页 at | (0, 2, -46) | (-3, 6, -14) |

内容页 exposure 0.42，horizon -1，bloom 实体 0.25、点阵 0.4。准备中相机沿视线推近 9%（高度只推 40%）。

共用常量：网格偏移 `(0, -46)`；太阳方向 `normalize(0.72, 0.4, 0.16)`；雾色 `(0.25, 0.27, 0.32)`，随 `profile * 0.8` 和 `lat` 趋向墨色 `(0.027, 0.031, 0.043)`。

### A.2 地形通道

输出 RGBA8：RG 为 16 位高度（`h / 40`），B 为受光，A 为热度。`p` 是世界坐标 xz，`fbm` 为 4 层值噪声（每层频率 ×2.03，振幅 ×0.5）。

```glsl
float H(vec2 p) {
  float n = fbm(p * .035 + vec2(t * .006, 0.));
  float ridge = 1. - abs(2. * n - 1.);
  float far = 1. - smoothstep(-122., -48., p.y);
  float a = 1. + 9. * n * n + far * ridge * ridge * 25. + .5 * sin(dot(p, vec2(.13, .09)) + t * .5);
  float m = 1. - smoothstep(8., 60., length((p - vec2(24., -16.)) * vec2(1., .8)));
  float b = m * m * (4. + pow(fbm(p * .05 + vec2(t * .005, 3.)), 1.4) * 52.) + .25 * sin(dot(p, vec2(.1, .14)) + t * .5) * m;
  float raw = mix(a, b, profile);
  float fl = floor(raw);
  return fl + smoothstep(.82, 1., raw - fl);   // 方块逐级跳变
}
```

- **阴影：** 8 步，`d = i * 2.6`，`s = max(s, smoothstep(0., 1.6, H(p + sunXZ * d) - (h + d * .42)))`。
- **云影：** `cloud = (.42 + .58 * smoothstep(.36, .58, fbm(p * .022 + vec2(-t * .022, t * .008) + 4.))) * mix(.5, 1., smoothstep(-34., 26., p.x))`。B 通道为 `(1. - s) * cloud`。
- **鼠标：** `pulse = exp(-pow(d / 4.5, 2.)) * ptrOn`，`h += pulse * 1.5`。
- **前沿：** `ring = exp(-pow((d0 - front) / 3.2, 2.))`，`h += ring * 3.2`，仅准备中生效；环不写入热度，否则热度拖尾会淹没地形。
- **余烬：** `hash(p) > .994` 时 `pow(max(0., sin(t * .3 + id * 900.)), 60.) * .5`。
- **热度：** `max(max(0., prev * decay - 2. / 255.), max(pulse * .72, ember))`，`decay = pow(.16, dt)`。

### A.3 方块、天空与后处理

```glsl
float maskM(vec2 c) {
  float q = 1. - (length((c - vec2(24., -16.)) * vec2(1., .8)) - 14.) / 64.;
  return clamp(1. - mask * (1. - smoothstep(0., 1., q)), 0., 1.);
}
float crystal(vec2 c, float heat, float m) {
  float d = length(c - origin);
  float island = 1. - smoothstep(islandR, islandR + 18., d);
  float front = cry > 0. ? 1. - smoothstep(cry - 16., cry, d) : 0.;
  float trail = smoothstep(.56, .7, heat) * .8;
  float core = mask * m * m;
  float melt = meltAmt * exp(-pow(length(c - meltAt) / 9., 2.));
  return mix(1., max(max(island, front), max(trail, core)) * (1. - melt), lat);
}
```

- **尺寸：** `crE = smoothstep(0., 1., cr)`；`s = mix(.13, .97, m * m) * mix(1., step(.03, cr) * mix(.16, 1., crE), lat)`；柱深 `mix(s, 9., m * mix(1., crE, lat))`。方块只画 5 个面，不画底面。
- **颜色：**
  - `alb = mix(vec3(.26, .27, .28), vec3(1., .97, .9), smoothstep(4., 17., h))`，再 `mix(bone * .62, alb, smoothstep(0., .35, m))`。
  - `col = alb * (vec3(.05, .06, .085) + vec3(2.5, 2.1, 1.62) * max(dot(N, sun), 0.) * lit)`，加 `alb * vec3(.03, .05, .08) * max(N.z, 0.)`。
  - 顶面边缘：`col += smoothstep(.45, .5, max(|x|, |z|)) * .035 * (.2 + lit)`。
  - 结晶蓄能：`mix(col, col * .55 + accent * .3 * (.25 + lit), chg * .55)`。
  - 热度：`mix(col, accent * (1. + heat * 1.2), clamp(heat * 1.05, 0., 1.) * dim * (1. - .7 * lat))`。
  - 雾：`(1. - exp(-pow(d / fogD, 2.4))) * .96`。
- **天空：** `t = smoothstep(0., .5, uv.y - horizon)`，`mix(haze, ink, pow(t, .55))`。点阵材质叠加屏幕空间点阵，间距 `round(W / 62)` 像素，亮度 `.2 * lat * runDim`。
- **后处理：** 4× MSAA；1/4 分辨率提取高光（阈值 `smoothstep(.6, .82, max(r, g, b))`），高斯模糊 4 次（权重 .227、.316、.07，偏移 1.38、3.23），叠加强度取 `bloom`；合成时加 ±0.5/255 抖动防止色带。

### A.4 粒子

模拟采用 Lattice `lattice/src/gl/field.js` 的方法：每点一个目标，弹簧牵引，按顺序释放，流场带动。

- **目标：** 地面点为 `(x, h + .62, z)`；字标点取字标纹理。
- **释放：** `rel = morphStart + (seed * .45 + uv.x * .55) * morphDur`，释放后 `since = time - rel`。
- **弹簧：** `k = 38`，释放后乘 `smoothstep(.05, .75, since)`；阻尼 `v *= exp(-6.5 * dt)`。
- **流场：** `abc(P * .16 + seedVec * 6.2831, t)`，强度 `transit * (1. - smoothstep(0., 1., since))`。`abc` 同 `field.js`。
- **融化：** `hf = meltAmt * exp(-dm * dm / 81.)`；`k *= 1. - .97 * hf`；流场加 `hf * 42`；切向力 `hf * 3`；上升 `hf * 14`。
- **鼠标：** `fp = exp(-dd * dd / 30.) * ptrOn`；`acc.xz += (n * 150. + perp(n) * 70. + ptrVel * 5.) * fp`；`acc.y += fp * 80.`；`ptrVel` 限长 60。
- **冲击波：** 持续 1.8 秒，半径 `st * 42`，`e = exp(-pow((l - st * 42.) / 4.5, 2.)) * (1. - st / 1.8)`，水平和向上推力都是 `e * 520.`。
- **启动环：** `acc.y += exp(-pow((dist - ring) / 3.2, 2.)) * 360. * (.4 + seed)`。
- **字标权重：** `P.w` 趋向 1 或 0，速率字标 3、地面 6。
- **绘制：**
  - `fog = exp(-pow(dist / (fogD * 1.12), 3.))`；`flying = smoothstep(.6, 3.5, 距目标水平距离)`。
  - `a = (.13 + .62 * lit * (.55 + .45 * smoothstep(3., 20., h))) * (1. - smoothstep(.35, .9, cr))`，再 `max(a, flying * .55) * fog * runDim`；最终 `mix(a, .95, P.w) * lat`。
  - 尺寸 `dpr * (1.15 + P.w * .9 + min(speed, 30.) * .035) * clamp(58. / dist, .72, 2.7)`。
  - `hot = clamp((speed - 7.) * .035 + melt * 1.2, 0., 1.)`；颜色 `mix(bone, accent, hot)`，亮度乘 `1. + hot`。
  - 圆点：`1. - smoothstep(.3, .5, r)`，加性混合。

### A.5 字标

每第 9 个粒子分配给字标，循环落到 VOXELIGHT 的亮格上。距相机 `D = 70`，总宽 `2 * D * tanHalfFov * aspect * .62`，格宽为总宽 / 53，中心在视线上方 `D * tanHalfFov * .36`，抖动 ±0.31 格。字间距 6 格。字形（5×7，自上而下）：

| 字 | 行 |
|---|---|
| V | `10001 10001 10001 10001 10001 01010 00100` |
| O | `01110 10001 10001 10001 10001 10001 01110` |
| X | `10001 10001 01010 00100 01010 10001 10001` |
| E | `11111 10000 10000 11110 10000 10000 11111` |
| L | `10000 10000 10000 10000 10000 10000 11111` |
| I | `01110 00100 00100 00100 00100 00100 01110` |
| G | `01110 10001 10000 10111 10001 10001 01111` |
| H | `10001 10001 10001 11111 10001 10001 10001` |
| T | `11111 00100 00100 00100 00100 00100 00100` |
