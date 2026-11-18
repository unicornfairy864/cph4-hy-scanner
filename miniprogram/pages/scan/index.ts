import { detectQuad, prepareImage, renderPage } from '../../image'
import type { ImageMode, Point, Quad, Rotation } from '../../image'
import { cloudEnabled, runCloudEnhancement } from '../../services/cloud'
import type { CloudOperation } from '../../services/cloud'
import { createScanPdf, readImageBytes, writeScanPdf } from '../../services/pdf'
import { edgeStyles, fitImage, fullImageCorners, isValidCrop, pointInImage } from './geometry'

const MAX_PAGES = 30
const modes: Array<{ value: ImageMode; label: string }> = [
  { value: 'color', label: '原色' },
  { value: 'grayscale', label: '灰度' },
  { value: 'bw', label: '黑白' },
]
const qualities = [
  { label: '标准', maxDimension: 1600, jpegQuality: 0.8 },
  { label: '清晰', maxDimension: 2400, jpegQuality: 0.9 },
]
const cloudNames = { dewarp: '书页展平', deshadow: '深阴影处理' }

interface ScanPage {
  id: number
  source: string
  width: number
  height: number
  corners: Quad
  autoDetected: boolean
  rotation: Rotation
  mode: ImageMode
  enhance: boolean
  denoise: boolean
  revision: number
  preview?: string
  enhanced?: string
}

interface Drag {
  index: number
  x: number
  y: number
  origin: Point
}

interface ScannerData {
  pages: Array<{ id: number; imagePath: string }>
  pageCount: number
  selected: number
  source: string
  preview: string
  showOriginal: boolean
  hasEnhanced: boolean
  autoDetected: boolean
  mode: ImageMode
  enhance: boolean
  denoise: boolean
  cropOpen: boolean
  cropWidth: number
  cropHeight: number
  corners: Quad
  handleIndices: number[]
  cornerEdges: string[]
  modes: typeof modes
  qualities: typeof qualities
  quality: number
  filename: string
  busy: string
  needsAlbumAccess: boolean
  cloudEnabled: boolean
  cloudRunning: boolean
  candidate: string
}

interface ScannerActions {
  scans: ScanPage[]
  currentId: number
  selectedPage: number
  previewTurn: number
  drag?: Drag
  closed: boolean
  cloudCancelled: boolean
  lastPdf?: string
  takePhoto(): void
  importAlbum(): void
  addPages(source: 'camera' | 'album'): Promise<void>
  current(): ScanPage | undefined
  sync(preserveOriginal?: boolean): void
  refreshPreview(): Promise<void>
  invalidate(page: ScanPage): void
  selectPage(event: WechatMiniprogram.TouchEvent): void
  openCrop(): void
  closeCrop(): void
  resetCrop(): void
  applyCrop(): void
  dragStart(event: WechatMiniprogram.TouchEvent): void
  dragMove(event: WechatMiniprogram.TouchEvent): void
  dragEnd(): void
  rotate(): void
  selectMode(event: WechatMiniprogram.TouchEvent): void
  toggleEnhance(event: WechatMiniprogram.SwitchChange): void
  toggleDenoise(event: WechatMiniprogram.SwitchChange): void
  applyEnhancementToAll(): void
  toggleOriginal(): void
  movePage(event: WechatMiniprogram.TouchEvent): void
  removePage(): void
  setFilename(event: WechatMiniprogram.Input): void
  setQuality(event: WechatMiniprogram.TouchEvent): void
  refreshAlbumPermission(): void
  saveJpg(): Promise<void>
  savePdf(): Promise<void>
  startCloud(event: WechatMiniprogram.TouchEvent): void
  enhanceCloud(page: ScanPage, operation: CloudOperation): Promise<void>
  cancelCloud(): void
  useCandidate(): void
  dismissCandidate(): void
  onLoad(): void
  onUnload(): void
}

function notify(message: string): void {
  wx.showToast({ title: message, icon: 'none' })
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function selectImages(source: 'camera' | 'album', count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: [source],
      camera: 'back',
      sizeType: ['original'],
      success: ({ tempFiles }) => resolve(tempFiles.map((file) => file.tempFilePath)),
      fail: (error) => error.errMsg.includes('cancel') ? resolve([]) : reject(error),
    })
  })
}

