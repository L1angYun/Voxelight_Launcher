import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { SelectionGroup, SelectionMark } from "./SelectionMark";
import "./selection.css";

export interface SelectionOption<Value extends string> {
  value: Value;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<Value extends string> {
  semantic: "tabs" | "toggle" | "nav";
  label: string;
  value: Value;
  options: readonly SelectionOption<Value>[];
  onChange: (value: Value) => void;
  className?: string;
  orientation?: "horizontal" | "vertical";
  idPrefix?: string;
  panelId?: string | ((value: Value) => string);
}

export function Segmented<Value extends string>({
  semantic, label, value, options, onChange, className,
  orientation = "horizontal", idPrefix, panelId,
}: SegmentedProps<Value>) {
  const generatedId = useId();
  const prefix = idPrefix ?? `selection-${generatedId}`;
  const buttons = useRef(new Map<Value, HTMLButtonElement>());
  const enabled = options.filter((option) => !option.disabled);
  const tabStop = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;
  const tabs = semantic === "tabs";
  const Container = semantic === "nav" ? "nav" : "div";

  function navigate(event: KeyboardEvent<HTMLButtonElement>, current: Value) {
    if (!tabs || !enabled.length) return;
    const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const index = enabled.findIndex((option) => option.value === current);
    let next: number | undefined;
    if (event.key === nextKey) next = (index + 1) % enabled.length;
    else if (event.key === previousKey) next = (index - 1 + enabled.length) % enabled.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = enabled.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const option = enabled[next];
    onChange(option.value);
    buttons.current.get(option.value)?.focus();
  }

  return <SelectionGroup><Container className={cn("vx-selection", className)}
    role={tabs ? "tablist" : semantic === "toggle" ? "group" : undefined}
    aria-label={label} aria-orientation={tabs ? orientation : undefined}
    data-orientation={orientation} data-selection-kind={semantic}>
    {options.map((option) => <button key={option.value} type="button"
      ref={(node) => { if (node) buttons.current.set(option.value, node); else buttons.current.delete(option.value); }}
      id={tabs ? `${prefix}-${option.value}` : undefined}
      data-tab={tabs ? option.value : undefined} data-selected={value === option.value || undefined}
      role={tabs ? "tab" : undefined}
      aria-selected={tabs ? value === option.value : undefined}
      aria-pressed={semantic === "toggle" ? value === option.value : undefined}
      aria-current={semantic === "nav" && value === option.value ? "page" : undefined}
      aria-controls={tabs ? typeof panelId === "function" ? panelId(option.value) : panelId : undefined}
      tabIndex={tabs ? tabStop === option.value ? 0 : -1 : undefined}
      disabled={option.disabled}
      onClick={() => onChange(option.value)} onKeyDown={(event) => navigate(event, option.value)}>
      {value === option.value ? <SelectionMark location={option.value} /> : null}
      <span className="vx-selection__label">{option.icon}{option.label}</span>
    </button>)}
  </Container></SelectionGroup>;
}
