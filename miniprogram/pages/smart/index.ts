import { decorateImage, renderPage } from '../../image'
import { runCloudEnhancement, runSmartDocument, smartEnabled } from '../../services/cloud'
import type { CloudStatus, SmartDocument } from '../../services/cloud'
import type { ExportPage } from '../export/session'

type TextOperation = 'exam' | 'receipt' | 'identity'
type ImageOperation = 'exam_restore' | 'clarify'
type Operation = TextOperation | ImageOperation
type ReviewItem = SmartDocument['items'][number] & { position: number }
type ReviewField = SmartDocument['fields'][number] & { position: number }
type DocumentResult = Omit<SmartDocument, 'items' | 'fields'> & { fields: ReviewField[] }

interface SmartSession {
  page: ExportPage
  number: number
}

const tools: Array<{ operation: Operation; title: string; detail: string; image: boolean }> = [
  { operation: 'exam', title: '识别错题', detail: '从当前页提取题目、作答和可辨认的批改依据，标出疑似错题。', image: false },
  { operation: 'exam_restore', title: '试卷擦除', detail: '减淡部分红蓝笔迹。被遮住的原字或同色印刷内容可能无法保留，请先对照原页。', image: true },
  { operation: 'receipt', title: '票据识别', detail: '提取票据名称、日期、金额等可辨认字段。请核对标为存疑的结果。', image: false },
  { operation: 'identity', title: '证件识别', detail: '提取证件类型与可辨认字段。请确认要上传的页面及其中的个人信息。', image: false },
  { operation: 'clarify', title: '模糊字迹修复', detail: '增强可辨认的笔画与边缘。严重失焦或缺失的细节可能无法恢复。', image: true },
]

const pendingText: Record<CloudStatus, string> = {
  queued: '已上传，正在排队',
  running: '正在处理当前页',
  succeeded: '正在读取处理结果',
  failed: '正在读取任务状态',
}

interface SmartData {
  enabled: boolean
  tools: typeof tools
  pageNumber: number
  protectedPage: boolean
  source: string
  sourcePending: boolean
  sourceError: string
  selectedTool: number
  busy: string
  running: boolean
  message: string
  document: DocumentResult | null
  items: ReviewItem[]
  image: string
  comparisonSource: string
  compare: 'result' | 'source'
}

interface SmartActions {
  session?: SmartSession
  closed: boolean
  turn: number
  confirming: boolean
  previewPath?: string
  resultPath?: string
  comparisonPath?: string
  savingPath?: string
  onLoad(): void
  onUnload(): void
  preparePreview(session: SmartSession): Promise<void>
  selectTool(event: WechatMiniprogram.TouchEvent): void
  selectCompare(event: WechatMiniprogram.TouchEvent): void
  requestProcessing(): void
  openExamInk(): Promise<void>
  process(session: SmartSession, tool: typeof tools[number]): Promise<void>
  cancelProcessing(): void
  clearResult(): void
  copyFields(): void
  saveResult(): Promise<void>
  transferImageToScan(imagePath: string): boolean
  adoptResult(): void
}

