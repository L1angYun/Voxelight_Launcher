# Round 2 final verification and phase 2–3 follow-up

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the primary implementation; independent read-only reviews may use parallel agents. Steps use checkbox syntax for tracking.

**Goal:** Finish stage 4 under M2 revision 5, then close the user's fourteen phase 2–3 review findings in a separate commit.

**Architecture:** Keep all uniform instrumentation in test helpers. Preserve product rendering and existing visual thresholds. Add behavior and browser regressions at the components named by the review; keep the two requested commits separate.

**Tech Stack:** React, TypeScript, CSS cascade layers, WebGL2, Vitest, Node test runner, Playwright/D3D11, Tauri/Rust.

**Spec:** `../specs/2026-11-05-voxelight-review-round2-fixes.md`, M2 fifth revision, and the user's phase 2–3 review numbered 1–14.

## Global constraints

- Work only on `main`; no version or dependency changes, installer, AI commit trailers, skipped hooks, force push, or PR.
- Preserve the existing stage 4 working tree and historical failed measurements.
- User-approved execution order supersedes the skill's default worktree, extra approval, and frequent-commit workflow: exactly one stage 4 implementation commit first, then one review follow-up implementation commit.
- Each commit requires `npm test`, `npx tsc -b`, and the complete Playwright suite; world gates must assert actual D3D11 rendering. Push normally and confirm with `git ls-remote origin`.
- Stop if uniform convergence, measurement region, thresholds, or product parameters conflict with the actual renderer. Do not choose a different criterion.

## Review focus

- Missing, stale, cross-program, or context-restored uniform observations must never count as stable.
- Fixed-time instrumentation must compose with uniform observation in either installation order; record applied GPU values.
- Dynamic convergence uses three independent uniform deltas, a real reading interval of at least 400ms, and coverage stability; `uT` is recorded, not required to stabilize.
- Keyboard/current-selection contracts must survive unrelated busy operations, hover, and device-code state.
- Browser color/cascade and nonempty CSS assertions must validate actual rendering, not equal empty values or two equally wrong colors.

## Task 1 — Stage 4 M2 revision 5

Files: `tests/e2e/helpers/world-uniform-probe.ts` (new), `tests/e2e/helpers/world-appearance-capture.ts`, `tests/e2e/world-acceptance.spec.ts`, `tests/unit/world-appearance-stability.test.mjs`, probe unit tests, report and parent specification.

- [x] Add failing tests for dynamic uniform convergence, missing/stale generations, strict thresholds, actual read intervals, fixed mean stability, and the unchanged 20s deadline.
- [x] Implement a test-only `installWorldUniformProbe(page)` plus snapshot reader; wrap WebGL uniform calls, distinguish programs, retain applied `uLat/uCry/uIsland/uT`, timestamps and write provenance.
- [x] Give the capture helper an explicit fixed/dynamic stability mode. Fixed mode keeps mean difference <1. Dynamic mode requires coverage difference <0.3pp and each crystallization uniform difference <1e-3 at readings ≥400ms apart. Keep all other gates unchanged.
- [x] Run the focused Node tests, then native three-width world gates and remaining world cases. Inspect three fixed-startup normal screenshots separately from numeric results.
- [ ] Run the complete required checks, update evidence, commit stage 4 with checklist revision 5, push and confirm the remote. Do not implement Task 2 before this commit.

## Task 2 — Separate phase 2–3 review closure

- [ ] Findings 1/2/11: verify earliest complete layer declaration and real refraction; add native solid/no-blur glass and chrome assertions for reduced transparency and high contrast. Keep repository stripe tests. Explicitly document any external CSS scripts not integrated into guards.
- [ ] Findings 3/4: reproduce Stop during `instance.install` and authlib two-line profile overflow. Narrow Stop blocking to `game.stop`; use an unconstrained-height profile list row with native nonoverlap/content-bound tests.
- [ ] Findings 5/6: verify the updated same-id Toast and current-item ARIA tests; preserve node identity, single live node, usable close, and the new focusable ownership contract.
- [ ] Findings 7/8: resolve system Highlight in the browser, test every keyboard station, and assert global focus, focused input border, and Lattice outline against the actual indicator and adjacent pixels.
- [ ] Findings 9/10: pin selected row/tab/sidebar fills and hover exclusions; move ProjectCard current semantics onto its focusable control, retaining only the card dot frame. Add committed pixel hierarchy/allowed-fill checks; cover detail pages or explicitly record their unverified scope.
- [ ] Findings 12/13: inject each split library stylesheet through `isolatedStylesheetCss` and require nonempty colors; reproduce and correct the loader-status 6px offset.
- [ ] Finding 14: correct the stage 3 report's original cascade claim and attribute the actual stage 4 repair and its committed tests. Remove the isolated `.vx-settings-heading` rule.
- [ ] Independently review the final diff and every numbered finding. Run all required checks, update the report with both commit references and evidence, create the separate follow-up commit, push and confirm the remote.

The user has already approved the requirements and execution order; this document records that plan and introduces no additional design decision or approval gate.
