import assert from 'node:assert/strict';
import test from 'node:test';

class FakeCanvas {
  static decodedPaths: string[] = [];
  width = 1;
  height = 1;
  written: Uint8ClampedArray | undefined;
  edits: string[] = [];

  createImage() {
    return {
      width: 80,
      height: 60,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      set src(value: string) {
        FakeCanvas.decodedPaths.push(value);
        if (value === 'wxfile://no-decode-callback.jpg') return;
        assert.equal(value, 'wxfile://scan.jpg');
        queueMicrotask(() => this.onload?.());
      },
    };
  }

  getContext() {
    return {
      fillRect: () => undefined,
      drawImage: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      setTransform: () => { this.edits.push('rotate'); },
      translate: () => undefined,
      rotate: () => undefined,
      measureText: () => ({ width: 12 }),
      fillText: () => { this.edits.push('watermark'); },
      getImageData: (x: number, y: number, width: number, height: number) => {
        assert.deepEqual([x, y, width, height], [0, 0, this.width, this.height]);
        return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(245) };
      },
      createImageData: (width: number, height: number) => ({
        width, height, data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: ({ data }: { data: Uint8ClampedArray }) => {
        this.written = data;
        this.edits.push('pixels');
      },
    };
  }
}

test('keeps local rendering and JPG export available after Worker creation fails', async (t) => {
  let workerRequests = 0;
  const outputEdits: string[][] = [];
  const source = 'wxfile://scan.jpg';
  let finishImageInfo: (() => void) | undefined;
  Object.defineProperty(globalThis, 'wx', {
    configurable: true,
    value: {
      getImageInfo: ({ src, success }: { src: string; success: (value: object) => void }) => {
        const finish = () => success({ width: 80, height: 60, orientation: 'up' });
        if (src === 'wxfile://queued.jpg') finishImageInfo = finish;
        else {
          assert.equal(src, source);
          finish();
        }
      },
      createOffscreenCanvas: () => new FakeCanvas(),
      createWorker: () => { workerRequests++; throw new Error('worker unavailable'); },
      canvasToTempFilePath: ({ canvas, fileType, quality, success }: {
        canvas: FakeCanvas; fileType: string; quality: number; success: (value: object) => void;
      }) => {
        assert.equal(fileType, 'jpg');
        assert.equal(quality, 0.9);
        assert.equal(canvas.written?.length, 30 * 40 * 4);
        outputEdits.push(canvas.edits);
        success({ tempFilePath: 'wxfile://result.jpg' });
      },
    },
  });

  try {
    const { prepareImage, detectQuad, renderPage, decorateImage } = await import('../miniprogram/image/index');
    const image = await prepareImage({ imagePath: source });
    assert.deepEqual(image, { imagePath: source, width: 80, height: 60 });
    assert.deepEqual(await detectQuad(image), { corners: null, confidence: 0, cornerConfidences: [0, 0, 0, 0] });
    const result = await renderPage({
      imagePath: image.imagePath,
      corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      rotation: 90, denoise: false, mode: 'color', quality: 'export', maxDimension: 40, jpegQuality: 0.9,
    });
    assert.deepEqual(result, { imagePath: 'wxfile://result.jpg', width: 30, height: 40 });
    const decorated = await decorateImage({
      imagePath: image.imagePath, rotation: 90, quality: 'export', maxDimension: 40, jpegQuality: 0.9,
      decorations: {
        mosaics: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
        watermarks: [{ kind: 'text', text: '现已编辑', layout: 'single', opacity: 0.3, size: 0.2, angle: 0 }],
      },
    });
    assert.deepEqual(decorated, { imagePath: 'wxfile://result.jpg', width: 30, height: 40 });
    assert.deepEqual(outputEdits, [['pixels'], ['rotate', 'pixels', 'watermark']]);
    assert.equal(workerRequests, 1);

    await t.test('detection times out when the image decoder never calls back', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const failed = detectQuad({ imagePath: 'wxfile://no-decode-callback.jpg' });
      await Promise.resolve();
      t.mock.timers.tick(3000);
      await assert.rejects(failed, /读取图片超时/);
      assert.equal((await detectQuad(image)).corners, null);
    });

    await t.test('detection times out while queued and skips stale work', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const held = prepareImage({ imagePath: 'wxfile://queued.jpg' });
      const failed = detectQuad({ imagePath: 'wxfile://never-read.jpg' });
      t.mock.timers.tick(10000);
      await assert.rejects(failed, /识别页边超时/);
      assert.ok(finishImageInfo);
      finishImageInfo();
      await held;
      assert.equal((await detectQuad(image)).corners, null);
      assert.ok(!FakeCanvas.decodedPaths.includes('wxfile://never-read.jpg'));
    });
  } finally {
    Reflect.deleteProperty(globalThis, 'wx');
  }
});
