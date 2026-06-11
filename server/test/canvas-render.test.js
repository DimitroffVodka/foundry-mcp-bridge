import test from "node:test";
import assert from "node:assert/strict";

import { flushCanvasRender } from "../../module/scripts/canvas-render.js";

test("flushCanvasRender advances the Foundry ticker with the supplied timestamp", () => {
  const calls = [];
  const canvas = {
    app: {
      ticker: {
        update: (timestamp) => calls.push(timestamp),
      },
    },
  };

  const flushed = flushCanvasRender(canvas, () => 1234.5);

  assert.equal(flushed, true);
  assert.deepEqual(calls, [1234.5]);
});

test("flushCanvasRender is a no-op when the canvas ticker is unavailable", () => {
  assert.equal(flushCanvasRender({}, () => 1234.5), false);
});
