// Maps the shared [0,100] zoom percent window (TimelineChart/TimelineZoomControl's
// dataZoom) onto the Trim Window's absolute timestamp bounds - the viewport
// the chart's signal samples and Anomaly Overlay are actually scoped to,
// instead of the whole Trim Window (`docs/adr/0009`).
export function viewportFromZoomPercent(
  zoomRange: { start: number; end: number },
  trimRange: { start: number; end: number }
): { startUs: number; endUs: number } {
  const span = trimRange.end - trimRange.start;
  const startUs = Math.round(trimRange.start + (zoomRange.start / 100) * span);
  const endUs = Math.round(trimRange.start + (zoomRange.end / 100) * span);
  return { startUs, endUs };
}