function removeFile(path: string): void {
  wx.getFileSystemManager().unlink({ filePath: path, fail: () => undefined })
}

function removePdf(path: string): void {
  const dirPath = path.slice(0, path.lastIndexOf('/'))
  wx.getFileSystemManager().rmdir({ dirPath, recursive: true, fail: () => undefined })
}

function cleanImage(path?: string): void {
  if (path?.startsWith(`${wx.env.USER_DATA_PATH}/scan-image-`)) {
    removeFile(path)
  }
}

function openPdf(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.openDocument({ filePath, fileType: 'pdf', showMenu: true, success: () => resolve(), fail: reject })
  })
}

function makePdfDirectory(dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().mkdir({ dirPath, recursive: true, success: () => resolve(), fail: reject })
  })
}

function exportFilename(input: string): string {
  const name = input.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 70)
  return name || `扫描文档-${new Date().toISOString().slice(0, 10)}`
}

function copyCorners(corners: Quad): Quad {
  const [first, second, third, fourth] = corners
  return [{ ...first }, { ...second }, { ...third }, { ...fourth }]
}

function renderOptions(page: ScanPage) {
  return {
    imagePath: page.source,
    corners: page.corners,
    rotation: page.rotation,
    mode: page.mode,
    enhance: page.enhance,
    denoise: page.denoise,
  }
}

