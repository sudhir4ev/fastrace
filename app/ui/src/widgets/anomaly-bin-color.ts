// Amber -> red heatmap for anomaly density (zoom strip + signal-lane bands).
const COLOR_STOPS: [number, number, number][] = [
  [254, 249, 231], // #fef9e7
  [252, 166, 82], // #fca652
  [227, 73, 72], // #e34948
];

export function anomalyBinColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const segment = clamped * (COLOR_STOPS.length - 1);
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(segment));
  const localT = segment - i;
  const [r0, g0, b0] = COLOR_STOPS[i];
  const [r1, g1, b1] = COLOR_STOPS[i + 1];
  const r = Math.round(r0 + (r1 - r0) * localT);
  const g = Math.round(g0 + (g1 - g0) * localT);
  const b = Math.round(b0 + (b1 - b0) * localT);
  return `rgb(${r}, ${g}, ${b})`;
}
