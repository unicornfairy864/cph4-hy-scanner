import { decorateImage, renderPage } from '../../image'
import { runCloudEnhancement, runSmartDocument, smartEnabled } from '../../services/cloud'
import type { CloudStatus, SmartDocument } from '../../services/cloud'
import { writeScanPdf } from '../../services/pdf'
import type { ExportPage } from '../export/session'
import { loadArchive, MAX_ARCHIVED_QUESTIONS, mergeArchive, persistArchive } from './archive'
import type { WrongQuestion } from './archive'
import { createWrongQuestionsPdf } from './print'

type TextOperation = 'exam' | 'receipt' | 'identity'
type ImageOperation = 'exam_restore' | 'clarify'
type Operation = TextOperation | ImageOperation
type ReviewItem = SmartDocument['items'][number] & { position: number; selected: boolean }
type ReviewField = SmartDocument['fields'][number] & { position: number }
type DocumentResult = Omit<SmartDocument, 'items' | 'fields'> & { fields: ReviewField[] }

interface SmartSession {
  page: ExportPage
  number: number
}

const tools: Array<{ operation: Operation; title: string; detail: string; image: boolean }> = [
  { operation: 'exam', title: '识别错题', detail: '从当前页提取题目、作答和可辨认的批改依据。核对后可收录错题。', image: false },
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
  tab: 'tools' | 'archive'
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
  selectedCount: number
  image: string
  comparisonSource: string
  compare: 'result' | 'source'
  archived: WrongQuestion[]
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
  previousPdf?: string
  onLoad(query?: Record<string, string | undefined>): void
  onShow(): void
  onUnload(): void
  preparePreview(session: SmartSession): Promise<void>
  selectTab(event: WechatMiniprogram.TouchEvent): void
  selectTool(event: WechatMiniprogram.TouchEvent): void
  selectCompare(event: WechatMiniprogram.TouchEvent): void
  requestProcessing(): void
  process(session: SmartSession, tool: typeof tools[number]): Promise<void>
  cancelProcessing(): void
  clearResult(): void
  copyFields(): void
  selectReviewItem(event: WechatMiniprogram.TouchEvent): void
  archiveSelected(): void
  removeArchived(event: WechatMiniprogram.TouchEvent): void
  printArchive(): Promise<void>
  saveResult(): Promise<void>
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
    enabled: smartEnabled, tools, tab: 'tools', pageNumber: 0, protectedPage: false,
    source: '', sourcePending: false, sourceError: '', selectedTool: 0, busy: '', running: false,
    message: '', document: null, items: [], selectedCount: 0, image: '', comparisonSource: '', compare: 'result', archived: [],
  },
  closed: false,
  turn: 0,
  confirming: false,

  onLoad(query) {
    if (query?.archive === '1') this.setData({ tab: 'archive' })
    this.getOpenerEventChannel?.()?.on?.('smartPage', (session: SmartSession) => {
      if (this.closed || this.session || !session?.page?.imagePath || !Number.isInteger(session.number) || session.number < 1) return
      this.session = session
      this.setData({ pageNumber: session.number, protectedPage: hasDecorations(session.page) })
      void this.preparePreview(session)
    })
  },

  onShow() {
    try {
      this.setData({ archived: loadArchive() })
    } catch {
      wx.showToast({ title: '无法读取此设备上的错题归档。', icon: 'none' })
    }
  },

  onUnload() {
    this.closed = true
    this.turn += 1
    unlink(this.previewPath)
    unlink(this.comparisonPath)
    if (this.resultPath !== this.savingPath) unlink(this.resultPath)
    unlink(this.previousPdf)
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

  selectTab(event) {
    const tab: unknown = event.currentTarget.dataset.tab
    if (!this.data.busy && (tab === 'tools' || tab === 'archive')) this.setData({ tab })
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
    const destination = tool.image ? '本项目的 VPS' : '本项目的 VPS，再交给已配置的多模态识别服务'
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
          items: items.map((item, position) => ({ ...item, position, selected: false })),
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
    this.setData({ document: null, items: [], selectedCount: 0, image: '', comparisonSource: '', compare: 'result', message: '' })
  },

  copyFields() {
    const fields = this.data.document?.fields
    if (!fields?.length) return
    const data = fields.map(({ label, value, uncertain }) => `${label}：${value || '未识别'}${uncertain ? '（存疑）' : ''}`).join('\n')
    wx.setClipboardData({ data, fail: () => wx.showToast({ title: '复制失败，请重试。', icon: 'none' }) })
  },

  selectReviewItem(event) {
    const index = Number(event.currentTarget.dataset.index)
    const item = this.data.items[index]
    if (!item?.question.trim() || item.status === 'correct' || this.data.busy) return
    const toggle = () => {
      if (this.closed || this.data.items[index] !== item) return
      const items = this.data.items.map((entry, position) => position === index ? { ...entry, selected: !entry.selected } : entry)
      const selectedCount = items.filter(({ selected }) => selected).length
      this.setData({ items, selectedCount })
    }
    if (item.status !== 'uncertain' || item.selected) toggle()
    else wx.showModal({
      title: '人工确认错题',
      content: '此题的批改结果存疑。仅在核对原卷并确认答错后收录。',
      confirmText: '确认错题',
      success: ({ confirm }) => { if (confirm) toggle() },
    })
  },

  archiveSelected() {
    if (this.data.busy || !this.data.selectedCount) return
    const title = this.data.document?.title.trim()
    const source = title ? `${title} · 第 ${this.data.pageNumber} 页` : `扫描第 ${this.data.pageNumber} 页`
    try {
      const current = loadArchive()
      const submitted = this.data.items.filter(({ selected }) => selected)
        .map(({ question, number, studentAnswer, referenceAnswer, correction, evidence }) => (
          { source, question, number, studentAnswer, referenceAnswer, correction, evidence }
        ))
      const result = mergeArchive(current, submitted)
      if (result.added) {
        persistArchive(result.entries)
        const items = this.data.items.map((item) => ({ ...item, selected: false }))
        this.setData({ archived: result.entries, items, selectedCount: 0 })
      }
      wx.showToast({
        title: result.added
          ? (result.entries.length === MAX_ARCHIVED_QUESTIONS
            ? `已收录 ${result.added} 题，归档已满`
            : `已收录 ${result.added} 道错题`)
          : (current.length >= MAX_ARCHIVED_QUESTIONS ? '归档已满，请先移除旧错题。' : '所选错题已收录。'),
        icon: 'none',
      })
    } catch {
      wx.showToast({ title: '无法保存到本机错题归档。', icon: 'none' })
    }
  },

  removeArchived(event) {
    const id: unknown = event.currentTarget.dataset.id
    if (typeof id !== 'string' || this.data.busy) return
    wx.showModal({
      title: '移除这道错题？',
      confirmText: '移除',
      success: ({ confirm }) => {
        if (!confirm || this.closed || this.data.busy) return
        try {
          const archived = loadArchive().filter((item) => item.id !== id)
          persistArchive(archived)
          this.setData({ archived })
        } catch {
          wx.showToast({ title: '无法更新错题归档。', icon: 'none' })
        }
      },
    })
  },

  async printArchive() {
    if (!this.data.archived.length || this.data.busy) return
    const archived = this.data.archived
    this.setData({ busy: '正在生成错题 PDF' })
    const stamp = Date.now()
    const filePath = `${wx.env.USER_DATA_PATH}/错题整理-${stamp}.pdf`
    try {
      const bytes = await createWrongQuestionsPdf(archived, () => this.closed)
      if (this.closed) return
      await writeScanPdf(filePath, bytes)
      if (this.closed) {
        unlink(filePath)
        return
      }
      await new Promise<void>((resolve, reject) => {
        wx.openDocument({ filePath, fileType: 'pdf', showMenu: true, success: () => resolve(), fail: reject })
      })
      if (this.closed) unlink(filePath)
      else {
        unlink(this.previousPdf)
        this.previousPdf = filePath
      }
    } catch (error) {
      unlink(filePath)
      if (!this.closed) wx.showToast({ title: describe(error, '无法导出错题 PDF。'), icon: 'none' })
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
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

  adoptResult() {
    const imagePath = this.resultPath
    if (!imagePath || this.data.protectedPage || this.data.busy) return
    const channel = this.getOpenerEventChannel?.()
    let adopted = false
    const accept = (result: { imagePath: string }) => { adopted = result.imagePath === imagePath }
    channel?.on?.('smartAdopted', accept)
    channel?.emit?.('smartAdopt', { imagePath })
    channel?.off?.('smartAdopted', accept)
    if (!adopted) {
      wx.showToast({ title: '无法应用到原扫描页。可另存图片。', icon: 'none' })
      return
    }
    this.resultPath = undefined
    this.setData({ image: '' })
    wx.navigateBack()
  },
})
