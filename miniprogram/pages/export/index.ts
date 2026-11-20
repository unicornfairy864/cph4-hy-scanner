import { decorateImage, prepareImage, renderPage } from '../../image'
import { cloudEnabled, maxCloudPdfPreviewBytes, runCloudPdfPreview } from '../../services/cloud'
import {
  createScanPdf, fitRectangle, inspectSigningPdf, maxSigningPdfBytes, normalizeSignature, readFileBytes, readImageBytes,
  scanPdfLayout, signExistingPdf, signatureImageFormat, signatureRectangle, writeScanPdf,
} from '../../services/pdf'
import type { PageSignature } from '../../services/pdf'
import { buildImagePdfPreview } from '../../services/pdf-preview'
import type { Rotation } from '../../image'
import { fitRotatedImageStyle, fullImageCorners } from '../scan/geometry'
import { exportPageRange, exportQualities } from './session'
import type { ExportPage, ExportScope, PdfSession, PreviewImage } from './session'
import { drawInkPoint, pointInPad, setupInkPad, signatureOverlay } from './signature'
import type { InkCanvas, InkPad, SignaturePoint } from './signature'

interface ExportData {
  selected: number
  pageCount: number
  scope: ExportScope
  rangeStart: string
  rangeEnd: string
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
  signatureImage: string
  signatureSegments: ReturnType<typeof signatureOverlay>['segments']
  inkOpen: boolean
  hasInk: boolean
  existingPdfName: string
  hasScans: boolean
  importedImages: boolean
  cloudPreviewAvailable: boolean
  cloudPreviewRunning: boolean
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

interface ImportedPdf {
  path: string
  bytes: Uint8Array
  pages: SheetSize[]
  retained?: string
  retaining?: Promise<string>
  users: number
  discarded: boolean
  images: Map<number, { path: string; style: string }>
  attempted: Set<number>
}

interface ImportedImages {
  session: PdfSession
  owned: Set<string>
}

interface ScanDraft {
  selected: number
  scope: ExportData['scope']
  filename: string
  rangeStart: string
  rangeEnd: string
  signatures: Map<number, PageSignature>
}

type Touch = WechatMiniprogram.TouchEvent['touches'][number]

interface ExportActions {
  session?: PdfSession
  closed: boolean
  lastPdf?: string
  previews: Map<ExportPage, PreviewImage>
  ownedPreviews: Set<string>
  renderingPreviews: Set<ExportPage>
  signatures: Map<number, PageSignature>
  existingPdf?: ImportedPdf
  imageDocument?: ImportedImages
  scanDraft?: ScanDraft
  ownedSignatureImages: Set<string>
  pdfPreviewTurn: number
  confirmingCloudPreview: boolean
  sheet?: SheetSize
  signatureDrag?: SignatureDrag
  inkPad?: InkPad
  inkRequest?: symbol
  inkPointer?: number
  draftInk: SignaturePoint[][]
  sampledPoints: number
  saveSequence: number
  frameWidth: number
  frameHeight: number
  onLoad(): void
  onUnload(): void
  setFilename(event: WechatMiniprogram.Input): void
  selectQuality(event: WechatMiniprogram.TouchEvent): void
  selectScope(event: WechatMiniprogram.TouchEvent): void
  setRangeStart(event: WechatMiniprogram.Input): void
  setRangeEnd(event: WechatMiniprogram.Input): void
  documentSession(): PdfSession | undefined
  changePage(event: WechatMiniprogram.TouchEvent): void
  showPreview(): Promise<void>
  failPreviewImage(event: WechatMiniprogram.BaseEvent): void
  chooseExistingPdf(): Promise<void>
  openOriginalPdf(): Promise<void>
  requestCloudPdfPreview(): void
  previewPdfInCloud(source: ImportedPdf, index: number): Promise<void>
  cancelCloudPdfPreview(): void
  retainPdf(source: ImportedPdf): Promise<string>
  storePdfPreview(source: ImportedPdf, index: number, preview: { path: string; style: string }): void
  presentPdf(source: ImportedPdf, index: number): void
  discardImported(): void
  rememberScans(): void
  chooseDocumentImages(): Promise<void>
  chooseSignatureImage(): Promise<void>
  releaseSignatureImages(): void
  restoreScanDraft(): void
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
const maxSignatureImageBytes = 4 * 1024 * 1024
const maxCachedPdfPreviews = 4

function pageEdits(page: ExportPage): boolean {
  return Boolean(page.decorations?.mosaics?.length || page.decorations?.watermarks?.length || (page.sharpen && page.sharpen !== 'off'))
}

function imageSize(imagePath: string): Promise<SheetSize> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src: imagePath, success: ({ width, height }) => resolve({ width, height }), fail: reject })
  })
}

