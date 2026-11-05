import { useCallback, useId, useLayoutEffect, useRef, useState, type AriaAttributes, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, usePresenceData } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { useAppearance } from "../../app/AppearanceProvider";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { cn } from "../../lib/utils";
import { useJellyControl } from "./useJellyControl";
import { MOTION } from "../../design/motion";
import "./AnchoredListbox.css";

export interface ListboxOption {
  value: string; label: string; metadata?: string; icon?: ReactNode; disabled?: boolean;
  dataAttributes?: Record<`data-${string}`, string>;
}
export interface AnchoredListboxProps extends AriaAttributes {
  value: string; onChange: (value: string) => void; options: ListboxOption[];
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean; required?: boolean; id?: string; className?: string;
  triggerClassName?: string; popupClassName?: string; embedded?: boolean; minimumMenuWidth?: number;
  material?: "flat" | "glass";
}
interface Placement { left: number; top: number; width: number; maxHeight: number; anchorX: number; side: "top" | "bottom" }

function Popup({ popupRef, placement, animate, className, children }: {
  popupRef: RefObject<HTMLDivElement | null>; placement: Placement | null; animate: boolean; className?: string; children: ReactNode;
}) {
  const present = useIsPresent();
  const animateExit = usePresenceData() as boolean;
  const tucked = `translateY(${placement?.side === "top" ? -MOTION.menu.offset : MOTION.menu.offset}px) scale(${MOTION.menu.scale})`;
  useLayoutEffect(() => {
    const element = popupRef.current;
    if (element && typeof element.showPopover === "function") {
      try { element.showPopover(); } catch { /* The fixed layer remains available. */ }
    }
    return () => { if (element && typeof element.hidePopover === "function" && element.matches(":popover-open")) element.hidePopover(); };
  }, [popupRef]);
  return <motion.div ref={popupRef} popover="manual" className={cn("vx-listbox-popover", className)}
    data-placement={placement?.side} data-present={present} data-animate={present ? animate : animateExit}
    inert={!present || undefined} aria-hidden={!present || undefined}
    initial={animate ? { transform: tucked } : false} animate={{ transform: "translateY(0px) scale(1)" }}
    exit="closed" variants={{ closed: (enabled: boolean) => ({ transform: tucked, transition: { duration: enabled ? MOTION.duration.menuExit : 0, ease: MOTION.easeExit } }) }}
    transition={{ duration: animate ? MOTION.duration.menuEnter : 0, ease: MOTION.ease }}
    style={{ position: "fixed", left: placement?.left ?? 16, top: placement?.top ?? 16, width: placement?.width ?? 280,
      maxHeight: placement?.maxHeight ?? 360, visibility: placement ? "visible" : "hidden", pointerEvents: present ? "auto" : "none",
      transformOrigin: `${placement?.anchorX ?? 0}px ${placement?.side === "top" ? "bottom" : "top"}` }}
    onPointerDown={(event) => event.stopPropagation()}>{children}</motion.div>;
}

function SelectSurface({ glass, variant, className, children }: { glass: boolean; variant: "control" | "dialog"; className: string; children: ReactNode }) {
  return glass ? <GlassSurface variant={variant} className={className}>{children}</GlassSurface>
    : <div className={cn(className, "vx-select-flat-surface")}>{children}</div>;
}

