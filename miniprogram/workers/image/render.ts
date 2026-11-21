import { flattenBookPage } from './dewarp';
import { mosaicFrame, sharpenFrame } from './finish';
import type { Frame, Point, Quad, RenderOptions, Rotation } from './types';

function luminance(red: number, green: number, blue: number): number {
  return (77 * red + 150 * green + 29 * blue) >> 8;
}

function checkCorners(corners: Quad): void {
  for (let index = 0; index < 4; index++) {
    const point = corners[index];
    const next = corners[(index + 1) % 4];
    const after = corners[(index + 2) % 4];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.y < 0 || point.x > 1 || point.y > 1) {
      throw new Error('裁剪角点超出图片范围');
    }
    const cross = (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
    if (cross <= 0.00001) throw new Error('请将四角按顺时针调整为四边形');
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function projectiveTransform([topLeft, topRight, bottomRight, bottomLeft]: Quad) {
  const firstX = topRight.x - bottomRight.x;
  const secondX = bottomLeft.x - bottomRight.x;
  const sumX = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const firstY = topRight.y - bottomRight.y;
  const secondY = bottomLeft.y - bottomRight.y;
  const sumY = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const determinant = firstX * secondY - secondX * firstY;
  const xScale = (sumX * secondY - secondX * sumY) / determinant;
  const yScale = (firstX * sumY - sumX * firstY) / determinant;
  return {
    xOffset: topLeft.x,
    yOffset: topLeft.y,
    xAlongU: topRight.x - topLeft.x + xScale * topRight.x,
    xAlongV: bottomLeft.x - topLeft.x + yScale * bottomLeft.x,
    yAlongU: topRight.y - topLeft.y + xScale * topRight.y,
    yAlongV: bottomLeft.y - topLeft.y + yScale * bottomLeft.y,
    xScale,
    yScale,
  };
}

function warp(source: Frame, { corners, rotation, maxDimension }: RenderOptions): Frame {
  checkCorners(corners);
  const pixels = corners.map(({ x, y }) => ({
    x: x * (source.width - 1),
    y: y * (source.height - 1),
  })) as Quad;

  const naturalWidth = (distance(pixels[0], pixels[1]) + distance(pixels[3], pixels[2])) / 2 + 1;
  const naturalHeight = (distance(pixels[0], pixels[3]) + distance(pixels[1], pixels[2])) / 2 + 1;
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  const pageWidth = Math.max(2, Math.round(naturalWidth * scale));
  const pageHeight = Math.max(2, Math.round(naturalHeight * scale));
  const quarterTurn = rotation === 90 || rotation === 270;
  const width = quarterTurn ? pageHeight : pageWidth;
  const height = quarterTurn ? pageWidth : pageHeight;
  const data = new Uint8ClampedArray(width * height * 4);
  const transform = projectiveTransform(pixels);

  const inverseX = 1 / (width - 1);
  const inverseY = 1 / (height - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const horizontal = x * inverseX;
      const vertical = y * inverseY;
      let u = horizontal;
      let v = vertical;
      switch (rotation) {
        case 90: u = vertical; v = 1 - horizontal; break;
        case 180: u = 1 - horizontal; v = 1 - vertical; break;
        case 270: u = 1 - vertical; v = horizontal; break;
      }
      const divisor = 1 + transform.xScale * u + transform.yScale * v;
      const sourceX = Math.max(0, Math.min(source.width - 1,
        (transform.xOffset + transform.xAlongU * u + transform.xAlongV * v) / divisor));
      const sourceY = Math.max(0, Math.min(source.height - 1,
        (transform.yOffset + transform.yAlongU * u + transform.yAlongV * v) / divisor));
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(x0 + 1, source.width - 1);
      const y1 = Math.min(y0 + 1, source.height - 1);
      const xWeight = sourceX - x0;
      const yWeight = sourceY - y0;
      const topLeft = 4 * (y0 * source.width + x0);
      const topRight = 4 * (y0 * source.width + x1);
      const bottomLeft = 4 * (y1 * source.width + x0);
      const bottomRight = 4 * (y1 * source.width + x1);
      const output = 4 * (y * width + x);
      for (let channel = 0; channel < 3; channel++) {
        const top = source.data[topLeft + channel] * (1 - xWeight) + source.data[topRight + channel] * xWeight;
        const bottom = source.data[bottomLeft + channel] * (1 - xWeight) + source.data[bottomRight + channel] * xWeight;
        data[output + channel] = top * (1 - yWeight) + bottom * yWeight;
      }
      data[output + 3] = 255;
    }
  }
  return { width, height, data };
}

function rotateFrame(frame: Frame, rotation: Rotation): Frame {
  if (rotation === 0) return frame;
  const quarterTurn = rotation !== 180;
  const width = quarterTurn ? frame.height : frame.width;
  const height = quarterTurn ? frame.width : frame.height;
  const source = new Uint32Array(frame.data.buffer, frame.data.byteOffset, frame.width * frame.height);
  const pixels = new Uint32Array(width * height);
  const firstPixel = rotation === 90 ? (frame.height - 1) * frame.width
    : rotation === 180 ? source.length - 1 : frame.width - 1;
  const rowStep = rotation === 90 ? 1 : rotation === 180 ? -frame.width : -1;
  const columnStep = rotation === 90 ? -frame.width : rotation === 180 ? -1 : frame.width;
  for (let y = 0; y < height; y++) {
    let sourceIndex = firstPixel + y * rowStep;
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = source[sourceIndex];
      sourceIndex += columnStep;
    }
  }
  return { width, height, data: new Uint8ClampedArray(pixels.buffer) };
}

