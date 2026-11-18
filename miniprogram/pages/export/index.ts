import { renderPage } from '../../image'
import { createScanPdf, readImageBytes, writeScanPdf } from '../../services/pdf'
import { exportQualities } from './session'
import type { PdfSession } from './session'

interface ExportData {
  selected: number
  pageCount: number
  scope: 'all' | 'current'
  filename: string
  qualities: typeof exportQualities
  quality: number
  busy: string
  preview: string
}

interface ExportActions {
  session?: PdfSession
  closed: boolean
  lastPdf?: string
  previews: Map<number, string>
  renderingPreviews: Set<number>
  onLoad(): void
  onUnload(): void
  setFilename(event: WechatMiniprogram.Input): void
  selectQuality(event: WechatMiniprogram.TouchEvent): void
  selectScope(event: WechatMiniprogram.TouchEvent): void
  changePage(event: WechatMiniprogram.TouchEvent): void
  showPreview(): Promise<void>
  savePdf(): Promise<void>
}

function cleanPdf(filePath: string): void {
  const dirPath = filePath.slice(0, filePath.lastIndexOf('/'))
  wx.getFileSystemManager().rmdir({ dirPath, recursive: true, fail: () => undefined })
}

function cleanImage(filePath: string): void {
  wx.getFileSystemManager().unlink({ filePath, fail: () => undefined })
}

function filename(input: string): string {
  const title = input.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 70)
  return title || `扫描文档-${new Date().toISOString().slice(0, 10)}`
}

Page<ExportData, ExportActions>({
  data: { selected: 0, pageCount: 0, scope: 'all', filename: '', qualities: exportQualities, quality: 0, busy: '', preview: '' },
  closed: false,
  previews: new Map(),
  renderingPreviews: new Set(),

  onLoad() {
    this.previews = new Map()
    this.renderingPreviews = new Set()
    this.getOpenerEventChannel?.()?.on('scanExport', (session: PdfSession) => {
      if (this.closed) return
      this.session = session
      this.setData({ selected: session.selected, pageCount: session.pages.length })
      void this.showPreview()
    })
  },

  onUnload() {
    this.closed = true
    if (this.lastPdf) cleanPdf(this.lastPdf)
    for (const path of this.previews.values()) cleanImage(path)
    this.previews.clear()
  },

  setFilename(event) {
    this.setData({ filename: event.detail.value })
  },

  selectQuality(event) {
    const quality = Number(event.currentTarget.dataset.index)
    if (exportQualities[quality] && !this.data.busy) this.setData({ quality })
  },

  selectScope(event) {
    const scope: unknown = event.currentTarget.dataset.scope
    if ((scope === 'all' || scope === 'current') && !this.data.busy) this.setData({ scope })
  },

  changePage(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if ((direction !== -1 && direction !== 1) || this.data.busy) return
    const selected = this.data.selected + direction
    if (!this.session?.pages[selected]) return
    this.setData({ selected })
    void this.showPreview()
  },

  async showPreview() {
    const selected = this.data.selected
    const page = this.session?.pages[selected]
    if (!page) return
    const ready = page.enhanced ?? page.preview ?? this.previews.get(selected)
    const preview = ready ?? page.imagePath
    if (this.data.preview !== preview) this.setData({ preview })
    if (ready || this.renderingPreviews.has(selected)) return
    this.renderingPreviews.add(selected)
    try {
      const result = await renderPage({ ...page, quality: 'preview' })
      if (this.closed) {
        cleanImage(result.imagePath)
        return
      }
      this.previews.set(selected, result.imagePath)
      if (this.data.selected === selected) this.setData({ preview: result.imagePath })
    } catch {
      // The source image stays visible if a local preview cannot be generated.
    } finally {
      this.renderingPreviews.delete(selected)
    }
  },

  async savePdf() {
    const session = this.session
    if (!session?.pages.length || this.data.busy) return
    const pages = this.data.scope === 'current' ? [session.pages[this.data.selected]] : session.pages
    const options = exportQualities[this.data.quality]
    const dirPath = `${wx.env.USER_DATA_PATH}/scan-exports/${Date.now()}`
    const filePath = `${dirPath}/${filename(this.data.filename)}.pdf`
    try {
      const bytes = await createScanPdf(pages.length, async (index) => {
        if (this.closed) throw new Error('本次导出已结束。')
        const { enhanced, ...page } = pages[index]
        this.setData({ busy: `正在生成 PDF · ${index + 1} / ${pages.length}` })
        if (enhanced) return readImageBytes(enhanced)
        const result = await renderPage({ ...page, ...options, quality: 'export' })
        try {
          return await readImageBytes(result.imagePath)
        } finally {
          cleanImage(result.imagePath)
        }
      })
      if (this.closed) return
      await new Promise<void>((resolve, reject) => {
        wx.getFileSystemManager().mkdir({ dirPath, recursive: true, success: () => resolve(), fail: reject })
      })
      await writeScanPdf(filePath, bytes)
      if (this.closed) {
        cleanPdf(filePath)
        return
      }
      await new Promise<void>((resolve, reject) => {
        wx.openDocument({ filePath, fileType: 'pdf', showMenu: true, success: () => resolve(), fail: reject })
      })
      if (this.closed) cleanPdf(filePath)
      else {
        if (this.lastPdf) cleanPdf(this.lastPdf)
        this.lastPdf = filePath
      }
    } catch (error) {
      cleanPdf(filePath)
      if (!this.closed) wx.showToast({
        title: error instanceof Error ? error.message : '无法导出 PDF，请选择标准清晰度后重试。',
        icon: 'none',
      })
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
  },
})
