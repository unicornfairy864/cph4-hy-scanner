import { decorateImage, renderPage } from '../../image'
import { createScanPdf, fitRectangle, normalizeSignature, readImageBytes, scanPdfLayout, signatureRectangle, writeScanPdf } from '../../services/pdf'
import type { PageSignature } from '../../services/pdf'
import type { Rotation } from '../../image'
import { fitRotatedImageStyle } from '../scan/geometry'
import { exportQualities } from './session'
import type { ExportPage, PdfSession, PreviewImage } from './session'
import { drawInkPoint, pointInPad, setupInkPad, signatureOverlay } from './signature'
import type { InkCanvas, InkPad, SignaturePoint } from './signature'

interface ExportData {
  selected: number
  pageCount: number
  scope: 'all' | 'current'
  filename: string
  qualities: typeof exportQualities
  quality: number
  busy: string
  preview: string
  previewStyle: string
  sheetStyle: string
  previewMessage: string
  previewFailed: boolean
  signatureStyle: string
  signatureSegments: ReturnType<typeof signatureOverlay>['segments']
  inkOpen: boolean
  hasInk: boolean
}

interface SheetSize {
  width: number
  height: number
}

interface SignatureDrag {
  id: number
  start: SignaturePoint
  center: SignaturePoint
}

type Touch = WechatMiniprogram.TouchEvent['touches'][number]

interface ExportActions {
  session?: PdfSession
  closed: boolean
  lastPdf?: string
  previews: Map<number, PreviewImage>
  ownedPreviews: Set<string>
  renderingPreviews: Set<number>
  signatures: Map<number, PageSignature>
  sheet?: SheetSize
  signatureDrag?: SignatureDrag
  inkPad?: InkPad
  inkRequest?: symbol
  inkPointer?: number
  draftInk: SignaturePoint[][]
  sampledPoints: number
  frameWidth: number
  frameHeight: number
  onLoad(): void
  onUnload(): void
  setFilename(event: WechatMiniprogram.Input): void
  selectQuality(event: WechatMiniprogram.TouchEvent): void
  selectScope(event: WechatMiniprogram.TouchEvent): void
  changePage(event: WechatMiniprogram.TouchEvent): void
  showPreview(): Promise<void>
  presentPreview(preview: PreviewImage): void
  syncSignature(): void
  openInk(): void
  clearInk(): void
  closeInk(): void
  startInk(event: WechatMiniprogram.TouchEvent): void
  moveInk(event: WechatMiniprogram.TouchEvent): void
  endInk(): void
  applyInk(): void
  removeSignature(): void
  reuseSignature(): void
  startSignatureDrag(event: WechatMiniprogram.TouchEvent): void
  moveSignatureDrag(event: WechatMiniprogram.TouchEvent): void
  endSignatureDrag(): void
  savePdf(): Promise<void>
}

const maxInkPoints = 800

function pageEdits(page: ExportPage): boolean {
  return Boolean(page.decorations?.mosaics?.length || page.decorations?.watermarks?.length || (page.sharpen && page.sharpen !== 'off'))
}

function imageSize(imagePath: string): Promise<SheetSize> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: imagePath, success: ({ width, height }) => resolve({ width, height }), fail: reject })
  })
}

function renderRaster(page: ExportPage, quality: 'preview' | 'export', options?: typeof exportQualities[number]) {
  if (page.enhanced) return decorateImage({
    imagePath: page.enhanced, decorations: page.decorations ?? {}, sharpen: page.sharpen, ...options, quality,
  })
  return renderPage({ ...page, ...options, quality })
}

