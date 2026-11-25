import { useEffect, useRef, useState } from "react";
import { navigationRegistry, type RegistryItem } from "./registry";
import type { NavigationPage } from "./FloatingNav";

const textEntrySelector = [
  "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file])",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
].join(", ");

function isTextEntry(target: EventTarget | null): boolean {
  const candidates = [target, document.activeElement];
  return candidates.some((candidate) => candidate instanceof Element && Boolean(candidate.closest(textEntrySelector)));
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  if (typeof window.getComputedStyle !== "function") return true;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export interface UseShortcutsOptions {
  navigate: (page: NavigationPage) => void;
  implemented: ReadonlySet<NavigationPage>;
  onOpenAssistant?: () => void;
}

export interface ShortcutsController {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
}

/** The registry order shared by the number shortcuts and the help dialog. */
export function shortcutPages(implemented: ReadonlySet<NavigationPage>): RegistryItem<NavigationPage>[] {
  return navigationRegistry.enabled({})
    .filter((item) => implemented.has(item.id as NavigationPage))
    .map((item) => ({ ...item, id: item.id as NavigationPage }));
}

function implementedPages(implemented: ReadonlySet<NavigationPage>): NavigationPage[] {
  return shortcutPages(implemented).map((item) => item.id);
}

function digitShortcut(event: KeyboardEvent): number | undefined {
  if (event.shiftKey) return undefined;
  if (event.key.length === 1 && event.key >= "1" && event.key <= "7") return Number(event.key);
  // Layouts such as AZERTY report "&" for Ctrl+1. The physical digit is the
  // shortcut's identity, so fall back to event.code.
  const code = /^(?:Digit|Numpad)([1-7])$/.exec(event.code);
  return code ? Number(code[1]) : undefined;
}

function isComma(event: KeyboardEvent): boolean {
  return !event.shiftKey && (event.key === "," || event.code === "Comma");
}

function isFind(event: KeyboardEvent): boolean {
  return !event.shiftKey && (event.key.toLocaleLowerCase() === "f" || event.code === "KeyF");
}

function isAssistant(event: KeyboardEvent): boolean {
  return !event.shiftKey && (event.key.toLocaleLowerCase() === "k" || event.code === "KeyK");
}

export function useShortcuts({ navigate, implemented, onOpenAssistant }: UseShortcutsOptions): ShortcutsController {
  const [helpOpen, setHelpOpen] = useState(false);
  const navigateRef = useRef(navigate);
  const implementedRef = useRef(implemented);
  const assistantRef = useRef(onOpenAssistant);
  useEffect(() => {
    navigateRef.current = navigate;
    implementedRef.current = implemented;
    assistantRef.current = onOpenAssistant;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229 || event.repeat) return;
      // Native dialogs own their keyboard handling, including Escape.
      if (document.querySelector("dialog[open]")) return;

      const textEntry = isTextEntry(event.target);
      const pages = implementedPages(implementedRef.current);

      if (event.ctrlKey) {
        const digit = digitShortcut(event);
        if (digit !== undefined) {
          if (textEntry) return;
          const page = pages[digit - 1];
          if (!page) return;
          event.preventDefault();
          navigateRef.current(page);
          return;
        }
        if (isComma(event)) {
          if (textEntry || !pages.includes("settings")) return;
          event.preventDefault();
          navigateRef.current("settings");
          return;
        }
        if (isAssistant(event)) {
          if (textEntry || !assistantRef.current) return;
          event.preventDefault();
          assistantRef.current();
          return;
        }
        if (isFind(event)) {
          // Ctrl+F is the one shortcut that still works from a text field.
          const main = document.querySelector("main");
          const search = main
            ? [...main.querySelectorAll<HTMLInputElement>('input[type="search"]')].find((input) => !input.disabled && isVisible(input))
            : undefined;
          if (!search) return;
          event.preventDefault();
          search.focus();
          return;
        }
        return;
      }

      if (event.ctrlKey || textEntry) return;
      if (event.key === "?" || event.key === "F1") {
        event.preventDefault();
        setHelpOpen(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { helpOpen, setHelpOpen };
}
