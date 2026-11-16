export type GapRow = "half" | "full";

// The edge rows are paragraph separators. Every interior row represents
// one editable blank line, with the same height and caret behavior.
export function gapRows(newlines: number): GapRow[] {
  return Array.from({ length: Math.max(0, newlines - 1) }, (_, index) =>
    index === 0 || index === newlines - 2 ? "half" : "full",
  );
}
