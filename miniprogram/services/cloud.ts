declare const SCANNER_API_BASE_URL: string;

export type CloudOperation = 'dewarp' | 'deshadow' | 'clarify' | 'exam_restore';
export type SmartOperation = 'receipt' | 'identity' | 'exam';
export type ExamStatus = 'correct' | 'incorrect' | 'uncertain';

export interface SmartField {
  label: string;
  value: string;
  uncertain: boolean;
}

export interface ExamItem {
  number: string;
  question: string;
  studentAnswer: string;
  referenceAnswer: string;
  correction: string;
  evidence: string;
  status: ExamStatus;
}

export interface SmartDocument {
  operation: SmartOperation;
  title: string;
  fields: SmartField[];
  items: ExamItem[];
  warnings: string[];
}
export type CloudStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface OcrLine {
  text: string;
  box: [number, number, number, number];
}

export interface OcrResult {
  text: string;
  width: number;
  height: number;
  lines: OcrLine[];
}

export type ExamInkBox = [number, number, number, number];
export type ExamInkPoint = [number, number];

export interface ExamInkCandidate {
  box: ExamInkBox;
  review: boolean;
}

export interface ExamInkCandidatesResult {
  width: number;
  height: number;
  candidates: ExamInkCandidate[];
}

export interface ExamInkStroke {
  points: ExamInkPoint[];
  radius: number;
}

export interface ExamInkPlan {
  regions: ExamInkBox[];
  erase: ExamInkStroke[];
  protect: ExamInkStroke[];
}

type JobOperation = CloudOperation | SmartOperation | 'ocr' | 'exam_ink_candidates' | 'exam_ink_ai_candidates' | 'exam_ink_apply' | 'pdf_page_preview';

interface JobPayload {
  operation: JobOperation;
  plan?: string;
  pageNumber?: string;
}

interface CloudJob {
  jobId: string;
  status: CloudStatus;
  errorCode?: string;
}

interface CloudTaskCallbacks {
  onStatus?(status: CloudStatus): void;
  isCancelled?(): boolean;
}

interface CloudTaskOptions extends CloudTaskCallbacks {
  imagePath: string;
}

interface EnhancementOptions extends CloudTaskOptions {
  operation: CloudOperation;
}

interface SmartOptions extends CloudTaskOptions {
  operation: SmartOperation;
}

interface ExamInkCandidatesOptions extends CloudTaskOptions {
  ai?: boolean;
}

interface ExamInkApplyOptions extends CloudTaskOptions {
  plan: ExamInkPlan;
}

