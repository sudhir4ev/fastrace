// Validated categorical palette (8 slots, fixed order - see dataviz skill's
// references/palette.md). Cycles for a 9th+ signal rather than generating a
// new hue.
export const PALETTE = [
  "#2a78d6", // blue
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
  "#e87ba4", // magenta
  "#eb6834", // orange
] as const;

export function getSignalColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
