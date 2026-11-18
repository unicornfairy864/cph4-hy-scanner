import { detectDocument } from '../workers/image/detect';
import { renderDocument } from '../workers/image/render';
import type {
  Detection, Frame, ImageMode, ImageOperation, ImageQuality, Quad, RenderOptions, Rotation, WorkerReply, WorkerRequest,
} from '../workers/image/types';
import { orientationTransform, resetJpegOrientation } from './orientation';
import type { Transform } from './orientation';

export type { ImageMode, ImageQuality, Point, Quad, Rotation } from '../workers/image/types';

interface Source {
  imagePath: string;
}

interface ImageFile extends Source {
  width: number;
  height: number;
}

interface RenderRequest extends Source {
  corners: Quad;
  rotation: Rotation;
  mode: ImageMode;
  denoise: boolean;
  quality: ImageQuality;
  enhance?: boolean;
  maxDimension?: number;
  jpegQuality?: number;
}

interface CanvasImage {
  src: string;
  width: number;
  height: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface CanvasContext {
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  setTransform(...transform: Transform): void;
  drawImage(image: CanvasImage, x: number, y: number, width: number, height: number): void;
  getImageData(x: number, y: number, width: number, height: number): Frame;
  createImageData(width: number, height: number): Frame;
  putImageData(image: Frame, x: number, y: number): void;
}

interface Canvas {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasContext | null;
  createImage(): CanvasImage;
  toDataURL?(type: 'image/jpeg', quality: number): string;
}

interface ImageWorker {
  onMessage(callback: (message: WorkerReply) => void): void;
  onProcessKilled?(callback: () => void): void;
  postMessage(message: WorkerRequest): void;
  terminate(): void;
}

const platform = wx as unknown as {
  createOffscreenCanvas(options: { type: '2d'; width: number; height: number }): Canvas;
  createWorker(scriptPath: string): ImageWorker;
  canvasToTempFilePath(options: {
    canvas: Canvas; fileType: 'jpg'; quality: number;
    success: (result: { tempFilePath: string }) => void; fail: (error: unknown) => void;
  }): void;
};

const MAX_WORKING_EDGE = 2400;
const MAX_ORIENTATION_EDGE = 4096;
let pending: Promise<unknown> = Promise.resolve();
let imageWorker: ImageWorker | undefined;
let workerDisabled = false;
let messageCounter = 0;
let temporaryCounter = 0;
let workerResponse: ((message: WorkerReply) => void) | undefined;

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const current = pending.then(work);
  pending = current.catch(() => undefined);
  return current;
}

function canvas2d() {
  const canvas = platform.createOffscreenCanvas({ type: '2d', width: 1, height: 1 });
  function context(): CanvasContext {
    const result = canvas.getContext('2d');
    if (!result) throw new Error('当前微信版本无法创建图像处理画布');
    return result;
  }
  return { canvas, context };
}

function loadImage(canvas: Canvas, imagePath: string): Promise<CanvasImage> {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      if (image.width < 2 || image.height < 2) reject(new Error('图片尺寸太小'));
      else resolve(image);
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('无法读取这张图片'));
    };
    image.src = imagePath;
  });
}

function sizeAtMost(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

function temporaryPath(): string {
  return `${wx.env.USER_DATA_PATH}/scan-image-${Date.now()}-${temporaryCounter++}.jpg`;
}

function writeFile(filePath: string, data: ArrayBuffer | string, encoding?: 'base64'): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath, data, encoding, success: () => resolve(), fail: () => reject(new Error('无法保存处理后的图片')),
    });
  });
}

async function exportJpeg(canvas: Canvas, quality: number): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      platform.canvasToTempFilePath({
        canvas, fileType: 'jpg', quality,
        success: ({ tempFilePath }) => resolve(tempFilePath), fail: reject,
      });
    });
  } catch (error) {
    if (!canvas.toDataURL) throw error;
    const url = canvas.toDataURL('image/jpeg', quality);
    const prefix = 'data:image/jpeg;base64,';
    if (!url.startsWith(prefix)) throw new Error('无法将画布导出为 JPG');
    const path = temporaryPath();
    await writeFile(path, url.slice(prefix.length), 'base64');
    return path;
  }
}

function readFile(filePath: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: ({ data }) => resolve(typeof data === 'string' ? null : data),
      fail: () => resolve(null),
    });
  });
}

