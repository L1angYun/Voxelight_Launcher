import { AnchoredListbox, type AnchoredListboxProps, type ListboxOption } from "./AnchoredListbox";

export type SelectOption = ListboxOption;
export type SelectProps = AnchoredListboxProps;

export function Select(props: SelectProps) {
  return <AnchoredListbox {...props} />;
}
