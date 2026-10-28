import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  id?: string;
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  "aria-label": ariaLabel,
  className,
  id,
}: SelectProps) {
  const generatedId = useId();
  const buttonId = id ?? generatedId;
  const listboxId = `${buttonId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(null);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!listRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (open && activeIndex !== null) {
      listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  function onButtonKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(options.findIndex((o) => o.value === value));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(options.findIndex((o) => o.value === value));
    }
  }

  function onListKeyDown(e: KeyboardEvent) {
    const enabledIndexes = options.map((o, i) => (!o.disabled ? i : -1)).filter((i) => i >= 0);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const cur = activeIndex ?? -1;
      const next = enabledIndexes.find((i) => i > cur);
      if (next !== undefined) setActiveIndex(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const cur = activeIndex ?? options.length;
      const prev = [...enabledIndexes].reverse().find((i) => i < cur);
      if (prev !== undefined) setActiveIndex(prev);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (activeIndex !== null && !options[activeIndex]?.disabled) {
        onChange(options[activeIndex].value);
        close();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(enabledIndexes[0] ?? null);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? null);
    } else if (e.key.length === 1) {
      const ch = e.key.toLowerCase();
      const start = (activeIndex ?? -1) + 1;
      const idx = [...options.slice(start), ...options.slice(0, start)].findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(ch),
      );
      if (idx >= 0) setActiveIndex((idx + start) % options.length);
    }
  }

  return (
    <div className={cn("vx-select", open && "vx-select--open", disabled && "vx-select--disabled", className)}>
      {/* Hidden native select for test automation — aria-label prefixed to avoid strict-mode conflicts */}
      <select
        aria-label={ariaLabel ? `${ariaLabel} (native)` : undefined}
        data-testid={ariaLabel ? `native-select-${ariaLabel}` : undefined}
        tabIndex={-1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 0, height: 0, overflow: "hidden" }}
      >
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeIndex !== null ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        className="vx-select__button"
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        onKeyDown={onButtonKeyDown}
      >
        <span className="vx-select__value">{selectedOption?.label ?? value}</span>
        <ChevronDown className="vx-select__chevron" size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="vx-select__listbox"
          tabIndex={-1}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              className={cn(
                "vx-select__option",
                option.value === value && "vx-select__option--selected",
                index === activeIndex && "vx-select__option--active",
                option.disabled && "vx-select__option--disabled",
              )}
              onPointerDown={(e) => {
                e.preventDefault();
                if (!option.disabled) {
                  onChange(option.value);
                  close();
                }
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
