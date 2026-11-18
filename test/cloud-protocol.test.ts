import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudStatus, OcrResult } from '../miniprogram/services/cloud';

interface RequestOptions {
  url: string;
  method: string;
  header: Record<string, string>;
  success(result: { statusCode: number; data?: unknown }): void;
}

interface UploadOptions {
  filePath: string;
  name: string;
  formData: Record<string, string>;
  header: Record<string, string>;
  success(result: { statusCode: number; data: string }): void;
  fail(): void;
}

interface DownloadOptions {
  url: string;
  header: Record<string, string>;
  success(result: { statusCode: number; tempFilePath: string }): void;
}

test('cloud OCR and image enhancement share the authorized queue and cleanup', async (t) => {
  const runtime = globalThis as typeof globalThis & { SCANNER_API_BASE_URL?: string };
  const previousUrl = runtime.SCANNER_API_BASE_URL;
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, 'wx');
  const jobId = 'a'.repeat(32);
  const jobPath = `/v1/jobs/${jobId}`;
  const requests: string[] = [];
  const uploads: UploadOptions[] = [];
  const downloads: string[] = [];
  const removed: string[] = [];
  let loginCount = 0;
  let uploadStatus: CloudStatus = 'succeeded';
  let errorCode: string | undefined;
  let failUpload = false;
  let result: unknown;
  let onLogin = () => {};
  let onResult = () => {};

  function resetTrace(): void {
    requests.length = 0;
    uploads.length = 0;
    downloads.length = 0;
    removed.length = 0;
    uploadStatus = 'succeeded';
    errorCode = undefined;
    failUpload = false;
    onLogin = () => {};
    onResult = () => {};
  }

  runtime.SCANNER_API_BASE_URL = 'https://scanner.example.test';
  const fakeWx = {
    login({ success }: { success(result: { code: string }): void }) {
      loginCount += 1;
      onLogin();
      success({ code: 'mock-login-code' });
    },
    request(options: RequestOptions) {
      const { pathname } = new URL(options.url);
      requests.push(`${options.method} ${pathname}`);
      if (pathname === '/v1/auth/wechat') {
        options.success({ statusCode: 200, data: { accessToken: 'mock-session', expiresIn: 900 } });
        return;
      }
      assert.equal(options.header.Authorization, 'Bearer mock-session');
      if (options.method === 'DELETE') options.success({ statusCode: 204 });
      else if (pathname === jobPath) options.success({ statusCode: 200, data: { jobId, status: 'succeeded' } });
      else {
        assert.equal(pathname, jobPath + '/result');
        onResult();
        options.success({ statusCode: 200, data: result });
      }
    },
    uploadFile(options: UploadOptions) {
      uploads.push(options);
      assert.equal(options.header.Authorization, 'Bearer mock-session');
      assert.equal(options.name, 'file');
      if (failUpload) {
        failUpload = false;
        options.fail();
        return;
      }
      options.success({ statusCode: 202, data: JSON.stringify({ jobId, status: uploadStatus, error: { code: errorCode } }) });
    },
    downloadFile(options: DownloadOptions) {
      assert.equal(options.header.Authorization, 'Bearer mock-session');
      downloads.push(new URL(options.url).pathname);
      onResult();
      options.success({ statusCode: 200, tempFilePath: 'mock-result.jpg' });
    },
    getFileSystemManager: () => ({
      unlink: ({ filePath }: { filePath: string }) => removed.push(filePath),
    }),
  };
  Object.defineProperty(globalThis, 'wx', { configurable: true, writable: true, value: fakeWx });

  try {
    const { cloudEnabled, runCloudOcr, runCloudEnhancement } = await import('../miniprogram/services/cloud');
    assert.equal(cloudEnabled, true);

    await t.test('cancelling during login prevents submission', async () => {
      resetTrace();
      let cancelled = false;
      onLogin = () => { cancelled = true; };
      await assert.rejects(runCloudOcr({ imagePath: 'mock-page.jpg', isCancelled: () => cancelled }), /已取消/);
      assert.equal(loginCount, 1);
      assert.deepEqual(requests, ['POST /v1/auth/wechat']);
      assert.equal(uploads.length, 0);
    });

    await t.test('retries a lost upload response with the same request ID and reads JSON after polling', async () => {
      resetTrace();
      const expected: OcrResult = { text: '正文\nPage 1', width: 200, height: 300, lines: [
        { text: '正文', box: [0, 20, 70, 15] },
        { text: 'Page 1', box: [130, 280, 70, 20] },
      ] };
      result = expected;
      failUpload = true;
      uploadStatus = 'queued';
      const statuses: CloudStatus[] = [];
      const actual = await runCloudOcr({ imagePath: 'mock-page.jpg', onStatus: (status) => statuses.push(status) });
      assert.deepEqual(actual, expected);
      assert.deepEqual(uploads.map(({ formData }) => formData.operation), ['ocr', 'ocr']);
      assert.equal(uploads[0].formData.clientRequestId, uploads[1].formData.clientRequestId);
      assert.ok(uploads[0].formData.clientRequestId);
      assert.deepEqual(statuses, ['queued', 'succeeded']);
      assert.deepEqual(requests, [`GET ${jobPath}`, `GET ${jobPath}/result`, `DELETE ${jobPath}`]);
      assert.deepEqual(downloads, []);
    });

    await t.test('accepts an empty result and rejects boxes outside the source image', async () => {
      resetTrace();
      const empty = { text: '', width: 1, height: 2, lines: [] };
      result = JSON.stringify(empty);
      assert.deepEqual(await runCloudOcr({ imagePath: 'mock-page.jpg' }), empty);
      result = { ...empty, lines: [{ text: 'no', box: [0, 1, 1, 2] }] };
      await assert.rejects(runCloudOcr({ imagePath: 'mock-page.jpg' }), /无法读取云端文字识别结果/);
      assert.equal(requests.filter((request) => request.startsWith('DELETE')).length, 2);
    });

    await t.test('maps the OCR unavailable error and deletes the failed job', async () => {
      resetTrace();
      uploadStatus = 'failed';
      errorCode = 'ocr_unavailable';
      await assert.rejects(runCloudOcr({ imagePath: 'mock-page.jpg' }), /云端文字识别暂不可用/);
      assert.deepEqual(requests, [`DELETE ${jobPath}`]);
    });

    await t.test('discards results after cancellation and removes downloaded image files', async () => {
      resetTrace();
      let cancelled = false;
      result = { text: '', width: 1, height: 1, lines: [] };
      onResult = () => { cancelled = true; };
      await assert.rejects(runCloudOcr({ imagePath: 'mock-page.jpg', isCancelled: () => cancelled }), /已取消/);
      assert.deepEqual(requests, [`GET ${jobPath}/result`, `DELETE ${jobPath}`]);

      resetTrace();
      cancelled = false;
      onResult = () => { cancelled = true; };
      await assert.rejects(runCloudEnhancement({ imagePath: 'mock-page.jpg', operation: 'dewarp',
        isCancelled: () => cancelled }), /已取消/);
      assert.deepEqual(downloads, [jobPath + '/result']);
      assert.deepEqual(removed, ['mock-result.jpg']);
      assert.deepEqual(requests, [`DELETE ${jobPath}`]);
    });

    await t.test('continues to return an image path for successful image enhancement', async () => {
      resetTrace();
      assert.deepEqual(await runCloudEnhancement({ imagePath: 'mock-page.jpg', operation: 'deshadow' }), { imagePath: 'mock-result.jpg' });
      assert.equal(uploads[0].formData.operation, 'deshadow');
      assert.deepEqual(downloads, [jobPath + '/result']);
      assert.deepEqual(removed, []);
      assert.deepEqual(requests, [`DELETE ${jobPath}`]);
    });
  } finally {
    if (previousWx) Object.defineProperty(globalThis, 'wx', previousWx);
    else Reflect.deleteProperty(globalThis, 'wx');
    if (previousUrl === undefined) delete runtime.SCANNER_API_BASE_URL;
    else runtime.SCANNER_API_BASE_URL = previousUrl;
  }
});
