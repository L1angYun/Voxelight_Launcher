# Visual Round 4b Implementation Plan

> **For agentic workers:** Use the existing round 4 brief, systematic debugging, and verification-before-completion. Track the two independent repairs below.

**Goal:** Restore character walking/running and keep the floating navigation indicator stable during layout updates.

**Architecture:** Retain the existing character state machine and shared glass springs. Repair lifecycle and measurement boundaries; animate actual navigation and snap layout-only changes.

**Tech Stack:** React, TypeScript, skinview3d, existing native browser APIs.

**Spec:** `.superpowers/sdd/2026-10-27-visual-revision/brief-gpt-round4.md`, tasks 1 and 2 only, plus its four prerequisite documents.

## Global Constraints

- Do not modify `src/visual/glass/`, `src/visual/lattice/`, or `src/app/AppProviders.tsx`.
- Do not add dependencies or run Vite, Vitest, or Playwright.
- Preserve accessibility preferences, visibility pauses, and actual navigation's spring motion.
- Preserve existing unrelated edits; work in the specified workspace, whose Git metadata is read-only.
- Write the final Chinese report to `.superpowers/sdd/2026-10-27-visual-revision/gpt-round4b.log`; do not replace the previous report.

## Review Focus

- Character animation survives asynchronous viewer initialization and skin loading.
- Character remains paused for lite/reduced motion, hidden documents, and overture playback.
- Switching effects recreates and correctly positions the navigation indicator.
- Item geometry changes are detected even when total navigation dimensions remain constant.
- Repeated layout notifications and genuine navigation preserve stable geometry and the intended spring behavior.

## Task 1: Character animation lifecycle

Files: `src/visual/character/CharacterCanvas.tsx` and its existing regression tests; `OvertureScene.tsx` only if the investigation requires it.

- [x] Read WorldScene, OvertureScene, CharacterCanvas, their tests and relevant history; identify the failing boundary.
- [x] Add a regression for the observed lifecycle failure before changing production code.
- [x] Apply the smallest fix and review pause/restart/unmount behavior.
- [x] Run allowed native checks; explicitly record any tests requiring the prohibited runners as unrun.

Evidence: `node tests/unit/character-animation.test.mjs` changed from 4 pass / 5 fail to 9 pass / 0 fail. The existing combined effect reset animation/joints/progress on pause, visibility and auto-rotation updates. The fix separates animation selection from playback control. Continuous baseline walk/run already worked in the harness; the broader permanently-static report was not reproduced and still needs real-window verification. No evidence attributes the existing defect to the round 3 color/CSS changes.

## Task 2: Floating navigation measurement lifecycle

Files: `src/app/FloatingNav.tsx`, `tests/unit/floating-nav.test.mjs`.

- [x] Use a native Node/React/JSDOM regression test to reproduce effects-switch positioning and item-only layout changes.
- [x] Distinguish active-item changes from layout remeasurement; snap layout updates and clear any remaining spring motion.
- [x] Observe relevant item geometry with duplicate-notification filtering; retain the existing three-frame debounce and font hooks.
- [x] Verify the new native tests, `node node_modules/typescript/bin/tsc --noEmit`, and `git diff --check`.

Evidence: `node tests/unit/floating-nav.test.mjs` changed from 1 pass / 5 fail to 6 pass / 0 fail. Direct Node execution is required in this sandbox: `node --test` tries to spawn a child and fails with EPERM. TypeScript and whitespace checks exited 0. A separate read-only reviewer accepted the navigation and character patches without confirmed findings.

## Delivery

- [x] Review the combined changes and report exact checks, root causes, modified files and remaining real-window verification.

Final integration: character 9/9, navigation 6/6, full-project TypeScript noEmit exit 0, scoped whitespace check exit 0. Report written to the requested `gpt-round4b.log`. No protected files, dependencies or visible copy changed. No Vite/Vitest/Playwright commands were run. Reviewer set aside real-window/WebGL rendering and unrelated concurrent work; the report explicitly carries those verification boundaries. No Critical, Important or Minor findings remain.
