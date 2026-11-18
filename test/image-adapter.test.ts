import assert from 'node:assert/strict';
import test from 'node:test';

class FakeCanvas {
  width = 1;
  height = 1;
  written: Uint8ClampedArray | undefined;

  createImage() {
    return {
      width: 80,
      height: 60,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      set src(value: string) {
        assert.equal(value, 'wxfile://scan.jpg');
        queueMicrotask(() => this.onload?.());
      },
    };
  }

  getContext() {
    return {
      fillRect: () => undefined,
      drawImage: () => undefined,
      getImageData: (x: number, y: number, width: number, height: number) => {
        assert.deepEqual([x, y, width, height], [0, 0, this.width, this.height]);
        return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(245) };
      },
      createImageData: (width: number, height: number) => ({
        width, height, data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: ({ data }: { data: Uint8ClampedArray }) => { this.written = data; },
    };
  }
}

test('keeps local rendering and JPG export available after Worker creation fails', async () => {
  let workerRequests = 0;
  const source = 'wxfile://scan.jpg';
  Object.defineProperty(globalThis, 'wx', {
    configurable: true,
    value: {
      getImageInfo: ({ src, success }: { src: string; success: (value: object) => void }) => {
        assert.equal(src, source);
        success({ width: 80, height: 60, orientation: 'up' });
      },
      createOffscreenCanvas: () => new FakeCanvas(),
      createWorker: () => { workerRequests++; throw new Error('worker unavailable'); },
      canvasToTempFilePath: ({ canvas, fileType, quality, success }: {
        canvas: FakeCanvas; fileType: string; quality: number; success: (value: object) => void;
      }) => {
        assert.equal(fileType, 'jpg');
        assert.equal(quality, 0.9);
        assert.equal(canvas.written?.length, 30 * 40 * 4);
        success({ tempFilePath: 'wxfile://result.jpg' });
      },
    },
  });

  try {
    const { prepareImage, detectQuad, renderPage } = await import('../miniprogram/image/index');
    const image = await prepareImage({ imagePath: source });
    assert.deepEqual(image, { imagePath: source, width: 80, height: 60 });
    assert.deepEqual(await detectQuad(image), { corners: null, confidence: 0, cornerConfidences: [0, 0, 0, 0] });
    const result = await renderPage({
      imagePath: image.imagePath,
      corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      rotation: 90, denoise: false, mode: 'color', quality: 'export', maxDimension: 40, jpegQuality: 0.9,
    });
    assert.deepEqual(result, { imagePath: 'wxfile://result.jpg', width: 30, height: 40 });
    assert.equal(workerRequests, 1);
  } finally {
    Reflect.deleteProperty(globalThis, 'wx');
  }
});
