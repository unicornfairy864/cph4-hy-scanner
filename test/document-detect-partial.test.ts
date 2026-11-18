import assert from 'node:assert/strict';
import test from 'node:test';
import { detectDocument } from '../miniprogram/workers/image/detect';
import type { Frame, Point, Quad } from '../miniprogram/workers/image/types';

const width = 320;
const height = 400;

function photograph(paper: Quad): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = paper.every((point, index) => {
        const next = paper[(index + 1) % 4];
        return (next.x - point.x) * (y - point.y) > (next.y - point.y) * (x - point.x);
      });
      const printed = inside && x > 60 && x < Math.min(width - 40, 202 + y / 8)
        && (x + 2 * y) % 13 > 5 && (y + Math.floor(x / 9)) % 17 < 3;
      const shade = Math.floor(15 * y / height) + (x * 13 + y * 5) % 5;
      const color = printed ? [118, 118, 116] : inside ? [228, 228, 226] : [193, 183, 160];
      const offset = 4 * (y * width + x);
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = color[channel] - shade;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function cornerPixels(corner: Point): number[] {
  return [Math.round(corner.x * (width - 1)), Math.round(corner.y * (height - 1))];
}

test('preserves a visible corner when the other book corners extend outside the image', () => {
  const result = detectDocument(photograph([
    { x: 15, y: 37 }, { x: 264, y: -20 }, { x: 327, y: 455 }, { x: -19, y: 430 },
  ]));
  assert.ok(result.corners);
  const [topLeft, topRight, bottomRight, bottomLeft] = result.corners.map(cornerPixels);
  assert.ok(Math.abs(topLeft[0] - 15) <= 10 && Math.abs(topLeft[1] - 37) <= 10);
  assert.ok(topRight[0] > 250 && topRight[0] < 280);
  assert.equal(topRight[1], 0);
  assert.deepEqual(bottomRight, [319, 399]);
  assert.deepEqual(bottomLeft, [0, 399]);
  assert.ok(result.cornerConfidences[0] >= 0.7);
  assert.ok(result.cornerConfidences.slice(1).every((confidence) => confidence < 0.5));
});

test('uses both observed side edges when the top and bottom are completely clipped', () => {
  const result = detectDocument(photograph([
    { x: 40, y: -30 }, { x: 276, y: -20 }, { x: 297, y: 440 }, { x: 48, y: 420 },
  ]));
  assert.ok(result.corners);
  const [topLeft, topRight, bottomRight, bottomLeft] = result.corners.map(cornerPixels);
  assert.ok(topLeft[0] > 20 && topLeft[0] <= 40);
  assert.ok(topRight[0] >= 275 && topRight[0] < 290);
  assert.deepEqual([topLeft[1], topRight[1]], [0, 0]);
  assert.deepEqual([bottomRight[1], bottomLeft[1]], [399, 399]);
  assert.ok(bottomRight[0] >= 293 && bottomRight[0] < 311);
  assert.ok(bottomLeft[0] >= 35 && bottomLeft[0] < 50);
  assert.ok(result.cornerConfidences.every((confidence) => confidence < 0.5));
});
