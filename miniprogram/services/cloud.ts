declare const SCANNER_API_BASE_URL: string;

export type CloudOperation = 'dewarp' | 'deshadow';
export type CloudStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface CloudJob {
  jobId: string;
  status: CloudStatus;
  errorCode?: string;
}

interface EnhancementOptions {
  imagePath: string;
  operation: CloudOperation;
  onStatus?(status: CloudStatus): void;
  isCancelled?(): boolean;
}

interface Session {
  token: string;
  validUntil: number;
}

const configuredUrl = (typeof SCANNER_API_BASE_URL === 'string' ? SCANNER_API_BASE_URL : '')
  .trim().replace(/\/+$/, '');
const httpsEndpoint = /^https:\/\/(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d{1,5})?(?:\/[a-z0-9_/-]+)?$/i;
const apiBaseUrl = httpsEndpoint.test(configuredUrl) ? configuredUrl : '';
export const cloudEnabled = apiBaseUrl !== '';

const REQUEST_TIMEOUT = 8000;
const UPLOAD_TIMEOUT = 25000;
const TASK_TIMEOUT = 85000;
const POLL_INTERVAL = 1000;

let session: Session | undefined;
let pendingLogin: Promise<Session> | undefined;
let requestSequence = 0;

class NetworkError extends Error {}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(({
      401: '微信登录失效，请重新尝试',
      404: '云端任务已过期，请重新提交',
      409: '云端任务状态已变化，请重新尝试',
      413: '这张图片超过云端处理大小限制',
      422: '云端无法读取这张图片',
      429: '云端正在处理其他页面，请稍后重试',
    } as Record<number, string>)[status] ?? '云端处理暂不可用，请稍后重试');
  }
}

function responseObject(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('无法读取云端返回的结果');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('无法读取云端返回的结果');
  }
  return value as Record<string, unknown>;
}

function requireSuccess(status: number): void {
  if (status < 200 || status >= 300) throw new HttpError(status);
}

function networkError(): NetworkError {
  return new NetworkError('无法连接云端，请检查网络后重试');
}

function request(
  path: string, method: 'POST' | 'GET' | 'DELETE', token?: string, data?: Record<string, string>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: apiBaseUrl + path,
      method,
      data,
      timeout: REQUEST_TIMEOUT,
      header: token ? { Authorization: 'Bearer ' + token } : { 'Content-Type': 'application/json' },
      success: ({ statusCode, data: response }) => {
        try {
          requireSuccess(statusCode);
          resolve(response);
        } catch (error) {
          reject(error);
        }
      },
      fail: () => reject(networkError()),
    });
  });
}

async function login(): Promise<Session> {
  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      timeout: REQUEST_TIMEOUT,
      success: (result) => result.code ? resolve(result.code) : reject(new Error('无法取得微信登录凭证')),
      fail: () => reject(networkError()),
    });
  });
  const data = responseObject(await request('/v1/auth/wechat', 'POST', undefined, { code }));
  const { accessToken, expiresIn } = data;
  if (typeof accessToken !== 'string' || !accessToken
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('无法建立云端会话');
  }
  return { token: accessToken, validUntil: Date.now() + Math.max(0, expiresIn - 30) * 1000 };
}

async function getSession(): Promise<Session> {
  if (session && Date.now() < session.validUntil) return session;
  if (!pendingLogin) {
    pendingLogin = login().then((result) => (session = result)).finally(() => {
      pendingLogin = undefined;
    });
  }
  return pendingLogin;
}

async function authorized<T>(action: (token: string) => Promise<T>): Promise<T> {
  const current = await getSession();
  try {
    return await action(current.token);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    if (session === current) session = undefined;
    return action((await getSession()).token);
  }
}

function jobFromResponse(raw: unknown): CloudJob {
  const data = responseObject(raw);
  const { jobId, status, error } = data;
  if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId)
      || (status !== 'queued' && status !== 'running' && status !== 'succeeded' && status !== 'failed')) {
    throw new Error('无法读取云端任务状态');
  }
  const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return { jobId, status, errorCode: typeof errorCode === 'string' ? errorCode : undefined };
}

function upload(options: EnhancementOptions, clientRequestId: string, token: string): Promise<CloudJob> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: apiBaseUrl + '/v1/jobs',
      filePath: options.imagePath,
      name: 'file',
      formData: { operation: options.operation, clientRequestId },
      header: { Authorization: 'Bearer ' + token },
      timeout: UPLOAD_TIMEOUT,
      success: ({ statusCode, data }) => {
        try {
          requireSuccess(statusCode);
          resolve(jobFromResponse(data));
        } catch (error) {
          reject(error);
        }
      },
      fail: () => reject(networkError()),
    });
  });
}

function removeTemporaryFile(filePath: string | undefined): void {
  if (filePath) wx.getFileSystemManager().unlink({ filePath, fail: () => undefined });
}

function download(path: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: apiBaseUrl + path + '/result',
      header: { Authorization: 'Bearer ' + token },
      timeout: UPLOAD_TIMEOUT,
      success: ({ statusCode, tempFilePath }) => {
        try {
          requireSuccess(statusCode);
          if (!tempFilePath) throw new Error('云端未返回图片');
          resolve(tempFilePath);
        } catch (error) {
          removeTemporaryFile(tempFilePath);
          reject(error);
        }
      },
      fail: () => reject(networkError()),
    });
  });
}

function failureMessage(code: string | undefined): string {
  return ({
    unsupported_page: '这页缺少可用于弯曲矫正的清晰文字行',
    invalid_image: '云端无法读取这张图片',
    processing_timeout: '云端处理超时，请稍后重试',
    queue_timeout: '云端排队超时，请稍后重试',
  } as Record<string, string>)[code ?? ''] ?? '云端处理失败，请稍后重试';
}

export async function runCloudEnhancement(options: EnhancementOptions): Promise<{ imagePath: string }> {
  if (!cloudEnabled) throw new Error('云端处理尚未配置');
  const deadline = Date.now() + TASK_TIMEOUT;
  const requestId = `${Date.now().toString(36)}-${(requestSequence++).toString(36)}-${Math.random().toString(36).slice(2)}`;

  function checkActive(): void {
    if (options.isCancelled?.()) throw new Error('已取消云端处理');
    if (Date.now() >= deadline) throw new Error('等待云端处理超时，请稍后重试');
  }

  let path: string | undefined;
  try {
    checkActive();
    const submit = (token: string) => upload(options, requestId, token);
    let job: CloudJob;
    try {
      job = await authorized(submit);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      checkActive();
      // A response may have been lost after the server accepted the image.
      job = await authorized(submit);
    }
    path = '/v1/jobs/' + job.jobId;
    const jobPath = path;
    for (;;) {
      checkActive();
      options.onStatus?.(job.status);
      if (job.status === 'failed') throw new Error(failureMessage(job.errorCode));
      if (job.status === 'succeeded') {
        const imagePath = await authorized((token) => download(jobPath, token));
        try {
          checkActive();
          return { imagePath };
        } catch (error) {
          removeTemporaryFile(imagePath);
          throw error;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL));
      checkActive();
      job = jobFromResponse(await authorized((token) => request(jobPath, 'GET', token)));
    }
  } finally {
    // Expiry also clears the server when the connection is unavailable.
    if (path && session) void request(path, 'DELETE', session.token).catch(() => undefined);
  }
}