function choosePdf(): Promise<{ path: string; name: string; size: number } | undefined> {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf'],
      success: ({ tempFiles }) => resolve(tempFiles[0]),
      fail: (error) => error.errMsg.includes('cancel') ? resolve(undefined) : reject(new Error('无法选择 PDF 文件')),
    })
  })
}

function chooseImages(count: number): Promise<Array<{ tempFilePath: string; size: number }>> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'],
      success: ({ tempFiles }) => resolve(tempFiles),
      fail: (error) => error.errMsg.includes('cancel') ? resolve([]) : reject(new Error('无法选择图片')),
    })
  })
}

function makeDirectory(dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().mkdir({ dirPath, recursive: true, success: () => resolve(), fail: reject })
  })
}

function openPdf(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.openDocument({ filePath, fileType: 'pdf', showMenu: true, success: () => resolve(), fail: reject })
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
    selected: 0, pageCount: 0, scope: 'all', rangeStart: '1', rangeEnd: '1', filename: '', qualities: exportQualities, quality: 0, busy: '',
    preview: '', previewStyle: '', sheetStyle: '', previewMessage: '', previewFailed: false,
    signatureStyle: '', signatureImage: '', signatureSegments: [], inkOpen: false, hasInk: false,
    existingPdfName: '', hasScans: false, importedImages: false, cloudPreviewAvailable: false, cloudPreviewRunning: false,
  },
  closed: false,
  previews: new Map(),
  ownedPreviews: new Set(),
  renderingPreviews: new Set(),
  signatures: new Map(),
  ownedSignatureImages: new Set(),
  pdfPreviewTurn: 0,
  confirmingCloudPreview: false,
  draftInk: [],
  sampledPoints: 0,
  saveSequence: 0,
  frameWidth: 0,
  frameHeight: 0,

  onLoad() {
    this.previews = new Map()
    this.ownedPreviews = new Set()
    this.renderingPreviews = new Set()
    this.signatures = new Map()
    this.ownedSignatureImages = new Set()
    const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const rpx = window.windowWidth / 750
    this.frameWidth = window.windowWidth - 122 * rpx
    this.frameHeight = Math.min(window.windowHeight * 0.44, 860 * rpx)
    this.getOpenerEventChannel?.()?.on?.('scanExport', (session: PdfSession) => {
      if (this.closed) return
      this.session = session
      this.setData({ selected: session.selected, pageCount: session.pages.length, rangeEnd: String(session.pages.length), hasScans: Boolean(session.pages.length) })
      void this.showPreview()
    })
  },

  onUnload() {
    this.closed = true
    this.discardImported()
    if (this.lastPdf) cleanPdf(this.lastPdf)
    for (const path of this.ownedPreviews) cleanImage(path)
    this.ownedPreviews.clear()
    this.previews.clear()
    this.signatures.clear()
    this.scanDraft?.signatures.clear()
    this.releaseSignatureImages()
    this.scanDraft = undefined
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
    if (this.data.busy) return
    if (scope === 'range' && this.data.scope !== 'range') this.setData({ scope, rangeStart: '1', rangeEnd: String(this.data.pageCount) })
    else if (scope === 'all' || scope === 'current') this.setData({ scope })
  },

  setRangeStart(event) { this.setData({ rangeStart: event.detail.value }) },

  setRangeEnd(event) { this.setData({ rangeEnd: event.detail.value }) },

  documentSession() { return this.imageDocument?.session ?? this.session },

  changePage(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if ((direction !== -1 && direction !== 1) || this.data.busy || this.data.inkOpen) return
    const selected = this.data.selected + direction
    if (!(this.existingPdf?.pages ?? this.documentSession()?.pages)?.[selected]) return
    this.signatureDrag = undefined
    this.setData({ selected, preview: '', sheetStyle: '', signatureStyle: '', signatureImage: '', signatureSegments: [] })
    void this.showPreview()
  },

  async showPreview() {
    const selected = this.data.selected
    const imported = this.existingPdf
    if (imported?.pages[selected]) {
      this.presentPdf(imported, selected)
      if (imported.attempted.has(selected)) return
      imported.attempted.add(selected)
      const preview = await buildImagePdfPreview(imported.bytes, selected)
      if (!preview) return
      if (this.closed || imported.discarded || imported.images.has(selected)) return cleanImage(preview.imagePath)
      this.storePdfPreview(imported, selected, {
        path: preview.imagePath,
        style: `left:${preview.left * 100}%;top:${preview.top * 100}%;width:${preview.width * 100}%;height:${preview.height * 100}%;transform:none`,
      })
      if (this.existingPdf === imported && this.data.selected === selected) this.presentPdf(imported, selected)
      return
    }
    const page = this.documentSession()?.pages[selected]
    if (!page) return
    const ready = this.previews.get(page) ?? (page.enhanced ? undefined : page.preview)
    if (ready) {
      this.presentPreview(ready)
      return
    }
    if (this.renderingPreviews.has(page)) return
    this.sheet = undefined
    this.setData({ previewMessage: '正在生成页面预览', previewFailed: false })
    this.renderingPreviews.add(page)
    try {
      const borrowed = page.enhanced && !pageEdits(page)
      const result = borrowed && page.enhanced
        ? { imagePath: page.enhanced, ...await imageSize(page.enhanced) }
        : await renderRaster(page, 'preview')
      if (this.closed || (!this.session?.pages.includes(page) && !this.imageDocument?.session.pages.includes(page))) {
        if (!borrowed) cleanImage(result.imagePath)
        return
      }
      if (!borrowed) this.ownedPreviews.add(result.imagePath)
      const preview = { ...result, rotation: page.rotation }
      this.previews.set(page, preview)
      if (this.documentSession()?.pages[this.data.selected] === page && !this.existingPdf) this.presentPreview(preview)
    } catch {
      if (!this.closed && this.documentSession()?.pages[this.data.selected] === page && !this.existingPdf) {
        this.setData({ previewFailed: true, previewMessage: '无法生成页面预览' })
      }
    } finally {
      this.renderingPreviews.delete(page)
    }
  },

  failPreviewImage(event) {
    const path: unknown = event.currentTarget.dataset.path
    if (typeof path !== 'string' || path !== this.data.preview) return
    const source = this.existingPdf
    const index = this.data.selected
    if (source) {
      const preview = source.images.get(index)
      if (preview?.path === path) {
        source.images.delete(index)
        cleanImage(path)
        this.presentPdf(source, index)
      }
      return
    }
    const page = this.documentSession()?.pages[index]
    if (page && this.previews.get(page)?.imagePath === path) this.previews.delete(page)
    if (this.ownedPreviews.delete(path)) cleanImage(path)
    this.sheet = undefined
    this.setData({ preview: '', sheetStyle: '', previewFailed: true, previewMessage: '无法显示页面预览' })
  },

  async chooseExistingPdf() {
    if (this.data.busy || this.data.inkOpen || this.signatureDrag) return
    this.setData({ busy: '正在选择 PDF' })
    try {
      const selected = await choosePdf()
      if (this.closed || !selected) return
      if (selected.size > maxSigningPdfBytes) throw new Error('请选择 10 MB 以内的 PDF')
      this.setData({ busy: '正在读取 PDF' })
      const bytes = await readFileBytes(selected.path)
      const pages = await inspectSigningPdf(bytes)
      if (this.closed) return
      this.rememberScans()
      this.discardImported()
      this.existingPdf = { path: selected.path, bytes, pages, users: 0, discarded: false, images: new Map(), attempted: new Set() }
      this.signatures = new Map()
      this.releaseSignatureImages()
      this.sheet = undefined
      const name = selected.name || '原始 PDF'
      const title = name.replace(/\.pdf$/i, '')
      this.setData({
        selected: 0, scope: 'all', pageCount: pages.length, rangeStart: '1', rangeEnd: String(pages.length),
        filename: `${title}-已签名`, existingPdfName: name, importedImages: false,
        cloudPreviewAvailable: cloudEnabled && bytes.byteLength <= maxCloudPdfPreviewBytes,
      })
      void this.showPreview()
    } catch (error) {
      if (!this.closed) wx.showToast({ title: error instanceof Error ? error.message : '无法读取此 PDF', icon: 'none' })
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  rememberScans() {
    if (this.scanDraft || this.existingPdf || this.imageDocument || !this.session?.pages.length) return
    const { selected, scope, filename, rangeStart, rangeEnd } = this.data
    this.scanDraft = { selected, scope, filename, rangeStart, rangeEnd, signatures: this.signatures }
  },

  discardImported() {
    this.pdfPreviewTurn += 1
    const source = this.existingPdf
    this.existingPdf = undefined
    if (source) {
      source.discarded = true
      for (const { path } of source.images.values()) cleanImage(path)
      source.images.clear()
      if (!source.users && source.retained) cleanPdf(source.retained)
    }
    const images = this.imageDocument
    this.imageDocument = undefined
    if (images) {
      for (const page of images.session.pages) {
        const preview = this.previews.get(page)
        if (preview && this.ownedPreviews.delete(preview.imagePath)) cleanImage(preview.imagePath)
        this.previews.delete(page)
      }
      for (const path of images.owned) cleanImage(path)
    }
  },

  async chooseDocumentImages() {
    if (this.data.busy || this.data.inkOpen || this.signatureDrag) return
    this.setData({ busy: '正在选择图片' })
    const owned = new Set<string>()
    let retained = false
    try {
      const inputs = await chooseImages(9)
      if (!inputs.length || this.closed) return
      const pages: ExportPage[] = []
      let rejected = 0
      for (let index = 0; index < inputs.length && !this.closed; index += 1) {
        this.setData({ busy: `正在导入图片 · ${index + 1} / ${inputs.length}` })
        try {
          const path = inputs[index].tempFilePath
          const prepared = await prepareImage({ imagePath: path })
          if (prepared.imagePath !== path) owned.add(prepared.imagePath)
          pages.push({
            imagePath: prepared.imagePath, corners: fullImageCorners, rotation: 0, mode: 'color',
            enhance: false, denoise: false, dewarp: false,
            preview: { ...prepared, rotation: 0 },
          })
        } catch {
          rejected += 1
        }
      }
      if (this.closed) return
      if (!pages.length) throw new Error('无法读取所选图片')
      this.rememberScans()
      this.discardImported()
      this.imageDocument = { session: { pages, selected: 0 }, owned }
      retained = true
      this.signatures = new Map()
      this.releaseSignatureImages()
      this.sheet = undefined
      this.setData({
        selected: 0, scope: 'all', pageCount: pages.length, rangeStart: '1', rangeEnd: String(pages.length),
        filename: '图片签名', existingPdfName: '', importedImages: true, cloudPreviewAvailable: false,
      })
      void this.showPreview()
      if (rejected) wx.showToast({ title: `${rejected} 张图片无法读取`, icon: 'none' })
    } catch (error) {
      if (!this.closed) wx.showToast({ title: error instanceof Error ? error.message : '无法导入图片', icon: 'none' })
    } finally {
      if (!retained) for (const path of owned) cleanImage(path)
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  async retainPdf(source) {
    if (source.retained) return source.retained
    if (source.retaining) return source.retaining
    const dir = `${wx.env.USER_DATA_PATH}/pdf-source/${Date.now()}-${this.saveSequence++}`
    const path = dir + '/original.pdf'
    source.retaining = (async () => {
      try {
        await makeDirectory(dir)
        await writeScanPdf(path, source.bytes)
        source.retained = path
        return path
      } catch (error) {
        cleanPdf(path)
        throw error
      } finally {
        source.retaining = undefined
      }
    })()
    return source.retaining
  },

  async openOriginalPdf() {
    const source = this.existingPdf
    if (!source || this.data.busy) return
    this.setData({ busy: '正在打开原 PDF' })
    source.users += 1
    try {
      try {
        await openPdf(source.retained ?? source.path)
      } catch {
        const path = await this.retainPdf(source)
        if (!this.closed && this.existingPdf === source) await openPdf(path)
      }
    } catch {
      if (!this.closed) wx.showToast({ title: '无法打开原 PDF，请重新导入', icon: 'none' })
    } finally {
      source.users -= 1
      if (!source.users && source.discarded && source.retained) cleanPdf(source.retained)
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  requestCloudPdfPreview() {
    const source = this.existingPdf
    if (!source || !this.data.cloudPreviewAvailable || this.data.busy || this.confirmingCloudPreview) return
    const index = this.data.selected
    if (source.images.has(index)) return
    this.confirmingCloudPreview = true
    wx.showModal({
      title: `云预览第 ${index + 1} 页`,
      content: '将整份原 PDF 上传到本项目的云端，仅渲染当前页。只有同意后才上传。',
      confirmText: '上传预览',
      success: ({ confirm }) => {
        if (confirm && !this.closed && this.existingPdf === source && this.data.selected === index && !this.data.busy) {
          void this.previewPdfInCloud(source, index)
        }
      },
      complete: () => { this.confirmingCloudPreview = false },
    })
  },

  async previewPdfInCloud(source, index) {
    const turn = ++this.pdfPreviewTurn
    const isCancelled = () => this.closed || turn !== this.pdfPreviewTurn || this.existingPdf !== source
    source.users += 1
    this.setData({ busy: '正在准备 PDF', cloudPreviewRunning: true })
    try {
      const filePath = await this.retainPdf(source)
      if (isCancelled()) return
      this.setData({ busy: '正在上传 PDF' })
      const preview = await runCloudPdfPreview({
        filePath, pageNumber: index + 1, isCancelled,
        onStatus: (status) => {
          if (!isCancelled()) this.setData({ busy: status === 'queued' ? '已上传，正在排队' : '正在生成云预览' })
        },
      })
      if (isCancelled()) return cleanImage(preview.imagePath)
      this.storePdfPreview(source, index, { path: preview.imagePath, style: 'left:0;top:0;width:100%;height:100%;transform:none' })
      if (this.data.selected === index) this.presentPdf(source, index)
    } catch (error) {
      if (!isCancelled()) wx.showToast({ title: error instanceof Error ? error.message : '无法生成云预览，可查看原 PDF', icon: 'none' })
    } finally {
      source.users -= 1
      if (!source.users && source.discarded && source.retained) cleanPdf(source.retained)
      if (!isCancelled()) this.setData({ busy: '', cloudPreviewRunning: false })
    }
  },

  cancelCloudPdfPreview() {
    if (!this.data.cloudPreviewRunning) return
    this.pdfPreviewTurn += 1
    this.setData({ busy: '', cloudPreviewRunning: false })
  },

  storePdfPreview(source, index, preview) {
    const previous = source.images.get(index)
    if (previous && previous.path !== preview.path) cleanImage(previous.path)
    source.images.delete(index)
    source.images.set(index, preview)
    if (source.images.size <= maxCachedPdfPreviews) return
    for (const [oldIndex, oldPreview] of source.images) {
      if (oldIndex === this.data.selected) continue
      source.images.delete(oldIndex)
      source.attempted.delete(oldIndex)
      cleanImage(oldPreview.path)
      break
    }
  },

  presentPdf(source, index) {
    const page = source.pages[index]
    const preview = source.images.get(index)
    const sheet = fitRectangle(page.width, page.height, this.frameWidth, this.frameHeight)
    this.sheet = sheet
    this.setData({
      preview: preview?.path ?? '', previewStyle: preview?.style ?? '', previewFailed: false, previewMessage: '',
      sheetStyle: `left:${sheet.left}px;top:${sheet.top}px;width:${sheet.width}px;height:${sheet.height}px`,
    })
    this.syncSignature()
  },

  restoreScanDraft() {
    const draft = this.scanDraft
    if (!draft || !this.session || this.data.busy || this.data.inkOpen || this.signatureDrag) return
    this.discardImported()
    this.signatures = draft.signatures
    this.scanDraft = undefined
    this.releaseSignatureImages()
    this.sheet = undefined
    this.setData({
      selected: draft.selected, scope: draft.scope, filename: draft.filename, pageCount: this.session.pages.length,
      rangeStart: draft.rangeStart, rangeEnd: draft.rangeEnd, importedImages: false, cloudPreviewAvailable: false,
      existingPdfName: '', sheetStyle: '', signatureStyle: '', signatureImage: '', signatureSegments: [],
    })
    void this.showPreview()
  },

  presentPreview(preview) {
    const page = this.documentSession()?.pages[this.data.selected]
    if (!page || this.existingPdf) return
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
    this.setData({
      signatureStyle: overlay?.style ?? '', signatureImage: overlay?.imagePath ?? '', signatureSegments: overlay?.segments ?? [],
    })
  },

  async chooseSignatureImage() {
    if (!this.sheet || this.data.busy || this.data.inkOpen || this.signatureDrag) return
    const selectedPage = this.data.selected
    this.setData({ busy: '正在选择签名图片' })
    let generated: string | undefined
    try {
      const [input] = await chooseImages(1)
      if (!input || this.closed) return
      if (input.size > maxSignatureImageBytes) throw new Error('请选择 4 MB 以内的 PNG 或 JPG 签名图片')
      const prepared = await prepareImage({ imagePath: input.tempFilePath })
      if (prepared.imagePath !== input.tempFilePath) generated = prepared.imagePath
      const bytes = await readFileBytes(prepared.imagePath)
      if (this.closed) return
      const format = signatureImageFormat(bytes)
      if (!format || bytes.byteLength > maxSignatureImageBytes || prepared.width <= 0 || prepared.height <= 0
        || prepared.width * prepared.height > 4_000_000) {
        throw new Error('请选择 4 MB、400 万像素以内的 PNG 或 JPG 签名图片')
      }
      const previous = this.signatures.get(selectedPage)
      this.signatures.set(selectedPage, { image: { ...prepared, bytes, format }, center: previous?.center ?? { x: 0.8, y: 0.88 } })
      if (generated) {
        this.ownedSignatureImages.add(generated)
        generated = undefined
      }
      this.releaseSignatureImages()
      this.syncSignature()
    } catch (error) {
      if (!this.closed) wx.showToast({ title: error instanceof Error ? error.message : '无法导入签名图片', icon: 'none' })
    } finally {
      if (generated) cleanImage(generated)
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  releaseSignatureImages() {
    const retained = new Set<string>()
    for (const signatures of [this.signatures, this.scanDraft?.signatures]) {
      if (!signatures) continue
      for (const signature of signatures.values()) {
        if ('image' in signature) retained.add(signature.image.imagePath)
      }
    }
    for (const path of this.ownedSignatureImages) {
      if (!retained.has(path)) {
        this.ownedSignatureImages.delete(path)
        cleanImage(path)
      }
    }
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
    this.releaseSignatureImages()
    this.syncSignature()
  },

  removeSignature() {
    if (this.data.busy) return
    this.signatureDrag = undefined
    this.signatures.delete(this.data.selected)
    this.releaseSignatureImages()
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
      ...signature,
      center: { x: (rect.left + rect.width / 2) / sheet.width, y: (rect.top + rect.height / 2) / sheet.height },
    })
    this.setData({ signatureStyle: `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px` })
  },

  endSignatureDrag() {
    this.signatureDrag = undefined
  },

  async savePdf() {
    const session = this.documentSession()
    const existing = this.existingPdf
    if ((!existing && !session?.pages.length) || this.data.busy || this.data.inkOpen || this.signatureDrag) return
    const options = exportQualities[this.data.quality]
    const dirPath = `${wx.env.USER_DATA_PATH}/scan-exports/${Date.now()}-${this.saveSequence++}`
    const filePath = `${dirPath}/${filename(this.data.filename)}.pdf`
    try {
      const { scope, pageCount, selected, rangeStart, rangeEnd } = this.data
      const range = exportPageRange(scope, pageCount, selected, rangeStart, rangeEnd)
      const pages = session?.pages.slice(range.start, range.end) ?? []
      this.setData({ busy: '正在生成 PDF' })
      const bytes = existing ? await signExistingPdf(existing.bytes, this.signatures, range) : await createScanPdf(pages.length, async (index) => {
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
      }, (index) => this.signatures.get(range.start + index))
      if (this.closed) return
      await makeDirectory(dirPath)
      await writeScanPdf(filePath, bytes)
      if (this.closed) {
        cleanPdf(filePath)
        return
      }
      await openPdf(filePath)
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
