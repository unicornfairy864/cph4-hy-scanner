import type { Frame, FinishOptions, MosaicRegion, SharpenStrength } from './types';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function sharpenFrame({ width, height, data }: Frame, strength: SharpenStrength = 'off'): void {
  if (strength === 'off' || width < 3 || height < 3) return;

  const gray = new Uint8Array(width * height);
  for (let position = 0; position < gray.length; position++) {
    const pixel = position * 4;
    gray[position] = (77 * data[pixel] + 150 * data[pixel + 1] + 29 * data[pixel + 2]) >> 8;
  }
  const gain = strength === 'strong' ? 0.85 : 0.42;
  const limit = strength === 'strong' ? 35 : 17;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const position = y * width + x;
      const neighbors = gray[position - 1] + gray[position + 1] + gray[position - width] + gray[position + width];
      const detail = gray[position] - neighbors / 4;
      if (Math.abs(detail) < 3) continue;
      const change = clamp(detail * gain, -limit, limit);
      const pixel = position * 4;
      for (let channel = 0; channel < 3; channel++) data[pixel + channel] += change;
    }
  }
}

export function mosaicFrame({ width, height, data }: Frame, regions: MosaicRegion[] = []): void {
  for (const region of regions) {
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite)
      || region.width <= 0 || region.height <= 0) continue;
    const left = clamp(Math.floor(region.x * width), 0, width);
    const top = clamp(Math.floor(region.y * height), 0, height);
    const right = clamp(Math.ceil((region.x + region.width) * width), 0, width);
    const bottom = clamp(Math.ceil((region.y + region.height) * height), 0, height);
    const ratio = region.blockSize !== undefined && Number.isFinite(region.blockSize) ? region.blockSize : 0.025;
    const block = Math.max(3, Math.round(clamp(ratio, 0.005, 0.3) * Math.min(width, height)));
    for (let y = top; y < bottom; y += block) {
      const endY = Math.min(y + block, bottom);
      for (let x = left; x < right; x += block) {
        const endX = Math.min(x + block, right);
        let red = 0;
        let green = 0;
        let blue = 0;
        for (let row = y; row < endY; row++) {
          for (let column = x; column < endX; column++) {
            const pixel = (row * width + column) * 4;
            red += data[pixel];
            green += data[pixel + 1];
            blue += data[pixel + 2];
          }
        }
        const size = (endX - x) * (endY - y);
        for (let row = y; row < endY; row++) {
          for (let column = x; column < endX; column++) {
            const pixel = (row * width + column) * 4;
            data[pixel] = red / size;
            data[pixel + 1] = green / size;
            data[pixel + 2] = blue / size;
          }
        }
      }
    }
  }
}

export function finishImage(frame: Frame, options: FinishOptions): Frame {
  sharpenFrame(frame, options.sharpen);
  mosaicFrame(frame, options.mosaics);
  return frame;
}