interface PdfPreviewOptions extends CloudTaskCallbacks {
  filePath: string;
  pageNumber: number;
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
export const smartEnabled = cloudEnabled;
export const maxCloudPdfPreviewBytes = 8 * 1024 * 1024;
export const maxCloudPdfPreviewPages = 50;

const REQUEST_TIMEOUT = 8000;
const UPLOAD_TIMEOUT = 25000;
const TASK_TIMEOUT = 85000;
const POLL_INTERVAL = 1000;
const submissionFailureCodes = new Set([
  'smart_unavailable', 'exam_ink_ai_unavailable', 'invalid_exam_ink_plan',
  'pdf_preview_unavailable', 'invalid_pdf', 'pdf_page_out_of_range',
]);

let session: Session | undefined;
let pendingLogin: Promise<Session> | undefined;
let requestSequence = 0;

class NetworkError extends Error {}

class HttpError extends Error {
  constructor(readonly status: number, code?: string) {
    super(code && submissionFailureCodes.has(code) ? failureMessage(code) : ({
      401: '微信登录失效，请重新尝试',
      404: '云端任务已过期，请重新提交',
      409: '云端任务状态已变化，请重新尝试',
      413: '该文件超过云端处理大小限制',
      422: '云端无法读取该文件',
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

function requireSuccess(status: number, raw?: unknown): void {
  if (status >= 200 && status < 300) return;
  let code: string | undefined;
  if ((status === 422 || status === 503) && raw !== undefined) {
    try {
      const detail = responseObject(responseObject(raw).detail);
      if (typeof detail.code === 'string') code = detail.code;
    } catch {
      // Some servers return an ordinary text or HTML service-unavailable response.
    }
  }
  throw new HttpError(status, code);
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
          requireSuccess(statusCode, response);
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

function upload(filePath: string, payload: JobPayload, clientRequestId: string, token: string): Promise<CloudJob> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: apiBaseUrl + '/v1/jobs',
      filePath,
      name: 'file',
      formData: { ...payload, clientRequestId },
      header: { Authorization: 'Bearer ' + token },
      timeout: UPLOAD_TIMEOUT,
      success: ({ statusCode, data }) => {
        try {
          requireSuccess(statusCode, data);
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
    ocr_unavailable: '云端文字识别暂不可用，请稍后重试',
    smart_unavailable: '云端尚未配置智能识别服务',
    smart_provider_error: '智能识别服务暂未返回可用结果，请稍后重试或缩小识别范围',
    exam_ink_ai_unavailable: 'DeepSeek 提示尚未配置，可用云端提示或手动画笔',
    exam_ink_provider_error: 'DeepSeek 暂未返回结果，可用云端提示或手动画笔',
    invalid_exam_ink_plan: '去笔迹范围或画笔数据无效，请重新调整',
    pdf_preview_unavailable: '云端 PDF 预览暂不可用，仍可生成签名文件',
    invalid_pdf: '云端无法读取该 PDF',
    pdf_page_out_of_range: '该页超出云端 PDF 预览范围',
    invalid_image: '云端无法读取这张图片',
    processing_timeout: '云端处理超时，请稍后重试',
    queue_timeout: '云端排队超时，请稍后重试',
  } as Record<string, string>)[code ?? ''] ?? '云端处理失败，请稍后重试';
}

function ocrResultFromResponse(raw: unknown): OcrResult {
  const { text, width, height, lines } = responseObject(raw);
  if (typeof text !== 'string' || typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1
      || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1 || !Array.isArray(lines)) {
    throw new Error('无法读取云端文字识别结果');
  }
  return {
    text, width, height, lines: lines.map((line): OcrLine => {
      const { text, box } = responseObject(line);
      if (typeof text !== 'string' || !Array.isArray(box) || box.length !== 4
          || !box.every((coordinate) => Number.isSafeInteger(coordinate))) {
        throw new Error('无法读取云端文字识别结果');
      }
      const [x, y, lineWidth, lineHeight] = box;
      if (x < 0 || y < 0 || lineWidth < 1 || lineHeight < 1 || x + lineWidth > width || y + lineHeight > height) {
        throw new Error('无法读取云端文字识别结果');
      }
      return { text, box: [x, y, lineWidth, lineHeight] };
    }),
  };
}

async function runCloudJob<T>(
  options: CloudTaskOptions,
  payload: JobPayload,
  readResult: (jobPath: string, token: string) => Promise<T>,
  disposeResult?: (result: T) => void,
): Promise<T> {
  if (!cloudEnabled) throw new Error('云端处理尚未配置');
  const deadline = Date.now() + TASK_TIMEOUT;
  const requestId = `${Date.now().toString(36)}-${(requestSequence++).toString(36)}-${Math.random().toString(36).slice(2)}`;

  function checkActive(): void {
    if (options.isCancelled?.()) throw new Error('已取消云端处理');
    if (Date.now() >= deadline) throw new Error('等待云端处理超时，请稍后重试');
  }

  function activeRequest<ResponseData>(action: (token: string) => Promise<ResponseData>): Promise<ResponseData> {
    checkActive();
    return authorized((token) => {
      checkActive();
      return action(token);
    });
  }

  let path: string | undefined;
  try {
    checkActive();
    const submit = (token: string) => upload(options.imagePath, payload, requestId, token);
    let job: CloudJob;
    try {
      job = await activeRequest(submit);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      checkActive();
      // A response may have been lost after the server accepted the image.
      job = await activeRequest(submit);
    }
    path = '/v1/jobs/' + job.jobId;
    const jobPath = path;
    for (;;) {
      checkActive();
      options.onStatus?.(job.status);
      if (job.status === 'failed') throw new Error(failureMessage(job.errorCode));
      if (job.status === 'succeeded') {
        const result = await activeRequest((token) => readResult(jobPath, token));
        try {
          checkActive();
          return result;
        } catch (error) {
          disposeResult?.(result);
          throw error;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL));
      checkActive();
      const response = await activeRequest((token) => request(jobPath, 'GET', token));
      checkActive();
      job = jobFromResponse(response);
    }
  } catch (error) {
    checkActive();
    throw error;
  } finally {
    // Expiry also clears the server when the connection is unavailable.
    if (path && session) void request(path, 'DELETE', session.token).catch(() => undefined);
  }
}

export async function runCloudEnhancement(options: EnhancementOptions): Promise<{ imagePath: string }> {
  return { imagePath: await runCloudJob(options, { operation: options.operation }, download, removeTemporaryFile) };
}

export async function runCloudPdfPreview({ filePath, pageNumber, ...callbacks }: PdfPreviewOptions): Promise<{ imagePath: string }> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > maxCloudPdfPreviewPages) {
    throw new Error(`云端 PDF 预览支持第 1 至 ${maxCloudPdfPreviewPages} 页`);
  }
  const payload: JobPayload = { operation: 'pdf_page_preview', pageNumber: String(pageNumber) };
  const imagePath = await runCloudJob({ imagePath: filePath, ...callbacks }, payload, download, removeTemporaryFile);
  return { imagePath };
}

export function runCloudOcr(options: CloudTaskOptions): Promise<OcrResult> {
  return runCloudJob(options, { operation: 'ocr' }, async (path, token) => (
    ocrResultFromResponse(await request(path + '/result', 'GET', token))
  ));
}

function smartDocumentFromResponse(raw: unknown, operation: SmartOperation): SmartDocument {
  const error = '无法读取智能文档识别结果';
  const data = responseObject(raw);
  if (data.operation !== operation || typeof data.title !== 'string'
      || !Array.isArray(data.fields) || !Array.isArray(data.items)
      || !Array.isArray(data.warnings) || !data.warnings.every((entry) => typeof entry === 'string')) {
    throw new Error(error);
  }

  const fields = data.fields.map((entry): SmartField => {
    const { label, value, uncertain } = responseObject(entry);
    if (typeof label !== 'string' || typeof value !== 'string' || typeof uncertain !== 'boolean') {
      throw new Error(error);
    }
    return { label, value, uncertain };
  });
  const items = data.items.map((entry): ExamItem => {
    const { number, question, studentAnswer, referenceAnswer, correction, evidence, status } = responseObject(entry);
    if (typeof number !== 'string' || typeof question !== 'string' || typeof studentAnswer !== 'string'
        || typeof referenceAnswer !== 'string' || typeof correction !== 'string' || typeof evidence !== 'string'
        || (status !== 'correct' && status !== 'incorrect' && status !== 'uncertain')) {
      throw new Error(error);
    }
    return { number, question, studentAnswer, referenceAnswer, correction, evidence, status };
  });
  return { operation, title: data.title, fields, items, warnings: data.warnings };
}

export function runSmartDocument(options: SmartOptions): Promise<SmartDocument> {
  return runCloudJob(options, { operation: options.operation }, async (path, token) => (
    smartDocumentFromResponse(await request(path + '/result', 'GET', token), options.operation)
  ));
}

function unitCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizedBox(raw: unknown, message: string): ExamInkBox {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(unitCoordinate)) throw new Error(message);
  const [x, y, width, height] = raw;
  if (x >= 1 || y >= 1 || width <= 0 || height <= 0 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) {
    throw new Error(message);
  }
  return [x, y, Math.min(width, 1 - x), Math.min(height, 1 - y)];
}

function examInkCandidatesFromResponse(raw: unknown): ExamInkCandidatesResult {
  const message = '无法读取试卷去笔迹候选';
  const { width, height, candidates } = responseObject(raw);
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0
      || typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0
      || !Array.isArray(candidates) || candidates.length > 64) {
    throw new Error(message);
  }
  return {
    width, height,
    candidates: candidates.map((entry): ExamInkCandidate => {
      const { box, review } = responseObject(entry);
      if (typeof review !== 'boolean') throw new Error(message);
      return { box: normalizedBox(box, message), review };
    }),
  };
}

function compactCoordinate(value: number): number {
  return Math.round(value * 100000) / 100000;
}

function serializeExamInkPlan(plan: ExamInkPlan): string {
  const message = failureMessage('invalid_exam_ink_plan');
  if (!plan) throw new Error(message);
  const { regions, erase, protect } = plan;
  if (!Array.isArray(regions) || regions.length > 64
      || !Array.isArray(erase) || erase.length > 48 || !Array.isArray(protect) || protect.length > 48) {
    throw new Error(message);
  }
  let pointCount = 0;
  function strokes(entries: ExamInkStroke[]): ExamInkStroke[] {
    return entries.map((stroke) => {
      if (!stroke || !Number.isFinite(stroke.radius) || stroke.radius <= 0 || stroke.radius > 0.1
          || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 128) {
        throw new Error(message);
      }
      pointCount += stroke.points.length;
      if (pointCount > 384) throw new Error(message);
      return {
        radius: Math.max(0.00001, compactCoordinate(stroke.radius)),
        points: stroke.points.map((point): ExamInkPoint => {
          if (!Array.isArray(point) || point.length !== 2 || !point.every(unitCoordinate)) throw new Error(message);
          return [compactCoordinate(point[0]), compactCoordinate(point[1])];
        }),
      };
    });
  }
  const compactRegions = regions.map((box): ExamInkBox => {
    const [x, y, width, height] = normalizedBox(box, message);
    const left = Math.min(0.99999, compactCoordinate(x));
    const top = Math.min(0.99999, compactCoordinate(y));
    return [
      left, top,
      Math.max(0.00001, compactCoordinate(compactCoordinate(x + width) - left)),
      Math.max(0.00001, compactCoordinate(compactCoordinate(y + height) - top)),
    ];
  });
  // Only numeric coordinates and protocol keys are serialized, so length is also its UTF-8 size.
  const json = JSON.stringify({ regions: compactRegions, erase: strokes(erase), protect: strokes(protect) });
  if (json.length > 12 * 1024) throw new Error(message);
  return json;
}

function requireExamInkCloud(): void {
  if (!cloudEnabled) throw new Error('云端擦除尚未配置，可先用马赛克遮盖笔迹');
}

export async function runExamInkCandidates(options: ExamInkCandidatesOptions): Promise<ExamInkCandidatesResult> {
  requireExamInkCloud();
  return runCloudJob(options, { operation: options.ai ? 'exam_ink_ai_candidates' : 'exam_ink_candidates' }, async (path, token) => (
    examInkCandidatesFromResponse(await request(path + '/result', 'GET', token))
  ));
}

export async function runExamInkApply(options: ExamInkApplyOptions): Promise<{ imagePath: string }> {
  requireExamInkCloud();
  const plan = serializeExamInkPlan(options.plan);
  return { imagePath: await runCloudJob(options, { operation: 'exam_ink_apply', plan }, download, removeTemporaryFile) };
}