function unlink(filePath?: string): void {
  if (filePath) wx.getFileSystemManager().unlink({ filePath, fail: () => undefined })
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function hasDecorations(page: ExportPage): boolean {
  return Boolean(page.decorations?.mosaics?.length || page.decorations?.watermarks?.length)
}

function renderInput(page: ExportPage, quality: 'preview' | 'export'): Promise<{ imagePath: string }> {
  const options = quality === 'export' ? { maxDimension: 2400, jpegQuality: 0.9 } : {}
  if (!page.enhanced) return renderPage({ ...page, ...options, quality })
  return decorateImage({
    imagePath: page.enhanced,
    sharpen: page.sharpen,
    decorations: page.decorations,
    ...options,
    quality,
  })
}

function borrowEnhanced(page: ExportPage): string | undefined {
  if (hasDecorations(page) || (page.sharpen && page.sharpen !== 'off')) return undefined
  return page.enhanced
}

function textOperation(operation: Operation): operation is TextOperation {
  return operation === 'receipt' || operation === 'identity' || operation === 'exam'
}

function usesExamColor(operation: Operation): boolean {
  return operation === 'exam' || operation === 'exam_restore'
}

Page<SmartData, SmartActions>({
  data: {
    enabled: smartEnabled, tools, pageNumber: 0, protectedPage: false,
    source: '', sourcePending: false, sourceError: '', selectedTool: 0, busy: '', running: false,
    message: '', document: null, items: [], image: '', comparisonSource: '', compare: 'result',
  },
  closed: false,
  turn: 0,
  confirming: false,

  onLoad() {
    this.getOpenerEventChannel?.()?.on?.('smartPage', (session: SmartSession) => {
      if (this.closed || this.session || !session?.page?.imagePath || !Number.isInteger(session.number) || session.number < 1) return
      this.session = session
      this.setData({ pageNumber: session.number, protectedPage: hasDecorations(session.page) })
      void this.preparePreview(session)
    })
  },

  onUnload() {
    this.closed = true
    this.turn += 1
    unlink(this.previewPath)
    unlink(this.comparisonPath)
    if (this.resultPath !== this.savingPath) unlink(this.resultPath)
  },

  async preparePreview(session) {
    const enhanced = borrowEnhanced(session.page)
    if (enhanced) {
      this.setData({ source: enhanced })
      return
    }
    this.setData({ sourcePending: true })
    try {
      const { imagePath } = await renderInput(session.page, 'preview')
      if (this.closed) unlink(imagePath)
      else {
        this.previewPath = imagePath
        this.setData({ source: imagePath })
      }
    } catch (error) {
      if (!this.closed) this.setData({ sourceError: describe(error, '无法生成当前页预览。') })
    } finally {
      if (!this.closed) this.setData({ sourcePending: false })
    }
  },

  selectTool(event) {
    const selectedTool = Number(event.currentTarget.dataset.index)
    if (this.data.busy || this.confirming || !tools[selectedTool] || selectedTool === this.data.selectedTool) return
    this.clearResult()
    this.setData({ selectedTool })
  },

  selectCompare(event) {
    const compare: unknown = event.currentTarget.dataset.compare
    if (compare === 'source' || compare === 'result') this.setData({ compare })
  },

  requestProcessing() {
    const session = this.session
    const tool = tools[this.data.selectedTool]
    if (!session || !tool || !smartEnabled || this.data.busy || this.confirming || this.closed) return
    this.confirming = true
    const preparation = usesExamColor(tool.operation) && !session.page.enhanced
      ? '按当前裁切、旋转和保护编辑生成原色图，保留红蓝批改痕迹。' : ''
    const destination = tool.image ? '本项目的云端服务' : '本项目的云端服务，再交给已配置的多模态识别服务'
    wx.showModal({
      title: tool.title,
      content: `${preparation}仅将第 ${session.number} 页上传至${destination}。请确认可上传该页内容。`,
      confirmText: '上传处理',
      success: ({ confirm }) => {
        if (confirm && !this.closed && this.session === session && !this.data.busy) void this.process(session, tool)
      },
      complete: () => { this.confirming = false },
    })
  },

  async openExamInk() {
    const session = this.session
    const tool = tools[this.data.selectedTool]
    if (!session || tool?.operation !== 'exam_restore' || !smartEnabled || this.data.busy || this.confirming || this.closed) return
    this.setData({ busy: '正在准备黑笔编辑', message: '' })
    let generated: string | undefined
    try {
      // Use one owned raster for both marking and the confirmed upload, including any active marks.
      const page = { ...session.page, mode: 'color' as const, denoise: false }
      const { imagePath } = await renderInput(page, 'export')
      generated = imagePath
      if (this.closed || this.session !== session) return
      const canAdopt = !hasDecorations(page)
      await new Promise<void>((resolve, reject) => {
        wx.navigateTo({
          url: '/pages/exam-ink/index',
          success: ({ eventChannel }) => {
            if (this.closed || this.session !== session) {
              reject(new Error('当前扫描页已关闭。'))
              return
            }
            eventChannel.on?.('examInkAdopt', (result: { imagePath: string }) => {
              if (this.closed || this.session !== session || !canAdopt || typeof result?.imagePath !== 'string' || !result.imagePath) return
              if (this.transferImageToScan(result.imagePath)) eventChannel.emit('examInkAdopted', { imagePath: result.imagePath })
            })
            eventChannel.emit('examInkStart', { imagePath, temporary: true, canAdopt, number: session.number })
            resolve()
          },
          fail: reject,
        })
      })
      generated = undefined
    } catch (error) {
      if (!this.closed) this.setData({ message: describe(error, '无法打开黑笔编辑，请重试。') })
    } finally {
      unlink(generated)
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  async process(session, tool) {
    const turn = ++this.turn
    const isCancelled = () => this.closed || turn !== this.turn
    this.clearResult()
    this.setData({ busy: '正在准备当前页', running: true })
    let generated: string | undefined
    try {
      const page = usesExamColor(tool.operation)
        ? { ...session.page, mode: 'color' as const, denoise: false }
        : session.page
      let imagePath = borrowEnhanced(page)
      if (!imagePath) {
        const prepared = await renderInput(page, 'export')
        generated = prepared.imagePath
        imagePath = generated
      }
      if (isCancelled()) return
      this.setData({ busy: '正在上传当前页' })
      const onStatus = (status: CloudStatus) => {
        if (!isCancelled()) this.setData({ busy: pendingText[status] })
      }
      if (textOperation(tool.operation)) {
        const { fields, items, ...result } = await runSmartDocument({ imagePath, operation: tool.operation, isCancelled, onStatus })
        if (isCancelled()) return
        const message = fields.length || items.length ? '' : '没有识别到可用结果。请检查页面方向和清晰度。'
        this.setData({
          document: { ...result, fields: fields.map((field, position) => ({ ...field, position })) },
          items: items.map((item, position) => ({ ...item, position })),
          message,
        })
      } else {
        const result = await runCloudEnhancement({ imagePath, operation: tool.operation, isCancelled, onStatus })
        if (isCancelled()) unlink(result.imagePath)
        else {
          this.resultPath = result.imagePath
          this.comparisonPath = generated
          generated = undefined
          this.setData({ image: result.imagePath, comparisonSource: imagePath, compare: 'result' })
        }
      }
    } catch (error) {
      if (!isCancelled()) this.setData({ message: describe(error, '处理失败，请重试。') })
    } finally {
      unlink(generated)
      if (!isCancelled()) this.setData({ busy: '', running: false })
    }
  },

  cancelProcessing() {
    if (!this.data.running) return
    this.turn += 1
    this.setData({ busy: '', running: false, message: '已取消本次处理。' })
  },

  clearResult() {
    unlink(this.resultPath)
    unlink(this.comparisonPath)
    this.resultPath = undefined
    this.comparisonPath = undefined
    this.setData({ document: null, items: [], image: '', comparisonSource: '', compare: 'result', message: '' })
  },

  copyFields() {
    const fields = this.data.document?.fields
    if (!fields?.length) return
    const data = fields.map(({ label, value, uncertain }) => `${label}：${value || '未识别'}${uncertain ? '（存疑）' : ''}`).join('\n')
    wx.setClipboardData({ data, fail: () => wx.showToast({ title: '复制失败，请重试。', icon: 'none' }) })
  },

  async saveResult() {
    const filePath = this.resultPath
    if (!filePath || this.data.busy) return
    this.savingPath = filePath
    this.setData({ busy: '正在保存图片' })
    try {
      await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({
        filePath, success: () => resolve(), fail: reject,
      }))
      if (!this.closed) wx.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      if (!this.closed) wx.showToast({ title: '保存失败，请检查相册权限。', icon: 'none' })
    } finally {
      this.savingPath = undefined
      if (this.closed) unlink(filePath)
      else this.setData({ busy: '' })
    }
  },

  transferImageToScan(imagePath) {
    const channel = this.getOpenerEventChannel?.()
    let adopted = false
    const accept = (result: { imagePath: string }) => { adopted = result.imagePath === imagePath }
    channel?.on?.('smartAdopted', accept)
    channel?.emit?.('smartAdopt', { imagePath })
    channel?.off?.('smartAdopted', accept)
    return adopted
  },

  adoptResult() {
    const imagePath = this.resultPath
    if (!imagePath || this.data.protectedPage || this.data.busy) return
    if (!this.transferImageToScan(imagePath)) {
      wx.showToast({ title: '无法应用到原扫描页。可另存图片。', icon: 'none' })
      return
    }
    this.resultPath = undefined
    this.setData({ image: '' })
    wx.navigateBack()
  },
})