export function AnchoredListbox({ value, onChange, onOpenChange, options, disabled = false, required, id, className,
  triggerClassName, popupClassName, embedded = false, minimumMenuWidth = 280, material = "flat",
  "aria-label": label, "aria-describedby": describedBy, ...aria }: AnchoredListboxProps) {
  const { effects, reducedMotion, reducedTransparency, highContrast } = useAppearance();
  const staticMotion = effects !== "full" || reducedMotion || reducedTransparency || highContrast;
  const jelly = useJellyControl<HTMLDivElement>(staticMotion || material === "flat");
  const generatedId = useId();
  const buttonId = id ?? `select-${generatedId}`;
  const listId = `${buttonId}-listbox`;
  const valueId = `${buttonId}-value`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const openRef = useRef(false);
  const search = useRef({ value: "", time: -Infinity });
  const [open, setOpen] = useState(false);
  const openChangeRef = useRef(onOpenChange);
  const announcedOpen = useRef(false);
  const notifyOpen = useCallback((next: boolean) => {
    if (announcedOpen.current === next) return;
    announcedOpen.current = next;
    openChangeRef.current?.(next);
  }, []);
  useLayoutEffect(() => { openChangeRef.current = onOpenChange; }, [onOpenChange]);
  useLayoutEffect(() => {
    if (open) notifyOpen(true);
  }, [notifyOpen, open]);
  useLayoutEffect(() => () => notifyOpen(false), [notifyOpen]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [pointerInput, setPointerInput] = useState(false);
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const unavailable = disabled || enabled.length === 0;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const active = enabled.includes(activeIndex) ? activeIndex : enabled.find((index) => index >= activeIndex) ?? enabled.at(-1) ?? -1;
  const animatePopup = pointerInput && !staticMotion;
  const rowHeight = options.some((option) => option.metadata) ? 60 : 44;
  const close = useCallback((pointer = false) => {
    setPointerInput(pointer); openRef.current = false; setOpen(false); search.current = { value: "", time: -Infinity };
    // Keyboard and accessibility modes have no popup exit animation. Pointer
    // exits keep covered content hidden until AnimatePresence removes the menu.
    if (!pointer || staticMotion) notifyOpen(false);
  }, [notifyOpen, staticMotion]);
  function openAt(index: number, pointer = false) {
    if (unavailable) return;
    const trigger = triggerRef.current;
    setPortalRoot(trigger?.closest<HTMLDialogElement>("dialog[open]") ?? trigger?.closest<HTMLElement>(".vx-glass-provider") ?? document.body);
    setPointerInput(pointer); setActiveIndex(enabled.includes(index) ? index : enabled[0]); openRef.current = true; setOpen(true);
  }
  function choose(index: number, restoreFocus = true, pointer = false) {
    if (unavailable || !options[index] || options[index].disabled) return;
    onChange(options[index].value); close(pointer);
    if (restoreFocus && document.activeElement !== triggerRef.current) triggerRef.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => { if (unavailable && openRef.current) close(); }, [close, unavailable]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 16;
      const gap = 8;
      if (rect.bottom <= margin || rect.top >= window.innerHeight - margin || rect.right <= margin || rect.left >= window.innerWidth - margin) { close(); return; }
      const width = Math.min(Math.max(rect.width, minimumMenuWidth), Math.max(0, window.innerWidth - margin * 2));
      const naturalHeight = Math.min(360, (listRef.current?.scrollHeight || options.length * rowHeight) + 14);
      const below = Math.max(0, window.innerHeight - margin - rect.bottom - gap);
      const above = Math.max(0, rect.top - margin - gap);
      const side = below >= naturalHeight || below >= above ? "bottom" : "top";
      const maxHeight = Math.min(360, side === "bottom" ? below : above);
      const height = Math.min(naturalHeight, maxHeight);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width));
      const next: Placement = { left, width, maxHeight, side,
        top: Math.max(margin, Math.min(side === "bottom" ? rect.bottom + gap : rect.top - gap - height, window.innerHeight - margin - height)),
        anchorX: Math.max(0, Math.min(width, rect.left + rect.width / 2 - left)) };
      setPlacement((previous) => previous && Object.keys(next).every((key) => previous[key as keyof Placement] === next[key as keyof Placement]) ? previous : next);
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) close(true);
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popupRef.current?.contains(event.target)) position(); };
    position(); document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position); window.addEventListener("scroll", scroll, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", position); window.removeEventListener("scroll", scroll, true); observer?.disconnect(); };
  }, [close, minimumMenuWidth, open, options.length, portalRoot, rowHeight]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.children[active] as HTMLElement | undefined;
    if (!open || !list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [active, open, placement?.maxHeight]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable) return;
    setPointerInput(false);
    const key = event.key;
    if (key === "Tab") { if (openRef.current) choose(active, false); return; }
    if (key === "Escape") { if (openRef.current) { event.preventDefault(); event.stopPropagation(); close(); } return; }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (event.altKey && key === "ArrowUp" && openRef.current) choose(active);
      else if (!openRef.current) openAt(selectedIndex);
      else setActiveIndex(enabled[Math.max(0, Math.min(enabled.length - 1, enabled.indexOf(active) + (key === "ArrowDown" ? 1 : -1)))]);
      return;
    }
    if (key === "Home" || key === "End") { event.preventDefault(); openAt(key === "Home" ? enabled[0] : enabled[enabled.length - 1]); return; }
    if (key === "Enter" || key === " ") { event.preventDefault(); if (openRef.current) choose(active); else openAt(selectedIndex); return; }
    if (key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const time = performance.now();
    const character = key.toLocaleLowerCase();
    const fresh = time - search.current.time > 700;
    const buffer = fresh ? character : search.current.value + character;
    const repeated = [...buffer].every((letter) => letter === character);
    const prefix = repeated ? character : buffer;
    const current = openRef.current ? active : selectedIndex;
    const start = fresh || repeated ? current + 1 : current;
    search.current = { value: buffer, time };
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (Math.max(0, start) + offset) % options.length;
      if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(prefix)) { openAt(index); return; }
    }
    if (!openRef.current) openAt(selectedIndex);
  }
  const button = <button {...aria} ref={triggerRef} id={buttonId} type="button" role="combobox"
    className={cn("vx-select__button", triggerClassName)} data-has-icon={Boolean(selected?.icon)}
    aria-label={label} aria-describedby={[valueId, describedBy].filter(Boolean).join(" ")} aria-haspopup="listbox"
    aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
    aria-required={required || aria["aria-required"]} disabled={unavailable}
    onClick={(event) => openRef.current ? close(event.detail > 0) : openAt(selectedIndex, event.detail > 0)} onKeyDown={onKeyDown}
    onBlur={(event) => { if (openRef.current && !popupRef.current?.contains(event.relatedTarget as Node | null)) close(); }}>
    {selected?.icon}<span className="vx-select__text" id={valueId}>
      <span className="vx-select__value" title={selected?.label ?? value}>{selected?.label ?? value}</span>
      {selected?.metadata ? <span className="vx-select__metadata" title={selected.metadata}>{selected.metadata}</span> : null}
    </span><ChevronDown className="vx-select__chevron" size={16} aria-hidden="true" />
  </button>;
  return <div className={cn("vx-select", `vx-select--${material}`, embedded && "vx-select--embedded", className)} ref={embedded ? undefined : jelly.ref} {...(embedded ? {} : jelly.handlers)}>
    {embedded ? button : <SelectSurface glass={material === "glass"} variant="control" className="vx-select__surface">{button}</SelectSurface>}
    {portalRoot ? createPortal(<AnimatePresence custom={animatePopup} onExitComplete={() => { if (!openRef.current) notifyOpen(false); }}>
      {open ? <Popup key={listId} popupRef={popupRef} placement={placement} animate={animatePopup} className={popupClassName}>
        <SelectSurface glass={material === "glass"} variant="dialog" className="vx-listbox-surface">
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="vx-select__listbox" style={{ maxHeight: Math.max(0, (placement?.maxHeight ?? 360) - 14) }}>
            {options.map((option, index) => <li key={option.value} {...option.dataAttributes} id={`${listId}-${index}`} role="option"
              aria-selected={index === selectedIndex} aria-disabled={option.disabled || undefined} data-active={index === active}
              data-value={option.value} data-has-icon={Boolean(option.icon)} className="vx-select__option"
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={(event) => { if (!option.disabled && (event.pointerType === "mouse" || event.pointerType === "pen")) setActiveIndex(index); }}
              onClick={(event) => choose(index, true, event.detail > 0)}>
              {option.icon}<span className="vx-select__text"><span className="vx-select__value" title={option.label}>{option.label}</span>
                {option.metadata ? <span className="vx-select__metadata" title={option.metadata}>{option.metadata}</span> : null}</span>
              {index === selectedIndex ? <Check size={16} data-selected-mark aria-hidden="true" /> : null}
            </li>)}
          </ul>
        </SelectSurface>
      </Popup> : null}
    </AnimatePresence>, portalRoot) : null}
  </div>;
}