export function prepareImage({ imagePath }: Source): Promise<ImageFile> {
  return serialize(async () => {
    const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => {
      wx.getImageInfo({ src: imagePath, success: resolve, fail: () => reject(new Error('无法读取图片信息')) });
    });
    if (info.width < 2 || info.height < 2) throw new Error('图片尺寸太小');
    if (!info.orientation || info.orientation === 'up') {
      return { imagePath, width: info.width, height: info.height };
    }

    const bytes = await readFile(imagePath);
    const orientation = bytes ? resetJpegOrientation(bytes) : null;
    const rawPath = bytes && orientation && orientation !== 1 ? temporaryPath() : undefined;
    try {
      if (rawPath && bytes) await writeFile(rawPath, bytes);
      const { canvas, context } = canvas2d();
      const image = await loadImage(canvas, rawPath ?? imagePath);
      const size = sizeAtMost(image.width, image.height, MAX_ORIENTATION_EDGE);
      const transform = rawPath && orientation ? orientation : 1;
      const swapsSides = transform >= 5;
      canvas.width = swapsSides ? size.height : size.width;
      canvas.height = swapsSides ? size.width : size.height;
      const drawing = context();
      drawing.fillStyle = '#fff';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.setTransform(...orientationTransform(transform, size.width, size.height));
      drawing.drawImage(image, 0, 0, size.width, size.height);
      const resultPath = await exportJpeg(canvas, 0.96);
      return { imagePath: resultPath, width: canvas.width, height: canvas.height };
    } finally {
      if (rawPath) wx.getFileSystemManager().unlink({ filePath: rawPath, fail: () => undefined });
    }
  });
}

async function readFrame(imagePath: string, edge: number): Promise<Frame> {
  const { canvas, context } = canvas2d();
  const image = await loadImage(canvas, imagePath);
  const { width, height } = sizeAtMost(image.width, image.height, edge);
  canvas.width = width;
  canvas.height = height;
  const drawing = context();
  drawing.fillStyle = '#fff';
  drawing.fillRect(0, 0, width, height);
  drawing.drawImage(image, 0, 0, width, height);
  return drawing.getImageData(0, 0, width, height);
}

function sendToWorker(frame: Frame, operation: ImageOperation): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const id = ++messageCounter;
    const timeout = setTimeout(() => {
      workerResponse = undefined;
      reject(new Error('图像处理超时'));
    }, operation.type === 'detect' ? 5000 : 18000);

    workerResponse = (reply) => {
      if (reply.id !== id) return;
      clearTimeout(timeout);
      workerResponse = undefined;
      if (reply.type === 'error') reject(new Error(reply.message));
      else resolve(reply);
    };

    try {
      if (!imageWorker) {
        const currentWorker = platform.createWorker('workers/image/index.js');
        currentWorker.onMessage((reply) => workerResponse?.(reply));
        currentWorker.onProcessKilled?.(() => {
          if (imageWorker !== currentWorker) return;
          imageWorker = undefined;
          workerResponse?.({ id: messageCounter, type: 'error', message: '图像工作线程已关闭' });
        });
        imageWorker = currentWorker;
      }
      imageWorker.postMessage({
        id, operation, width: frame.width, height: frame.height, pixels: frame.data.buffer as ArrayBuffer,
      });
    } catch (error) {
      clearTimeout(timeout);
      workerResponse = undefined;
      reject(error);
    }
  });
}

function useLocalFallback(): void {
  workerDisabled = true;
  imageWorker?.terminate();
  imageWorker = undefined;
}

export function detectQuad({ imagePath }: Source): Promise<Detection> {
  return serialize(async () => {
    const frame = await readFrame(imagePath, 480);
    if (!workerDisabled) {
      try {
        const reply = await sendToWorker(frame, { type: 'detect' });
        if (reply.type === 'detect' && reply.result && Number.isFinite(reply.result.confidence)) return reply.result;
        useLocalFallback();
      } catch {
        useLocalFallback();
      }
    }
    return detectDocument(frame);
  });
}

async function renderFrame(frame: Frame, options: RenderOptions): Promise<Frame> {
  if (!workerDisabled) {
    try {
      const reply = await sendToWorker(frame, { type: 'render', options });
      if (reply.type === 'render' && reply.pixels instanceof ArrayBuffer
        && reply.pixels.byteLength === 4 * reply.width * reply.height) {
        return { width: reply.width, height: reply.height, data: new Uint8ClampedArray(reply.pixels) };
      }
      useLocalFallback();
    } catch {
      useLocalFallback();
    }
  }
  return renderDocument(frame, options);
}

export function renderPage({
  imagePath, corners, rotation, mode, denoise, enhance, quality, maxDimension, jpegQuality,
}: RenderRequest): Promise<ImageFile> {
  return serialize(async () => {
    const fallbackEdge = quality === 'preview' ? 880 : 2200;
    const outputEdge = Number.isFinite(maxDimension) && maxDimension !== undefined
      ? Math.max(2, Math.min(MAX_WORKING_EDGE, Math.round(maxDimension))) : fallbackEdge;
    const fallbackQuality = quality === 'preview' ? 0.85 : 0.92;
    const outputQuality = Number.isFinite(jpegQuality) && jpegQuality !== undefined
      ? Math.max(0, Math.min(1, jpegQuality)) : fallbackQuality;
    const frame = await readFrame(imagePath, quality === 'preview' ? Math.max(1024, outputEdge) : MAX_WORKING_EDGE);
    const result = await renderFrame(frame, { corners, rotation, mode, denoise, enhance, maxDimension: outputEdge });

    const { canvas, context } = canvas2d();
    canvas.width = result.width;
    canvas.height = result.height;
    const drawing = context();
    const output = drawing.createImageData(result.width, result.height);
    output.data.set(result.data);
    drawing.putImageData(output, 0, 0);
    const resultPath = await exportJpeg(canvas, outputQuality);
    return { imagePath: resultPath, width: result.width, height: result.height };
  });
}
