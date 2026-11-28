// SPDX-License-Identifier: GPL-3.0-only

/** Chromium accepts this option although lib.dom still omits it. */
export interface HeadingFocusOptions extends FocusOptions {
  focusVisible?: boolean;
}

/**
 * Moves screen-reader focus to the new step heading. `focusVisible: false`
 * keeps Chromium from treating the programmatic focus as keyboard focus, and
 * the matching CSS rule is the fallback for browsers that ignore the option.
 */
export function focusHeading(heading: HTMLElement | null): void {
  heading?.focus({ preventScroll: true, focusVisible: false } satisfies HeadingFocusOptions);
}
