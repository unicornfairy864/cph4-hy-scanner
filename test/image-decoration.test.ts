import assert from 'node:assert/strict';
import test from 'node:test';
import { paintWatermarks } from '../miniprogram/image/decoration';
import type { WatermarkContext } from '../miniprogram/image/decoration';
import { mosaicFrame, sharpenFrame } from '../miniprogram/workers/image/finish';
import { renderDocument } from '../miniprogram/workers/image/render';
import type { Frame, Quad } from '../miniprogram/workers/image/types';

const entirePage: Quad = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

function frame(width: number, height: number, color: (x: number, y: number) => number): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const red = color(x, y);
      data.set([red, red + 10, red + 20, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function pixel(image: Frame, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
}

test('sharpening increases edge contrast and keeps flat colors and opacity', () => {
  const source = frame(12, 7, (x) => [52, 52, 52, 52, 60, 95, 165, 190, 200, 200, 200, 200][x]);
  const unchanged = { ...source, data: source.data.slice() };
  const mild = { ...source, data: source.data.slice() };
  const strong = { ...source, data: source.data.slice() };
  sharpenFrame(unchanged, 'off');
  sharpenFrame(mild, 'mild');
  sharpenFrame(strong, 'strong');

  assert.deepEqual(unchanged, source);
  assert.deepEqual(pixel(strong, 2, 3), pixel(source, 2, 3));
  assert.ok(pixel(strong, 5, 3)[0] < pixel(mild, 5, 3)[0]);
  assert.ok(pixel(mild, 5, 3)[0] < pixel(source, 5, 3)[0]);
  const [red, green, blue, alpha] = pixel(strong, 5, 3);
  assert.deepEqual([green - red, blue - red, alpha], [10, 20, 255]);
});

test('mosaics average whole blocks without changing pixels outside each requested area', () => {
  const image = frame(8, 8, (x, y) => y * 8 + x);
  mosaicFrame(image, [
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    { x: -0.125, y: 0.75, width: 0.375, height: 0.5 },
  ]);
  for (let y = 2; y < 5; y++) {
    for (let x = 2; x < 5; x++) assert.deepEqual(pixel(image, x, y), [27, 37, 47, 255]);
  }
  assert.deepEqual(pixel(image, 0, 6), [52, 62, 72, 255]);
  assert.deepEqual(pixel(image, 1, 7), [52, 62, 72, 255]);
  assert.deepEqual(pixel(image, 6, 2), [22, 32, 42, 255]);
  assert.deepEqual(pixel(image, 2, 6), [50, 60, 70, 255]);
});

test('rendering applies the mosaic in the final rotated coordinates and keeps the source intact', () => {
  const source = frame(8, 12, (x, y) => x + y * 8);
  const preservedPixels = source.data.slice();
  const baseOptions = { corners: entirePage, rotation: 90 as const, denoise: false, mode: 'color' as const, maxDimension: 20 };
  const reference = renderDocument(source, baseOptions);
  const output = renderDocument(source, { ...baseOptions, mosaics: [{ x: 0, y: 0, width: 0.25, height: 0.375 }] });
  assert.deepEqual([output.width, output.height], [12, 8]);
  assert.deepEqual(pixel(output, 0, 0), pixel(output, 2, 2));
  assert.deepEqual(pixel(output, 3, 0), pixel(reference, 3, 0));
  assert.deepEqual(pixel(output, 0, 3), pixel(reference, 0, 3));
  assert.deepEqual(source.data, preservedPixels);
});

interface Bitmap {
  width: number;
  height: number;
}

class Drawing implements WatermarkContext<Bitmap> {
  globalAlpha = 1;
  fillStyle = '';
  font = '';
  textAlign = 'center' as const;
  textBaseline = 'middle' as const;
  position = [0, 0];
  angle = 0;
  history: { alpha: number; position: number[]; angle: number }[] = [];
  stamps: { kind: string; opacity: number; position: number[]; angle: number; area: number[] }[] = [];
  save() { this.history.push({ alpha: this.globalAlpha, position: this.position, angle: this.angle }); }
  restore() {
    const previous = this.history.pop()!;
    this.globalAlpha = previous.alpha;
    this.position = previous.position;
    this.angle = previous.angle;
  }
  translate(x: number, y: number) { this.position = [x, y]; }
  rotate(radians: number) { this.angle = radians; }
  measureText() { return { width: 100 }; }
  fillText(text: string, x: number, y: number, maxWidth?: number) {
    this.stamps.push({ kind: text, opacity: this.globalAlpha, position: this.position, angle: this.angle, area: [x, y, maxWidth ?? 0] });
  }
  drawImage(_image: Bitmap, x: number, y: number, width: number, height: number) {
    this.stamps.push({ kind: 'logo', opacity: this.globalAlpha, position: this.position, angle: this.angle, area: [x, y, width, height] });
  }
}

test('single text and staggered image tiles honor watermark placement, rotation, opacity, and layer order', async () => {
  const drawing = new Drawing();
  const loaded: string[] = [];
  await paintWatermarks(drawing, { width: 400, height: 300 }, [
    { kind: 'text', text: ' 样本 ', layout: 'single', x: 0.25, y: 0.75, angle: -30, opacity: 0.4, size: 0.1 },
    { kind: 'image', imagePath: 'wxfile://logo', layout: 'tile', stagger: true, angle: 0, opacity: 0.6, size: 0.2 },
  ], async (path) => {
    loaded.push(path);
    return { width: 120, height: 60 };
  });
  const [first, ...tiles] = drawing.stamps;
  assert.deepEqual(first, { kind: '样本', opacity: 0.4, position: [100, 225], angle: -Math.PI / 6, area: [0, 0, 100] });
  assert.ok(tiles.length > 6);
  assert.deepEqual(loaded, ['wxfile://logo']);
  assert.ok(tiles.every((tile) => tile.opacity === 0.6));
  assert.deepEqual(tiles[0].area, [-30, -15, 60, 30]);
  const columns = new Map<number, number>();
  for (const { position: [x, y] } of tiles) if (!columns.has(y)) columns.set(y, x);
  const [firstColumn, nextColumn] = [...columns.values()];
  assert.notEqual(firstColumn, nextColumn);
  assert.equal(drawing.globalAlpha, 1);
  assert.equal(drawing.history.length, 0);
});