function removeIsolatedPixels(frame: Frame): void {
  const { width, height, data } = frame;
  const values = new Uint8Array(width * height);
  for (let position = 0; position < values.length; position++) {
    const offset = position * 4;
    values[position] = luminance(data[offset], data[offset + 1], data[offset + 2]);
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const position = y * width + x;
      const center = values[position];
      // A similar neighbor rules out an isolated high-contrast pixel.
      if (Math.abs(center - values[position - width]) < 38) continue;
      let low = 255;
      let high = 0;
      for (let row = -1; row <= 1; row++) {
        for (let column = -1; column <= 1; column++) {
          if (row === 0 && column === 0) continue;
          const neighbor = values[position + row * width + column];
          low = Math.min(low, neighbor);
          high = Math.max(high, neighbor);
        }
      }
      if (high - low > 24 || (low - center < 38 && center - high < 38)) continue;
      const reference = 4 * (position - width);
      const offset = 4 * position;
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = data[reference + channel];
    }
  }
}

function backgroundGrid(frame: Frame): { columns: number; rows: number; values: Uint8Array; reference: number } {
  const { width, height, data } = frame;
  const columns = Math.min(16, Math.max(2, Math.ceil(width / 95)));
  const rows = Math.min(20, Math.max(2, Math.ceil(height / 95)));
  const values = new Uint8Array(columns * rows);
  const histogram = new Uint16Array(256);

  for (let row = 0; row < rows; row++) {
    const startY = Math.floor(row * height / rows);
    const endY = Math.floor((row + 1) * height / rows);
    for (let column = 0; column < columns; column++) {
      const startX = Math.floor(column * width / columns);
      const endX = Math.floor((column + 1) * width / columns);
      histogram.fill(0);
      let sampled = 0;
      for (let y = startY; y < endY; y += 3) {
        for (let x = startX; x < endX; x += 3) {
          const offset = 4 * (y * width + x);
          histogram[luminance(data[offset], data[offset + 1], data[offset + 2])]++;
          sampled++;
        }
      }
      let cumulative = 0;
      for (let value = 0; value <= 255; value++) {
        cumulative += histogram[value];
        if (cumulative >= 0.82 * sampled) {
          values[row * columns + column] = value;
          break;
        }
      }
    }
  }
  const ordered = values.slice().sort();
  return { columns, rows, values, reference: ordered[Math.floor(ordered.length * 0.85)] };
}

function enhance(frame: Frame, { mode, enhance: correctLight }: RenderOptions): void {
  if (!correctLight && mode === 'color') return;
  const { width, height, data } = frame;
  const grid = correctLight || mode === 'bw' ? backgroundGrid(frame) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 4 * (y * width + x);
      let red = data[offset];
      let green = data[offset + 1];
      let blue = data[offset + 2];
      let background = 255;
      if (grid) {
        const gridX = Math.max(0, Math.min(grid.columns - 1, (x + 0.5) * grid.columns / width - 0.5));
        const gridY = Math.max(0, Math.min(grid.rows - 1, (y + 0.5) * grid.rows / height - 0.5));
        const left = Math.floor(gridX);
        const top = Math.floor(gridY);
        const right = Math.min(grid.columns - 1, left + 1);
        const bottom = Math.min(grid.rows - 1, top + 1);
        const mixedTop = grid.values[top * grid.columns + left] * (1 - gridX + left)
          + grid.values[top * grid.columns + right] * (gridX - left);
        const mixedBottom = grid.values[bottom * grid.columns + left] * (1 - gridX + left)
          + grid.values[bottom * grid.columns + right] * (gridX - left);
        background = mixedTop * (1 - gridY + top) + mixedBottom * (gridY - top);
        if (correctLight && grid.reference - background > 8) {
          const gain = Math.min(1.55, (grid.reference - 8) / Math.max(1, background));
          red = Math.min(255, red * gain);
          green = Math.min(255, green * gain);
          blue = Math.min(255, blue * gain);
          background *= gain;
        }
      }

      if (mode !== 'color') {
        const gray = luminance(red, green, blue);
        const value = mode === 'bw' ? (gray < Math.max(12, background - Math.max(14, background * 0.16)) ? 0 : 255) : gray;
        red = value;
        green = value;
        blue = value;
      }
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
    }
  }
}

export function renderDocument(source: Frame, options: RenderOptions): Frame {
  const result = options.dewarp
    ? rotateFrame(flattenBookPage(warp(source, { ...options, rotation: 0 })), options.rotation)
    : warp(source, options);
  if (options.denoise) removeIsolatedPixels(result);
  sharpenFrame(result, options.sharpen);
  enhance(result, options);
  mosaicFrame(result, options.mosaics);
  return result;
}
