import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenBookPage } from '../miniprogram/workers/image/dewarp';
import { renderDocument } from '../miniprogram/workers/image/render';
import type { Frame, Quad } from '../miniprogram/workers/image/types';

const WIDTH = 460;
const HEIGHT = 640;
const ALL: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const TOP_LINES = [43, 59, 76, 98, 113, 138, 154, 174, 197, 213];
const BOTTOM_LINES = [448, 468, 491, 507, 531, 550, 565, 584, 607];

function page(curved: boolean, onlyGraph = false): Frame {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let x = 0; x < WIDTH; x++) {
    const across = 2 * x / WIDTH - 1;
    for (let y = 0; y < HEIGHT; y++) {
      const offset = (y * WIDTH + x) * 4;
      const paper = Math.round(225 + 15 * across);
      data[offset] = paper;
      data[offset + 1] = paper;
      data[offset + 2] = paper - 4;
      data[offset + 3] = 255;
      const graph = x > 112 && x < 355 && y >= 291 && y < 369;
      if (graph && (x === 226 || y === 330 || y === Math.round(330 + 27 * Math.sin(x / 23)))) {
        data.set([40, 57, 184, 255], offset);
      }
    }
    if (onlyGraph || x < 39 || x > 421) continue;
    const bendTop = curved ? Math.round(31 * across ** 2 + 6 * across) : 0;
    const bendBottom = curved ? Math.round(-24 * across ** 2 + 8 * across) : 0;
    const lines = [...TOP_LINES.map((y) => y + bendTop), ...BOTTOM_LINES.map((y) => y + bendBottom)];
    for (let line = 0; line < lines.length; line++) {
      if ((x + line * 3) % 11 > 7) continue;
      const y = lines[line];
      for (let row = y; row < y + 3 + (x % 3 === 0 ? 1 : 0); row++) {
        data.set([40, 43, 44, 255], (row * WIDTH + x) * 4);
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, data };
}

function concentration(frame: Frame, first: number, last: number): number {
  const totals: number[] = [];
  for (let y = first; y < last; y++) {
    let ink = 0;
    for (let x = 42; x < WIDTH - 42; x++) {
      if (frame.data[(y * WIDTH + x) * 4] < 130) ink++;
    }
    totals.push(ink);
  }
  const mean = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  return Math.sqrt(totals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / totals.length);
}

test('straightens curved text in separate vertical regions and preserves an unsupported graph', () => {
  const input = page(true);
  const result = flattenBookPage(input);
  assert.notEqual(result, input);
  assert.equal(result.width, input.width);
  assert.equal(result.height, input.height);
  assert.ok(concentration(result, 34, 247) > 1.2 * concentration(input, 34, 247));
  assert.ok(concentration(result, 408, 624) > 1.2 * concentration(input, 408, 624));

  const graphStart = input.width * 4 * 299;
  const graphEnd = input.width * 4 * 359;
  assert.deepEqual(result.data.subarray(graphStart, graphEnd), input.data.subarray(graphStart, graphEnd));
});

test('leaves flat text and graph-only pages unchanged', () => {
  const flat = page(false);
  const graph = page(false, true);
  assert.equal(flattenBookPage(flat), flat);
  assert.equal(flattenBookPage(graph), graph);
});

test('uses the optional correction in the renderer without changing the default', () => {
  const input = page(true);
  const settings = { corners: ALL, rotation: 0, mode: 'color', denoise: false, maxDimension: HEIGHT } as const;
  const plain = renderDocument(input, settings);
  assert.deepEqual(plain.data, input.data);
  const adjusted = renderDocument(input, { ...settings, dewarp: true });
  assert.deepEqual(adjusted.data, flattenBookPage(plain).data);
});