Page<ScannerData, ScannerActions>({
  data: {
    pages: [], pageCount: 0, selected: 0, source: '', preview: '', showOriginal: false, hasEnhanced: false,
    autoDetected: false, mode: 'color', enhance: true, denoise: true, cropOpen: false,
    cropWidth: 0, cropHeight: 0, corners: fullImageCorners, handleIndices: [0, 1, 2, 3], cornerEdges: [],
    modes, qualities, quality: 0, filename: '', busy: '', needsAlbumAccess: false,
    cloudEnabled, cloudRunning: false, candidate: '',
  },
  scans: [],
  currentId: 0,
  selectedPage: 0,
  previewTurn: 0,
  closed: false,
  cloudCancelled: false,

  onLoad() {
    this.scans = []
  },

  takePhoto() {
    void this.addPages('camera')
  },

  importAlbum() {
    void this.addPages('album')
  },

  async addPages(source) {
    if (this.data.busy) return
    const openSlots = MAX_PAGES - this.scans.length
    if (openSlots <= 0) {
      notify(`当前文档最多添加 ${MAX_PAGES} 页。`)
      return
    }
    this.setData({ busy: source === 'camera' ? '正在打开相机' : '正在打开相册' })
    const start = this.scans.length
    let rejected = 0
    try {
      const paths = await selectImages(source, source === 'camera' ? 1 : Math.min(9, openSlots))
      for (let index = 0; index < paths.length && !this.closed; index += 1) {
        this.setData({ busy: `正在识别第 ${index + 1} / ${paths.length} 张` })
        try {
          const input = await prepareImage({ imagePath: paths[index] })
          const result = await detectQuad({ imagePath: input.imagePath }).catch(() => null)
          if (this.closed) {
            cleanImage(input.imagePath)
            break
          }
          const detected = result?.corners && isValidCrop(result.corners) ? result.corners : null
          this.scans.push({
            id: this.currentId++, source: input.imagePath, width: input.width, height: input.height,
            corners: copyCorners(detected ?? fullImageCorners), autoDetected: Boolean(detected),
            rotation: 0, mode: 'color', enhance: true, denoise: true, revision: 0,
          })
        } catch {
          rejected += 1
        }
      }
      if (this.closed) return
      if (this.scans.length > start) {
        this.selectedPage = start
        this.sync()
      }
      if (rejected) notify(`${rejected} 张图片读取失败，请重试。`)
    } catch (error) {
      notify(errorText(error, '无法读取图片，请检查相机或相册权限。'))
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
    if (!this.closed && this.scans.length > start) this.openCrop()
  },

  current() {
    return this.scans[this.selectedPage]
  },

  sync(preserveOriginal = false) {
    if (this.closed) return
    const page = this.current()
    this.setData({
      pages: this.scans.map((scan) => ({ id: scan.id, imagePath: scan.enhanced ?? scan.preview ?? scan.source })),
      pageCount: this.scans.length,
      selected: this.selectedPage,
      source: page?.source ?? '',
      preview: page?.enhanced ?? page?.preview ?? page?.source ?? '',
      showOriginal: preserveOriginal && this.data.showOriginal,
      hasEnhanced: Boolean(page?.enhanced),
      autoDetected: page?.autoDetected ?? false,
      mode: page?.mode ?? 'color',
      enhance: page?.enhance ?? true,
      denoise: page?.denoise ?? true,
    })
  },

  async refreshPreview() {
    const page = this.current()
    if (!page || page.preview || page.enhanced || this.data.cropOpen) return
    const preview = ++this.previewTurn
    const revision = page.revision
    try {
      const result = await renderPage({ ...renderOptions(page), quality: 'preview' })
      if (this.closed || this.current() !== page || revision !== page.revision || preview !== this.previewTurn) {
        cleanImage(result.imagePath)
        return
      }
      page.preview = result.imagePath
      this.sync(true)
    } catch (error) {
      if (this.current() === page && !this.closed && this.previewTurn === preview) {
        notify(errorText(error, '无法处理这张图片。请调整裁剪或重拍。'))
      }
    }
  },

  invalidate(page) {
    page.revision += 1
    cleanImage(page.preview)
    page.preview = undefined
    page.enhanced = undefined
    this.setData({ candidate: '' })
    this.sync()
    void this.refreshPreview()
  },

  selectPage(event) {
    if (this.data.busy || this.data.cropOpen) return
    const index = Number(event.currentTarget.dataset.index)
    if (!this.scans[index] || index === this.selectedPage) return
    this.selectedPage = index
    this.setData({ candidate: '' })
    this.sync()
    const page = this.current()
    if (page && !page.autoDetected && page.revision === 0) this.openCrop()
    else void this.refreshPreview()
  },

  openCrop() {
    const page = this.current()
    if (!page || this.data.busy) return
    const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const size = fitImage(page.width, page.height, window.windowWidth, window.windowHeight)
    const corners = copyCorners(page.corners)
    this.setData({
      cropOpen: true, cropWidth: size.width, cropHeight: size.height, corners,
      cornerEdges: edgeStyles(corners, size.width, size.height), candidate: '',
    })
  },

  closeCrop() {
    this.drag = undefined
    this.setData({ cropOpen: false })
    void this.refreshPreview()
  },

  resetCrop() {
    const corners = copyCorners(fullImageCorners)
    this.setData({ corners, cornerEdges: edgeStyles(corners, this.data.cropWidth, this.data.cropHeight) })
  },

  applyCrop() {
    const page = this.current()
    const corners = this.data.corners
    if (!page || !isValidCrop(corners)) {
      notify('请调整四角，使页边保持正确顺序。')
      return
    }
    this.drag = undefined
    page.corners = copyCorners(corners)
    this.setData({ cropOpen: false })
    this.invalidate(page)
  },

  dragStart(event) {
    const point = event.touches[0]
    const index = Number(event.currentTarget.dataset.index)
    const origin = this.data.corners[index]
    if (point && origin) this.drag = { index, x: point.clientX, y: point.clientY, origin }
  },

  dragMove(event) {
    const point = event.touches[0]
    const drag = this.drag
    if (!point || !drag) return
    const corners = copyCorners(this.data.corners)
    corners[drag.index] = pointInImage(
      drag.origin.x + (point.clientX - drag.x) / this.data.cropWidth,
      drag.origin.y + (point.clientY - drag.y) / this.data.cropHeight,
    )
    if (isValidCrop(corners)) {
      this.setData({ corners, cornerEdges: edgeStyles(corners, this.data.cropWidth, this.data.cropHeight) })
    }
  },

  dragEnd() {
    this.drag = undefined
  },

  rotate() {
    const page = this.current()
    if (!page || this.data.busy) return
    page.rotation = ((page.rotation + 90) % 360) as Rotation
    this.invalidate(page)
  },

  selectMode(event) {
    const page = this.current()
    const mode = modes.find(({ value }) => value === event.currentTarget.dataset.mode)
    if (!page || !mode || mode.value === page.mode || this.data.busy) return
    page.mode = mode.value
    this.invalidate(page)
  },

  toggleEnhance(event) {
    const page = this.current()
    if (!page || this.data.busy) return
    page.enhance = event.detail.value
    this.invalidate(page)
  },

  toggleDenoise(event) {
    const page = this.current()
    if (!page || this.data.busy) return
    page.denoise = event.detail.value
    this.invalidate(page)
  },

  applyEnhancementToAll() {
    const current = this.current()
    if (!current || this.data.busy || this.scans.length < 2) return
    for (const page of this.scans) {
      if (page.mode === current.mode && page.enhance === current.enhance && page.denoise === current.denoise) continue
      page.mode = current.mode
      page.enhance = current.enhance
      page.denoise = current.denoise
      page.revision += 1
      cleanImage(page.preview)
      page.preview = undefined
      page.enhanced = undefined
    }
    this.sync()
    notify(`增强设置已应用到全部 ${this.scans.length} 页。`)
  },

  toggleOriginal() {
    if (!this.current() || this.data.busy) return
    this.setData({ showOriginal: !this.data.showOriginal })
  },

  movePage(event) {
    const page = this.current()
    const offset = Number(event.currentTarget.dataset.offset)
    if (!page || this.data.busy || (offset !== -1 && offset !== 1)) return
    const next = this.selectedPage + offset
    if (next < 0 || next >= this.scans.length) return
    this.scans.splice(this.selectedPage, 1)
    this.scans.splice(next, 0, page)
    this.selectedPage = next
    this.sync()
  },

  removePage() {
    const page = this.current()
    if (!page || this.data.busy) return
    wx.showModal({
      title: '删除当前页？',
      content: '这张图片将从本次扫描中移除。',
      confirmText: '删除',
      confirmColor: '#a7382e',
      success: ({ confirm }) => {
        if (!confirm || this.closed || this.current() !== page || this.data.busy) return
        const [removed] = this.scans.splice(this.selectedPage, 1)
        cleanImage(removed.source)
        cleanImage(removed.preview)
        this.selectedPage = Math.max(0, Math.min(this.selectedPage, this.scans.length - 1))
        this.setData({ candidate: '' })
        this.sync()
        void this.refreshPreview()
      },
    })
  },

  setFilename(event) {
    this.setData({ filename: event.detail.value })
  },

  setQuality(event) {
    const quality = Number(event.currentTarget.dataset.index)
    if (qualities[quality] && !this.data.busy) this.setData({ quality })
  },

  refreshAlbumPermission() {
    wx.getSetting({
      success: ({ authSetting }) => {
        if (!this.closed) this.setData({ needsAlbumAccess: authSetting['scope.writePhotosAlbum'] === false })
      },
    })
  },

  async saveJpg() {
    const page = this.current()
    if (!page || this.data.busy) return
    this.setData({ busy: '正在保存 JPG' })
    let generated: string | undefined
    try {
      let filePath = page.enhanced
      if (!filePath) {
        const options = qualities[this.data.quality]
        const result = await renderPage({ ...renderOptions(page), ...options, quality: 'export' })
        filePath = result.imagePath
        generated = filePath
      }
      if (this.closed) return
      await new Promise<void>((resolve, reject) => {
        wx.saveImageToPhotosAlbum({ filePath, success: () => resolve(), fail: reject })
      })
      if (!this.closed) {
        this.setData({ needsAlbumAccess: false })
        notify('JPG 已保存到相册。')
      }
    } catch (error) {
      if (!this.closed) {
        this.refreshAlbumPermission()
        notify(errorText(error, '无法保存 JPG，请检查相册权限或重试。'))
      }
    } finally {
      cleanImage(generated)
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  async savePdf() {
    if (!this.scans.length || this.data.busy) return
    this.setData({ busy: '正在生成 PDF' })
    const scans = this.scans.slice()
    const filename = exportFilename(this.data.filename)
    const options = qualities[this.data.quality]
    const dirPath = `${wx.env.USER_DATA_PATH}/scan-exports/${Date.now()}`
    const path = `${dirPath}/${filename}.pdf`
    try {
      const bytes = await createScanPdf(scans.length, async (index) => {
        if (this.closed) throw new Error('本次导出已结束。')
        const page = scans[index]
        this.setData({ busy: `正在生成 PDF · ${index + 1} / ${scans.length}` })
        if (page.enhanced) return readImageBytes(page.enhanced)
        const result = await renderPage({ ...renderOptions(page), ...options, quality: 'export' })
        try {
          return await readImageBytes(result.imagePath)
        } finally {
          cleanImage(result.imagePath)
        }
      })
      if (this.closed) return
      await makePdfDirectory(dirPath)
      await writeScanPdf(path, bytes)
      if (this.closed) {
        removePdf(path)
        return
      }
      await openPdf(path)
      if (this.closed) removePdf(path)
      else {
        if (this.lastPdf && this.lastPdf !== path) removePdf(this.lastPdf)
        this.lastPdf = path
      }
    } catch (error) {
      removePdf(path)
      if (!this.closed) notify(errorText(error, '无法导出 PDF，请选择标准清晰度后重试。'))
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  startCloud(event) {
    const operation: unknown = event.currentTarget.dataset.operation
    const page = this.current()
    if (!cloudEnabled || !page || this.data.busy || (operation !== 'dewarp' && operation !== 'deshadow')) return
    wx.showModal({
      title: cloudNames[operation],
      content: '此选项会将当前页面上传到处理服务器。处理结束后可预览并决定是否采用。',
      confirmText: '上传处理',
      success: ({ confirm }) => {
        if (confirm && !this.closed && this.current() === page && !this.data.busy) {
          void this.enhanceCloud(page, operation)
        }
      },
    })
  },

  async enhanceCloud(page, operation) {
    const revision = page.revision
    this.cloudCancelled = false
    this.setData({ cloudRunning: true, busy: '正在准备当前页', candidate: '' })
    let input: string | undefined
    const cancelled = () => this.closed || this.cloudCancelled || this.current() !== page || page.revision !== revision
    try {
      const result = await renderPage({
        ...renderOptions(page), mode: 'color', enhance: false, denoise: false,
        quality: 'export', maxDimension: 2048, jpegQuality: 0.9,
      })
      input = result.imagePath
      if (cancelled()) return
      this.setData({ busy: '正在上传当前页' })
      const output = await runCloudEnhancement({
        imagePath: input,
        operation,
        isCancelled: cancelled,
        onStatus: (status) => {
          if (cancelled()) return
          if (status === 'queued') this.setData({ busy: '当前页正在排队' })
          if (status === 'running') this.setData({ busy: '服务器正在处理当前页' })
          if (status === 'succeeded') this.setData({ busy: '正在获取增强结果' })
        },
      })
      if (!cancelled()) this.setData({ candidate: output.imagePath })
    } catch (error) {
      if (!cancelled()) notify(errorText(error, '云端增强失败，你可以继续使用本地扫描。'))
    } finally {
      cleanImage(input)
      if (!this.closed) this.setData({ cloudRunning: false, busy: '' })
    }
  },

  cancelCloud() {
    if (this.data.cloudRunning) {
      this.cloudCancelled = true
      this.setData({ busy: '正在取消增强', cloudRunning: false })
    }
  },

  useCandidate() {
    const page = this.current()
    if (!page || !this.data.candidate || this.data.busy) return
    page.enhanced = this.data.candidate
    this.setData({ candidate: '' })
    this.sync()
  },

  dismissCandidate() {
    this.setData({ candidate: '' })
  },

  onUnload() {
    this.closed = true
    this.cloudCancelled = true
    for (const page of this.scans) {
      cleanImage(page.source)
      cleanImage(page.preview)
    }
    if (this.lastPdf) removePdf(this.lastPdf)
  },
})
