import { detectDocument } from './detect';
import { renderDocument } from './render';
import type { Frame, WorkerReply, WorkerRequest } from './types';

declare const worker: {
  onMessage(callback: (message: WorkerRequest) => void): void;
  postMessage(message: WorkerReply): void;
};

worker.onMessage(({ id, operation, width, height, pixels }) => {
  try {
    const frame: Frame = { width, height, data: new Uint8ClampedArray(pixels) };
    if (frame.data.length !== 4 * width * height) throw new Error('图像像素传输失败');
    if (operation.type === 'detect') {
      worker.postMessage({ id, type: 'detect', result: detectDocument(frame) });
      return;
    }
    const result = renderDocument(frame, operation.options);
    worker.postMessage({
      id,
      type: 'render',
      width: result.width,
      height: result.height,
      pixels: result.data.buffer as ArrayBuffer,
    });
  } catch (error) {
    worker.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : '图像处理失败' });
  }
});
