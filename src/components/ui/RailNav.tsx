import { cn } from "../../lib/utils";
import { Segmented, type SegmentedProps } from "./Segmented";

export function RailNav<Value extends string>(props: Omit<SegmentedProps<Value>, "semantic">) {
  return <Segmented {...props} semantic="nav" orientation="vertical" className={cn("vx-rail-nav", props.className)} />;
}
