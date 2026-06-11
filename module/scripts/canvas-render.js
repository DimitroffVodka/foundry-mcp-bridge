export function flushCanvasRender(canvasRef = globalThis.canvas, now = () => performance.now()) {
  const update = canvasRef?.app?.ticker?.update;
  if (typeof update !== "function") return false;
  update.call(canvasRef.app.ticker, now());
  return true;
}
