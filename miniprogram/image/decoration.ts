import type { MosaicRegion } from '../workers/image/types';

interface WatermarkOptions {
  layout: 'single' | 'tile';
  opacity: number;
  size: number;
  angle: number;
  x?: number;
  y?: number;
  stagger?: boolean;
  spacing?: number;
}

export interface TextWatermark extends WatermarkOptions {
  kind: 'text';
  text: string;
  color?: string;
}

export interface ImageWatermark extends WatermarkOptions {
  kind: 'image';
  imagePath: string;
}

export type Watermark = TextWatermark | ImageWatermark;

export interface ImageDecorations {
  mosaics?: MosaicRegion[];
  watermarks?: Watermark[];
}

interface Bitmap {
  width: number;
  height: number;
}

export interface WatermarkContext<T extends Bitmap> {
  globalAlpha: number;
  fillStyle: string;
  font: string;
  textAlign: 'center';
  textBaseline: 'middle';
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  drawImage(image: T, x: number, y: number, width: number, height: number): void;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function paintLayout(
  drawing: Pick<WatermarkContext<Bitmap>, 'save' | 'restore' | 'translate' | 'rotate'>,
  page: Bitmap,
  mark: Watermark,
  footprint: Bitmap,
  paint: () => void,
): void {
  const angle = Number.isFinite(mark.angle) ? (mark.angle % 360) * Math.PI / 180 : 0;
  const centerX = bounded(mark.x, 0.5, 0, 1) * page.width;
  const centerY = bounded(mark.y, 0.5, 0, 1) * page.height;
  const stamp = (x: number, y: number) => {
    drawing.save();
    try {
      drawing.translate(x, y);
      if (angle !== 0) drawing.rotate(angle);
      paint();
    } finally {
      drawing.restore();
    }
  };
  if (mark.layout === 'single') {
    stamp(centerX, centerY);
    return;
  }

  const sin = Math.abs(Math.sin(angle));
  const cos = Math.abs(Math.cos(angle));
  const reachX = (cos * footprint.width + sin * footprint.height) / 2;
  const reachY = (sin * footprint.width + cos * footprint.height) / 2;
  const gap = bounded(mark.spacing, 0.1, -0.35, 1) * Math.min(page.width, page.height);
  const stepX = Math.max(2 * reachX + gap, page.width / 23, 1);
  const stepY = Math.max(2 * reachY + gap, page.height / 23, 1);
  const firstRow = Math.ceil((-reachY - centerY) / stepY);
  for (let row = firstRow, y = centerY + row * stepY; y <= page.height + reachY; y += stepY, row++) {
    const anchorX = centerX + (mark.stagger && row % 2 !== 0 ? stepX / 2 : 0);
    const firstX = anchorX + Math.ceil((-reachX - anchorX) / stepX) * stepX;
    for (let x = firstX; x <= page.width + reachX; x += stepX) stamp(x, y);
  }
}

export async function paintWatermarks<T extends Bitmap>(
  drawing: WatermarkContext<T>, page: Bitmap, marks: Watermark[] | undefined,
  loadBitmap: (path: string) => Promise<T>,
): Promise<void> {
  for (const mark of marks ?? []) {
    const opacity = bounded(mark.opacity, 0.3, 0, 1);
    if (opacity === 0) continue;
    const size = bounded(mark.size, 0.15, 0.012, 0.95) * Math.min(page.width, page.height);
    drawing.save();
    try {
      drawing.globalAlpha = opacity;
      if (mark.kind === 'text') {
        const text = Array.from(mark.text.trim().replace(/\s+/g, ' ')).slice(0, 160).join('');
        if (!text) continue;
        const fontSize = Math.max(5, size);
        drawing.font = `bold ${fontSize}px sans-serif`;
        drawing.fillStyle = '#26342d';
        if (mark.color) drawing.fillStyle = mark.color;
        drawing.textAlign = 'center';
        drawing.textBaseline = 'middle';
        const footprint = { width: Math.min(drawing.measureText(text).width, page.width * 0.9), height: fontSize };
        paintLayout(drawing, page, mark, footprint, () => drawing.fillText(text, 0, 0, footprint.width));
      } else {
        const bitmap = await loadBitmap(mark.imagePath);
        const scale = size / Math.max(bitmap.width, bitmap.height);
        const footprint = { width: bitmap.width * scale, height: bitmap.height * scale };
        paintLayout(drawing, page, mark, footprint, () => {
          drawing.drawImage(bitmap, -footprint.width / 2, -footprint.height / 2, footprint.width, footprint.height);
        });
      }
    } finally {
      drawing.restore();
    }
  }
}
