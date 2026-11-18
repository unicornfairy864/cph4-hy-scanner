import assert from 'node:assert/strict';
import test from 'node:test';
import { orientationTransform, resetJpegOrientation } from '../miniprogram/image/orientation';
import { detectDocument } from '../miniprogram/workers/image/detect';
import { renderDocument } from '../miniprogram/workers/image/render';
import type { Frame, Point, Quad, RenderOptions } from '../miniprogram/workers/image/types';

const entireImage: Quad = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

function frame(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([...rgb(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

function pixel(image: Frame, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.slice(offset, offset + 3));
}

function near(actual: number, expected: number, tolerance: number) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} within ${tolerance} of ${expected}`);
}

function inside(x: number, y: number, polygon: Quad): boolean {
  return polygon.every((current, index) => {
    const next = polygon[(index + 1) % 4];
    return (next.x - current.x) * (y - current.y) > (next.y - current.y) * (x - current.x);
  });
}

function render(source: Frame, overrides: Partial<RenderOptions> = {}): Frame {
  return renderDocument(source, {
    corners: entireImage, rotation: 0, mode: 'color', denoise: false, maxDimension: 400, ...overrides,
  });
}

test('finds a tilted document and declines an image with no edges', () => {
  const corners: Quad = [{ x: 42, y: 48 }, { x: 278, y: 29 }, { x: 255, y: 219 }, { x: 64, y: 199 }];
  const photo = frame(320, 240, (x, y) => {
    if (!inside(x, y, corners)) return [68, 55, 48];
    if (x > 93 && x < 230 && y > 76 && y < 180 && y % 12 < 2) return [37, 34, 30];
    const shade = Math.round(x * 0.18);
    return [245 - shade, 242 - shade, 232 - shade];
  });
  const detected = detectDocument(photo);
  assert.ok(detected.corners);
  assert.ok(detected.confidence >= 0.65);
  for (let i = 0; i < 4; i++) {
    near(detected.corners[i].x * 319, corners[i].x, 5);
    near(detected.corners[i].y * 239, corners[i].y, 5);
  }
  assert.deepEqual(detectDocument(frame(50, 50, () => [129, 129, 129])), {
    corners: null, confidence: 0, cornerConfidences: [0, 0, 0, 0],
  });
});

function diagonalIntersection([a, b, c, d]: Quad): Point {
  const rdX = c.x - a.x;
  const rdY = c.y - a.y;
  const otherX = d.x - b.x;
  const otherY = d.y - b.y;
  const t = ((b.x - a.x) * otherY - (b.y - a.y) * otherX) / (rdX * otherY - rdY * otherX);
  return { x: a.x + t * rdX, y: a.y + t * rdY };
}

test('perspective correction uses projective mapping and rotates the corrected page', () => {
  const source = frame(128, 96, (x, y) => [x, y, 0]);
  const corners: Quad = [{ x: 0.1, y: 0.3 }, { x: 0.9, y: 0.08 }, { x: 0.79, y: 0.92 }, { x: 0.23, y: 0.74 }];
  const straight = render(source, { corners });
  const visualCenter = diagonalIntersection(corners);
  const center = pixel(straight, Math.round((straight.width - 1) / 2), Math.round((straight.height - 1) / 2));
  near(center[0], 127 * visualCenter.x, 2);
  near(center[1], 95 * visualCenter.y, 2);
  const rotated = render(source, { corners, rotation: 90 });
  assert.equal(rotated.width, straight.height);
  assert.equal(rotated.height, straight.width);
  assert.deepEqual(pixel(rotated, rotated.width - 1, 0), pixel(straight, 0, 0));
  assert.deepEqual(pixel(rotated, 0, 0), pixel(straight, 0, straight.height - 1));

  const crossed: Quad = [corners[0], corners[2], corners[1], corners[3]];
  assert.throws(() => render(source, { corners: crossed }), /四边形/);
});

test('reduces gradual shadows, keeps color, and removes isolated spots while preserving strokes', () => {
  const source = frame(320, 200, (x, y) => {
    if (x === 40 && y === 61) return [50, 50, 50];
    if (x >= 120 && x <= 150 && y === 90) return [40, 35, 35];
    if (x >= 180 && x <= 200 && y >= 100 && y <= 109) return [160, 60, 60];
    const brightness = Math.min(238, 157 + Math.round(x / 3));
    return [brightness, brightness, brightness];
  });
  const output = render(source, { enhance: true, denoise: true });
  assert.ok(pixel(output, 25, 110)[0] > pixel(source, 25, 110)[0] + 30);
  near(pixel(output, 40, 61)[0], pixel(output, 41, 61)[0], 2);
  assert.ok(pixel(output, 130, 90)[0] < 60);
  const stamp = pixel(output, 190, 104);
  assert.ok(stamp[0] > stamp[1] * 2);
  const bw = render(source, { mode: 'bw' });
  assert.deepEqual(pixel(bw, 130, 90), [0, 0, 0]);
  assert.deepEqual(pixel(bw, 130, 50), [255, 255, 255]);
});

function jpegWithOrientation(value: number, littleEndian: boolean): ArrayBuffer {
  const bytes = new ArrayBuffer(36);
  const view = new DataView(bytes);
  view.setUint16(0, 0xffd8);
  view.setUint16(2, 0xffe1);
  view.setUint16(4, 32);
  view.setUint32(6, 0x45786966);
  view.setUint16(12, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(14, 42, littleEndian);
  view.setUint32(16, 8, littleEndian);
  view.setUint16(20, 1, littleEndian);
  view.setUint16(22, 0x0112, littleEndian);
  view.setUint16(24, 3, littleEndian);
  view.setUint32(26, 1, littleEndian);
  view.setUint16(30, value, littleEndian);
  return bytes;
}

test('resets EXIF orientation in both byte orders and leaves malformed JPEGs alone', () => {
  for (const littleEndian of [true, false]) {
    const jpeg = jpegWithOrientation(6, littleEndian);
    assert.equal(resetJpegOrientation(jpeg), 6);
    assert.equal(resetJpegOrientation(jpeg), 1);
    assert.equal(resetJpegOrientation(jpeg.slice(0, 25)), null);
  }
  assert.deepEqual(orientationTransform(6, 600, 400), [0, 1, -1, 0, 400, 0]);
  assert.deepEqual(orientationTransform(2, 600, 400), [-1, 0, 0, 1, 600, 0]);
});