function touchPosition(touch: Touch): SignaturePoint {
  return { x: touch.clientX, y: touch.clientY }
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
  data: {
    selected: 0, pageCount: 0, scope: 'all', filename: '', qualities: exportQualities, quality: 0, busy: '',
    preview: '', previewStyle: '', sheetStyle: '', previewMessage: '', previewFailed: false,
    signatureStyle: '', signatureSegments: [], inkOpen: false, hasInk: false,
  },
  closed: false,
  previews: new Map(),
  ownedPreviews: new Set(),
  renderingPreviews: new Set(),
  signatures: new Map(),
  draftInk: [],
  sampledPoints: 0,
  frameWidth: 0,
  frameHeight: 0,

  onLoad() {
    this.previews = new Map()
    this.ownedPreviews = new Set()
    this.renderingPreviews = new Set()
    this.signatures = new Map()
    const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const rpx = window.windowWidth / 750
    this.frameWidth = window.windowWidth - 122 * rpx
    this.frameHeight = Math.min(window.windowHeight * 0.44, 860 * rpx)
    this.getOpenerEventChannel?.()?.on?.('scanExport', (session: PdfSession) => {
      if (this.closed) return
      this.session = session
      this.setData({ selected: session.selected, pageCount: session.pages.length })
      void this.showPreview()
    })
  },

  onUnload() {
    this.closed = true
    if (this.lastPdf) cleanPdf(this.lastPdf)
    for (const path of this.ownedPreviews) cleanImage(path)
    this.ownedPreviews.clear()
    this.previews.clear()
    this.signatures.clear()
    this.draftInk = []
    this.inkPad = undefined
    this.signatureDrag = undefined
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
    if ((direction !== -1 && direction !== 1) || this.data.busy || this.data.inkOpen) return
    const selected = this.data.selected + direction
    if (!this.session?.pages[selected]) return
    this.signatureDrag = undefined
    this.setData({ selected, preview: '', sheetStyle: '', signatureStyle: '', signatureSegments: [] })
    void this.showPreview()
  },

  async showPreview() {
    const selected = this.data.selected
    const page = this.session?.pages[selected]
    if (!page) return
    const ready = this.previews.get(selected) ?? (page.enhanced ? undefined : page.preview)
    if (ready) {
      this.presentPreview(ready)
      return
    }
    if (this.renderingPreviews.has(selected)) return
    this.sheet = undefined
    this.setData({ previewMessage: '正在生成页面预览', previewFailed: false })
    this.renderingPreviews.add(selected)
    try {
      const borrowed = page.enhanced && !pageEdits(page)
      const result = borrowed && page.enhanced
        ? { imagePath: page.enhanced, ...await imageSize(page.enhanced) }
        : await renderRaster(page, 'preview')
      if (this.closed) {
        if (!borrowed) cleanImage(result.imagePath)
        return
      }
      if (!borrowed) this.ownedPreviews.add(result.imagePath)
      const preview = { ...result, rotation: page.rotation }
      this.previews.set(selected, preview)
      if (this.data.selected === selected) this.presentPreview(preview)
    } catch {
      if (!this.closed && this.data.selected === selected) {
        this.setData({ previewFailed: true, previewMessage: '无法生成页面预览' })
      }
    } finally {
      this.renderingPreviews.delete(selected)
    }
  },

  presentPreview(preview) {
    const page = this.session?.pages[this.data.selected]
    if (!page) return
    const rotation = ((page.rotation - preview.rotation + 360) % 360) as Rotation
    const swapSides = rotation === 90 || rotation === 270
    const layout = scanPdfLayout(swapSides ? preview.height : preview.width, swapSides ? preview.width : preview.height)
    const sheet = fitRectangle(layout.width, layout.height, this.frameWidth, this.frameHeight)
    this.sheet = sheet
    this.setData({
      preview: preview.imagePath,
      previewStyle: fitRotatedImageStyle(preview.width, preview.height, rotation, sheet.width, sheet.height),
      sheetStyle: `left:${sheet.left}px;top:${sheet.top}px;width:${sheet.width}px;height:${sheet.height}px`,
      previewMessage: '', previewFailed: false,
    })
    this.syncSignature()
  },

  syncSignature() {
    const signature = this.signatures.get(this.data.selected)
    const sheet = this.sheet
    const overlay = signature && sheet && signatureOverlay(signature, sheet.width, sheet.height)
    this.setData({ signatureStyle: overlay ? overlay.style : '', signatureSegments: overlay ? overlay.segments : [] })
  },

  openInk() {
    if (!this.sheet || this.data.busy || this.data.inkOpen) return
    this.draftInk = []
    this.sampledPoints = 0
    const request = this.inkRequest = Symbol()
    this.setData({ inkOpen: true, hasInk: false }, () => {
      wx.createSelectorQuery().select('#signature-pad').fields({ node: true, size: true, rect: true }).exec((matches) => {
        if (this.closed || this.inkRequest !== request) return
        const bounds = matches[0] as { node?: InkCanvas; width: number; height: number; left: number; top: number } | null
        const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        if (bounds?.node) this.inkPad = setupInkPad(bounds.node, bounds, window.pixelRatio)
        if (!this.inkPad) {
          this.closeInk()
          wx.showToast({ title: '当前微信版本无法打开签名画板', icon: 'none' })
        }
      })
    })
  },

  startInk(event) {
    const touch = event.changedTouches[0]
    if (!this.inkPad || !touch || this.inkPointer !== undefined || this.sampledPoints >= maxInkPoints) return
    this.inkPointer = touch.identifier
    const point = pointInPad(this.inkPad, touch.clientX, touch.clientY)
    this.draftInk.push([point])
    this.sampledPoints += 1
    drawInkPoint(this.inkPad, point)
    if (!this.data.hasInk) this.setData({ hasInk: true })
  },

  moveInk(event) {
    const pad = this.inkPad
    const touch = event.touches.find((point) => point.identifier === this.inkPointer)
    if (!pad || !touch || this.sampledPoints >= maxInkPoints) return
    const stroke = this.draftInk[this.draftInk.length - 1]
    const previous = stroke[stroke.length - 1]
    const point = pointInPad(pad, touch.clientX, touch.clientY)
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 2) return
    stroke.push(point)
    this.sampledPoints += 1
    drawInkPoint(pad, point, previous)
  },

  endInk() {
    this.inkPointer = undefined
  },

  clearInk() {
    this.endInk()
    this.draftInk = []
    this.sampledPoints = 0
    const pad = this.inkPad
    if (pad) pad.context.clearRect(0, 0, pad.width, pad.height)
    this.setData({ hasInk: false })
  },

  closeInk() {
    this.inkRequest = undefined
    this.clearInk()
    this.inkPad = undefined
    this.setData({ inkOpen: false })
  },

  applyInk() {
    const ink = normalizeSignature(this.draftInk)
    if (!ink) return
    const current = this.signatures.get(this.data.selected)
    this.signatures.set(this.data.selected, { ink, center: current?.center ?? { x: 0.8, y: 0.88 } })
    this.closeInk()
    this.syncSignature()
  },

  removeSignature() {
    if (this.data.busy) return
    this.signatureDrag = undefined
    this.signatures.delete(this.data.selected)
    this.syncSignature()
  },

  reuseSignature() {
    const signature = this.signatures.get(this.data.selected)
    if (!signature || this.data.busy) return
    for (let index = 0; index < this.data.pageCount; index += 1) {
      if (!this.signatures.has(index)) this.signatures.set(index, { ...signature })
    }
    wx.showToast({ title: '已应用到未签页', icon: 'none' })
  },

  startSignatureDrag(event) {
    const signature = this.signatures.get(this.data.selected)
    const touch = event.changedTouches[0]
    if (!signature || !this.sheet || !touch || this.data.busy || this.signatureDrag) return
    const rect = signatureRectangle(signature, this.sheet.width, this.sheet.height)
    this.signatureDrag = {
      id: touch.identifier, start: touchPosition(touch),
      center: { x: (rect.left + rect.width / 2) / this.sheet.width, y: (rect.top + rect.height / 2) / this.sheet.height },
    }
  },

  moveSignatureDrag(event) {
    const drag = this.signatureDrag
    const signature = this.signatures.get(this.data.selected)
    const sheet = this.sheet
    const touch = event.touches.find((point) => drag?.id === point.identifier)
    if (!signature || !sheet || !drag || !touch) return
    const point = touchPosition(touch)
    const center = { x: drag.center.x + (point.x - drag.start.x) / sheet.width, y: drag.center.y + (point.y - drag.start.y) / sheet.height }
    const rect = signatureRectangle({ ...signature, center }, sheet.width, sheet.height)
    this.signatures.set(this.data.selected, {
      ink: signature.ink,
      center: { x: (rect.left + rect.width / 2) / sheet.width, y: (rect.top + rect.height / 2) / sheet.height },
    })
    this.setData({ signatureStyle: `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px` })
  },

  endSignatureDrag() {
    this.signatureDrag = undefined
  },

  async savePdf() {
    const session = this.session
    if (!session?.pages.length || this.data.busy || this.data.inkOpen || this.signatureDrag) return
    const selected = this.data.selected
    const selectedOnly = this.data.scope === 'current'
    const pages = selectedOnly ? [session.pages[selected]] : session.pages
    const options = exportQualities[this.data.quality]
    const dirPath = `${wx.env.USER_DATA_PATH}/scan-exports/${Date.now()}`
    const filePath = `${dirPath}/${filename(this.data.filename)}.pdf`
    try {
      const bytes = await createScanPdf(pages.length, async (index) => {
        if (this.closed) throw new Error('本次导出已结束。')
        const page = pages[index]
        this.setData({ busy: `正在生成 PDF · ${index + 1} / ${pages.length}` })
        if (page.enhanced && !pageEdits(page)) return readImageBytes(page.enhanced)
        const result = await renderRaster(page, 'export', options)
        try {
          return await readImageBytes(result.imagePath)
        } finally {
          cleanImage(result.imagePath)
        }
      }, (index) => this.signatures.get(selectedOnly ? selected : index))
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
