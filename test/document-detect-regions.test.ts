import assert from 'node:assert/strict';
import test from 'node:test';
import { detectDocument } from '../miniprogram/workers/image/detect';
import type { Frame, Quad } from '../miniprogram/workers/image/types';

const width = 240;
const height = 480;
type Color = [number, number, number];

function inside(x: number, y: number, corners: Quad): boolean {
  return corners.every((start, index) => {
    const end = corners[(index + 1) % 4];
    return (end.x - start.x) * (y - start.y) >= (end.y - start.y) * (x - start.x);
  });
}

function photograph(pixel: (x: number, y: number) => Color): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = pixel(x, y);
      const noise = (x * 5 + y * 13) % 7 - 3;
      data.set([red + noise, green + noise, blue + noise, 255], 4 * (y * width + x));
    }
  }
  return { width, height, data };
}

function expectCorners(frame: Frame, expected: Quad, tolerance: number): void {
  const result = detectDocument(frame);
  assert.ok(result.corners);
  assert.ok(result.confidence >= 0.65);
  for (const [index, actual] of result.corners.entries()) {
    const x = actual.x * (width - 1);
    const y = actual.y * (height - 1);
    assert.ok(Math.hypot(x - expected[index].x, y - expected[index].y) <= tolerance,
      `Corner ${index}: received (${x.toFixed(1)}, ${y.toFixed(1)})`);
  }
}

test('detects a small sign when its color, rather than its luminance, separates it from the wall', () => {
  const sign: Quad = [{ x: 48, y: 127 }, { x: 139, y: 131 }, { x: 133, y: 225 }, { x: 47, y: 205 }];
  const frame = photograph((x, y) => {
    if (inside(x, y, sign)) {
      const lettering = x > 58 && x < 125 && y > 140 && y < 198 && y % 13 < 3 && x % 12 > 4;
      return lettering ? [203, 208, 119] : [64, 172, 64];
    }
    if (x > 63 && x < 107 && y >= 218 && y < 275) return [109, 109, 109];
    if (x > 230 - Math.max(0, (y - 190) / 15)) return [168, 92, 47];
    return [128, 128, 128];
  });
  expectCorners(frame, sign, 5);
});

test('chooses a shaded worksheet over the larger edges of a cluttered desk', () => {
  const sheet: Quad = [{ x: 29, y: 198 }, { x: 172, y: 203 }, { x: 220, y: 400 }, { x: 17, y: 424 }];
  const frame = photograph((x, y) => {
    if (inside(x, y, sheet)) {
      const shade = 223 - Math.min(74, (y - 198) * 0.35 + x * 0.04);
      const lines = (x + Math.floor(y / 7)) % 13 === 0 || (y + Math.floor(x / 12)) % 14 === 0;
      const paper = shade - (lines ? 33 : 0);
      return [paper, paper, paper - 1];
    }
    if (x < 24 && y > 185 && y < 284) return [108, 112, 120];
    if (x > 79 && x < 112 && y < 165) return [192, 200, 177];
    if (x > 136 && x < 210 && y > 89 && y < 166) return [117, 90, 62];
    if (y > 85 && y < 431 && x > 2 && x < 237) {
      return y % 7 === 0 || x % 7 === 0 ? [69, 91, 82] : [43, 58, 52];
    }
    return [28, 24, 20];
  });
  expectCorners(frame, sheet, 6);
});
