// SPDX-License-Identifier: GPL-3.0-only
const CLAIMED = "button,a,input,select,textarea,label,canvas,summary,[data-tauri-drag-region],[data-no-world-interaction],[contenteditable]:not([contenteditable='false']),[role='button'],[role='link'],[role='combobox'],[role='slider'],[role='switch'],[role='tab'],[role='checkbox'],[role='option'],[tabindex]:not([tabindex='-1'])";

/** Background presses never take ownership of controls, drag regions or copy. */
export function isBlankPress(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest(CLAIMED)) return false;
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))) return false;
  }
  return true;
}
