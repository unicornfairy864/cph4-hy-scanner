import { detectQuad, prepareImage, renderPage } from '../../image'
import type { ImageMode, Quad, Rotation } from '../../image'
import { cloudEnabled, runCloudEnhancement } from '../../services/cloud'
import type { CloudOperation } from '../../services/cloud'
import { exportQualities } from '../export/session'
import type { ExportPage, PdfSession } from '../export/session'
import { edgeStyles, fitImage, fullImageCorners, isValidCrop } from './geometry'

const MAX_PAGES = 30
const TILE_STRIDE = 138
const TILE_WIDTH = 112
const TILE_HEIGHT = 126
const COLLAPSE_DISTANCE = 100
const modes: Array<{ value: ImageMode; label: string }> = [
  { value: 'color', label: '原色' },
  { value: 'grayscale', label: '灰度' },
  { value: 'bw', label: '黑白' },
]
const cloudNames = { dewarp: '服务器展平', deshadow: '深阴影处理' }

type ImageSource = 'camera' | 'album' | 'chat'
type CornerScores = [number, number, number, number]

interface ScanPage {
  id: number
  source: string
  width: number
  height: number
  corners: Quad
  autoDetected: boolean
  cornerConfidences: CornerScores
  rotation: Rotation
  mode: ImageMode
  enhance: boolean
  denoise: boolean
  dewarp: boolean
  revision: number
  previewRevision?: number
  renderingRevision?: number
  preview?: string
  enhanced?: string
}

interface PageDrag {
  id: number
  touchId: number
  from: number
  startX: number
  startScroll: number
  x: number
  target: number
  bounds?: { left: number; right: number; width: number }
  timer?: ReturnType<typeof setInterval>
}

interface Thumbnail {
  id: number
  source: string
  width: number
  height: number
  lines: Array<{ id: number; style: string }>
}

interface PreviewLayer {
  path: string
  visible: boolean
}

interface ScannerData {
  pages: Thumbnail[]
  pageCount: number
  selected: number
  source: string
  previewLayers: PreviewLayer[]
  previewHeight: number
  controlsMinHeight: number
  showOriginal: boolean
  hasEnhanced: boolean
  autoDetected: boolean
  partialDetected: boolean
  cornerConfidences: CornerScores
  mode: ImageMode
  enhance: boolean
  denoise: boolean
  dewarp: boolean
  cropOpen: boolean
  cropWidth: number
  cropHeight: number
  cropRotation: Rotation
  corners: Quad
  modes: typeof modes
  deleteArmed: number
  dragId: number
  dragTarget: number
  thumbScrollLeft: number
  thumbAnchor: string
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
  generatedImages: Set<string>
  rpx: number
  expandedHeight: number
  collapsedHeight: number
  actualThumbScroll: number
  pageDrag?: PageDrag
  closed: boolean
  cloudTurn: number
  takePhoto(): void
  showImportOptions(): void
  addPages(source: ImageSource): Promise<void>
  current(): ScanPage | undefined
  syncGallery(): void
  syncSelection(resetOriginal?: boolean): void
  display(path?: string): void
  paint(): void
  finishPreviewLoad(event: WechatMiniprogram.BaseEvent): void
  failPreviewLoad(event: WechatMiniprogram.BaseEvent): void
  releaseUnusedImages(): void
  refreshPreview(): Promise<void>
  invalidate(page: ScanPage): void
  selectPage(event: WechatMiniprogram.TouchEvent): void
  activatePage(index: number, scrollToPage?: boolean): void
  changePage(event: WechatMiniprogram.TouchEvent): void
  onControlsScroll(event: { detail: { scrollTop: number } }): void
  onThumbnailsScroll(event: { detail: { scrollLeft: number } }): void
  startPageDrag(event: WechatMiniprogram.TouchEvent): void
  updatePageDrag(): void
  movePageDrag(event: WechatMiniprogram.TouchEvent): void
  endPageDrag(event: WechatMiniprogram.TouchEvent): void
  cancelPageDrag(): void
  stopPageDrag(): void
  relocatePage(from: number, to: number): void
  moveSelectedPage(event: WechatMiniprogram.TouchEvent): void
  openCrop(): void
  closeCrop(): void
  applyCrop(event: { detail: { corners: Quad; rotation: Rotation } }): void
  selectMode(event: WechatMiniprogram.TouchEvent): void
  toggleEnhance(event: WechatMiniprogram.SwitchChange): void
  toggleDenoise(event: WechatMiniprogram.SwitchChange): void
  toggleDewarp(event: WechatMiniprogram.SwitchChange): void
  applyEnhancementToAll(): void
  selectPreview(event: WechatMiniprogram.TouchEvent): void
  removePage(event: WechatMiniprogram.TouchEvent): void
  openExport(): void
  refreshAlbumPermission(): void
  saveJpg(): Promise<void>
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

function selectImages(source: ImageSource, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const fail = (error: WechatMiniprogram.GeneralCallbackResult) => {
      if (error.errMsg.includes('cancel')) resolve([])
      else reject(error)
    }
    if (source === 'chat') {
      wx.chooseMessageFile({
        count,
        type: 'image',
        success: ({ tempFiles }) => resolve(tempFiles.map((file) => file.path)),
        fail,
      })
      return
    }
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: [source],
      camera: 'back',
      sizeType: ['original'],
      success: ({ tempFiles }) => resolve(tempFiles.map((file) => file.tempFilePath)),
      fail,
    })
  })
}

function removeFile(path: string): void {
  wx.getFileSystemManager().unlink({ filePath: path, fail: () => undefined })
}

function copyCorners(corners: Quad): Quad {
  const [first, second, third, fourth] = corners
  return [{ ...first }, { ...second }, { ...third }, { ...fourth }]
}

function renderOptions(page: ScanPage): Omit<ExportPage, 'enhanced' | 'preview'> {
  return {
    imagePath: page.source,
    corners: page.corners,
    rotation: page.rotation,
    mode: page.mode,
    enhance: page.enhance,
    denoise: page.denoise,
    dewarp: page.dewarp,
  }
}

Page<ScannerData, ScannerActions>({
  data: {
    pages: [], pageCount: 0, selected: 0, source: '', previewLayers: [], previewHeight: 300, controlsMinHeight: 480,
    showOriginal: false, hasEnhanced: false, autoDetected: false, partialDetected: false,
    cornerConfidences: [0, 0, 0, 0], mode: 'color', enhance: true, denoise: true, dewarp: false,
    cropOpen: false, cropWidth: 0, cropHeight: 0, cropRotation: 0, corners: fullImageCorners, modes,
    deleteArmed: -1, dragId: -1, dragTarget: -1, thumbScrollLeft: 0, thumbAnchor: '',
    busy: '', needsAlbumAccess: false,
    cloudEnabled, cloudRunning: false, candidate: '',
  },
  scans: [],
  currentId: 0,
  selectedPage: 0,
  generatedImages: new Set(),
  rpx: 0.5,
  expandedHeight: 300,
  collapsedHeight: 200,
  actualThumbScroll: 0,
  closed: false,
  cloudTurn: 0,

  onLoad() {
    this.scans = []
    this.generatedImages = new Set()
    const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.rpx = window.windowWidth / 750
    this.expandedHeight = Math.round(window.windowHeight * 0.53)
    this.collapsedHeight = Math.round(window.windowHeight * 0.35)
    this.setData({
      previewHeight: this.expandedHeight,
      controlsMinHeight: window.windowHeight - this.collapsedHeight + COLLAPSE_DISTANCE,
    })
  },

  takePhoto() {
    void this.addPages('camera')
  },

  showImportOptions() {
    if (this.data.busy) return
    const sources: ImageSource[] = ['camera', 'album', 'chat']
    wx.showActionSheet({
      itemList: ['📷 相机拍摄', '🖼 图库导入', '💬 对话导入'],
      success: ({ tapIndex }) => {
        const source = sources[tapIndex]
        if (source && !this.closed) void this.addPages(source)
      },
    })
  },

  async addPages(source) {
    if (this.data.busy) return
    const openSlots = MAX_PAGES - this.scans.length
    if (openSlots <= 0) {
      notify(`当前文档最多添加 ${MAX_PAGES} 页。`)
      return
    }
    const opening = { camera: '正在打开相机', album: '正在打开相册', chat: '正在打开聊天文件' }
    this.setData({ busy: opening[source], deleteArmed: -1 })
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
            if (input.imagePath !== paths[index]) removeFile(input.imagePath)
            break
          }
          if (input.imagePath !== paths[index]) this.generatedImages.add(input.imagePath)
          const detected = result?.corners && isValidCrop(result.corners) ? result.corners : null
          this.scans.push({
            id: this.currentId++, source: input.imagePath, width: input.width, height: input.height,
            corners: copyCorners(detected ?? fullImageCorners), autoDetected: Boolean(detected),
            cornerConfidences: detected ? result?.cornerConfidences ?? [0, 0, 0, 0] : [0, 0, 0, 0],
            rotation: 0, mode: 'color', enhance: true, denoise: true, dewarp: false, revision: 0,
          })
        } catch {
          rejected += 1
        }
      }
      if (this.closed) return
      if (this.scans.length > start) {
        this.selectedPage = start
        this.syncGallery()
        this.syncSelection(true)
        this.setData({ thumbAnchor: `scan-page-${this.current()?.id}` })
        this.paint()
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

  syncGallery() {
    if (this.closed) return
    const pages: Thumbnail[] = this.scans.map((page) => {
      const scale = Math.min(TILE_WIDTH * this.rpx / page.width, TILE_HEIGHT * this.rpx / page.height)
      const width = page.width * scale
      const height = page.height * scale
      return {
        id: page.id, source: page.source, width, height,
        lines: edgeStyles(page.corners, width, height).map((style, id) => ({ id, style })),
      }
    })
    this.setData({ pages, pageCount: pages.length })
  },

  syncSelection(resetOriginal = false) {
    if (this.closed) return
    const page = this.current()
    const scores = page?.cornerConfidences ?? [0, 0, 0, 0]
    this.setData({
      selected: this.selectedPage,
      source: page?.source ?? '',
      showOriginal: !resetOriginal && this.data.showOriginal,
      hasEnhanced: Boolean(page?.enhanced),
      autoDetected: page?.autoDetected ?? false,
      partialDetected: Boolean(page?.autoDetected && scores.some((score) => score < 0.52)),
      cornerConfidences: scores,
      mode: page?.mode ?? 'color',
      enhance: page?.enhance ?? true,
      denoise: page?.denoise ?? true,
      dewarp: page?.dewarp ?? false,
    })
  },

  display(path) {
    const layers = this.data.previewLayers
    const visible = layers.find((layer) => layer.visible)
    if (!path || visible?.path === path) {
      if (layers.length && (layers.length !== 1 || !path)) {
        this.setData({ previewLayers: path && visible ? [visible] : [] }, () => this.releaseUnusedImages())
      }
      return
    }
    if (layers.some((layer) => layer.path === path)) return
    const staged = { path, visible: false }
    this.setData({ previewLayers: visible ? [visible, staged] : [staged] }, () => this.releaseUnusedImages())
  },

  paint() {
    const page = this.current()
    if (!page) this.display()
    else this.display(this.data.showOriginal ? page.source : page.enhanced ?? page.preview ?? page.source)
  },

  finishPreviewLoad(event) {
    const path: unknown = event.currentTarget.dataset.path
    if (typeof path !== 'string' || !this.data.previewLayers.some((layer) => layer.path === path && !layer.visible)) return
    this.setData({ previewLayers: [{ path, visible: true }] }, () => this.releaseUnusedImages())
  },

  failPreviewLoad(event) {
    const path: unknown = event.currentTarget.dataset.path
    if (!this.data.previewLayers.some((layer) => layer.path === path && !layer.visible)) return
    this.setData({ previewLayers: this.data.previewLayers.filter((layer) => layer.visible) }, () => this.releaseUnusedImages())
  },

  releaseUnusedImages() {
    if (this.closed) return
    const used = new Set<string>(this.data.previewLayers.map(({ path }) => path))
    if (this.data.candidate) used.add(this.data.candidate)
    for (const page of this.scans) {
      used.add(page.source)
      if (page.preview) used.add(page.preview)
      if (page.enhanced) used.add(page.enhanced)
    }
    for (const path of this.generatedImages) {
      if (used.has(path)) continue
      this.generatedImages.delete(path)
      removeFile(path)
    }
  },

  async refreshPreview() {
    const page = this.current()
    if (!page || page.previewRevision === page.revision || page.renderingRevision !== undefined || page.enhanced || this.data.cropOpen) return
    const revision = page.revision
    page.renderingRevision = revision
    try {
      const result = await renderPage({ ...renderOptions(page), quality: 'preview' })
      if (this.closed || !this.scans.includes(page) || revision !== page.revision) {
        removeFile(result.imagePath)
        return
      }
      this.generatedImages.add(result.imagePath)
      page.preview = result.imagePath
      page.previewRevision = revision
      if (this.current() === page && !this.data.showOriginal && !this.data.cropOpen) this.paint()
      else this.releaseUnusedImages()
    } catch (error) {
      if (this.current() === page && !this.closed && revision === page.revision) {
        notify(errorText(error, '无法处理这张图片。请调整裁剪或重拍。'))
      }
    } finally {
      page.renderingRevision = undefined
      if (!this.closed && revision !== page.revision && this.current() === page) void this.refreshPreview()
    }
  },

  invalidate(page) {
    page.revision += 1
    page.enhanced = undefined
    const previewLayers = this.data.showOriginal
      ? this.data.previewLayers
      : this.data.previewLayers.filter((layer) => layer.visible || layer.path === page.source)
    this.setData({ candidate: '', deleteArmed: -1, previewLayers }, () => this.releaseUnusedImages())
    this.syncSelection()
    void this.refreshPreview()
  },

  selectPage(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (index === this.selectedPage && this.data.deleteArmed >= 0) this.setData({ deleteArmed: -1 })
    else this.activatePage(index)
  },

  activatePage(index, scrollToPage = false) {
    if (this.data.busy || this.data.cropOpen || this.pageDrag) return
    if (!this.scans[index] || index === this.selectedPage) return
    this.selectedPage = index
    this.setData({ candidate: '', deleteArmed: -1, thumbAnchor: scrollToPage ? `scan-page-${this.scans[index].id}` : '' }, () => this.releaseUnusedImages())
    this.syncSelection(true)
    this.paint()
    void this.refreshPreview()
  },

  changePage(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if (direction === -1 || direction === 1) this.activatePage(this.selectedPage + direction, true)
  },

  onControlsScroll(event) {
    const offset = Math.max(0, Math.min(COLLAPSE_DISTANCE, event.detail.scrollTop))
    const progress = Math.round(offset / 4) * 4 / COLLAPSE_DISTANCE
    const previewHeight = Math.round(this.expandedHeight + (this.collapsedHeight - this.expandedHeight) * progress)
    if (this.data.previewHeight !== previewHeight) this.setData({ previewHeight })
  },

  openCrop() {
    const page = this.current()
    if (!page || this.data.busy) return
    const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const size = fitImage(page.width, page.height, window.windowWidth, window.windowHeight)
    const corners = copyCorners(page.corners)
    this.setData({
      cropOpen: true, cropWidth: size.width, cropHeight: size.height, cropRotation: page.rotation,
      corners, deleteArmed: -1,
    })
  },

  closeCrop() {
    this.setData({ cropOpen: false })
    this.paint()
    void this.refreshPreview()
  },

  applyCrop(event) {
    const page = this.current()
    const { corners, rotation } = event.detail
    if (!page || !isValidCrop(corners)) {
      notify('请调整四角，使页边保持正确顺序。')
      return
    }
    this.setData({ cropOpen: false })
    const cropChanged = corners.some((point, index) => point.x !== page.corners[index].x || point.y !== page.corners[index].y)
    const rotationChanged = rotation !== page.rotation
    if (cropChanged) {
      page.corners = copyCorners(corners)
      page.cornerConfidences = [1, 1, 1, 1]
      page.autoDetected = true
      this.syncGallery()
    }
    if (cropChanged || rotationChanged) {
      page.rotation = rotation
      this.invalidate(page)
    } else {
      this.paint()
      void this.refreshPreview()
    }
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

  toggleDewarp(event) {
    const page = this.current()
    if (!page || this.data.busy || page.dewarp === event.detail.value) return
    page.dewarp = event.detail.value
    this.invalidate(page)
  },

  applyEnhancementToAll() {
    const current = this.current()
    if (!current || this.data.busy || this.scans.length < 2) return
    for (const page of this.scans) {
      if (page.mode === current.mode && page.enhance === current.enhance && page.denoise === current.denoise && page.dewarp === current.dewarp) continue
      page.mode = current.mode
      page.enhance = current.enhance
      page.denoise = current.denoise
      page.dewarp = current.dewarp
      page.revision += 1
      page.enhanced = undefined
    }
    this.releaseUnusedImages()
    notify(`增强设置已应用到全部 ${this.scans.length} 页。`)
  },

  selectPreview(event) {
    if (!this.current() || this.data.busy) return
    const showOriginal = event.currentTarget.dataset.view === 'original'
    if (this.data.showOriginal === showOriginal) return
    this.setData({ showOriginal })
    this.paint()
    if (!showOriginal) void this.refreshPreview()
  },

  onThumbnailsScroll(event) {
    this.actualThumbScroll = event.detail.scrollLeft
    this.updatePageDrag()
  },

  startPageDrag(event) {
    const touch = event.changedTouches[0]
    const from = Number(event.currentTarget.dataset.index)
    const page = this.scans[from]
    if (!touch || !page || this.pageDrag || this.data.busy || this.scans.length < 2) return
    const drag: PageDrag = {
      id: page.id, touchId: touch.identifier, from, startX: touch.clientX,
      startScroll: this.actualThumbScroll, x: touch.clientX, target: from,
    }
    this.pageDrag = drag
    this.setData({ dragId: drag.id, dragTarget: from, deleteArmed: -1, thumbAnchor: '' })
    this.createSelectorQuery().select('.thumbnail-strip').boundingClientRect((bounds) => {
      if (this.pageDrag !== drag || !bounds || Array.isArray(bounds)) return
      drag.bounds = bounds
      drag.timer = setInterval(() => {
        const viewport = drag.bounds
        if (!viewport || this.pageDrag !== drag || Math.abs(drag.x - drag.startX) < 5) return
        const margin = 28
        const step = drag.x > viewport.right - margin ? 15 : drag.x < viewport.left + margin ? -15 : 0
        if (!step) return
        const max = Math.max(0, this.scans.length * TILE_STRIDE * this.rpx - viewport.width)
        const next = Math.max(0, Math.min(max, this.actualThumbScroll + step))
        if (next !== this.data.thumbScrollLeft) this.setData({ thumbScrollLeft: next })
      }, 65)
    }).exec()
  },

  updatePageDrag() {
    const drag = this.pageDrag
    if (!drag) return
    const delta = drag.x - drag.startX + this.actualThumbScroll - drag.startScroll
    const target = Math.max(0, Math.min(this.scans.length - 1, drag.from + Math.round(delta / (TILE_STRIDE * this.rpx))))
    if (target === drag.target) return
    drag.target = target
    this.setData({ dragTarget: target })
  },

  movePageDrag(event) {
    const drag = this.pageDrag
    const touch = drag && event.touches.find((point) => point.identifier === drag.touchId)
    if (!drag || !touch) return
    drag.x = touch.clientX
    this.updatePageDrag()
  },

  endPageDrag(event) {
    const drag = this.pageDrag
    if (!drag || !event.changedTouches.some((touch) => touch.identifier === drag.touchId)) return
    this.stopPageDrag()
    if (drag.target !== drag.from) this.relocatePage(drag.from, drag.target)
  },

  cancelPageDrag() {
    this.stopPageDrag()
  },

  stopPageDrag() {
    const drag = this.pageDrag
    if (!drag) return
    this.pageDrag = undefined
    if (drag.timer !== undefined) clearInterval(drag.timer)
    if (!this.closed) this.setData({ dragId: -1, dragTarget: -1 })
  },

  relocatePage(from, to) {
    const selected = this.current()
    if (!selected || !this.scans[from] || !this.scans[to] || from === to) return
    const [page] = this.scans.splice(from, 1)
    this.scans.splice(to, 0, page)
    this.selectedPage = this.scans.indexOf(selected)
    this.syncGallery()
    this.syncSelection()
  },

  moveSelectedPage(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if ((direction !== -1 && direction !== 1) || this.data.busy || this.pageDrag) return
    const next = this.selectedPage + direction
    if (!this.scans[next]) return
    this.relocatePage(this.selectedPage, next)
    this.setData({ deleteArmed: -1, thumbAnchor: '' }, () => {
      const page = this.current()
      if (page && !this.closed) this.setData({ thumbAnchor: `scan-page-${page.id}` })
    })
  },

  removePage(event) {
    const page = this.current()
    if (!page || this.data.busy || this.pageDrag || Number(event.currentTarget.dataset.id) !== page.id) return
    if (this.data.deleteArmed !== page.id) {
      this.setData({ deleteArmed: page.id })
      return
    }
    this.scans.splice(this.selectedPage, 1)
    this.selectedPage = Math.max(0, Math.min(this.selectedPage, this.scans.length - 1))
    this.setData({
      candidate: '', deleteArmed: -1, thumbAnchor: this.scans.length ? `scan-page-${this.current()?.id}` : '',
      ...(this.scans.length ? {} : { previewHeight: this.expandedHeight }),
    })
    this.syncGallery()
    this.syncSelection(true)
    this.paint()
    this.releaseUnusedImages()
    void this.refreshPreview()
  },

  openExport() {
    if (!this.scans.length || this.data.busy || this.pageDrag) return
    const pages = this.scans.map((page) => ({
      ...renderOptions(page), corners: copyCorners(page.corners), enhanced: page.enhanced,
      preview: page.previewRevision === page.revision ? page.preview : undefined,
    }))
    const session: PdfSession = { pages, selected: this.selectedPage }
    this.setData({ busy: '正在打开导出页', deleteArmed: -1 })
    wx.navigateTo({
      url: '/pages/export/index',
      success: ({ eventChannel }) => eventChannel.emit('scanExport', session),
      fail: () => notify('无法打开 PDF 导出，请重试。'),
      complete: () => { if (!this.closed) this.setData({ busy: '' }) },
    })
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
        const options = exportQualities[1]
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
      if (generated) removeFile(generated)
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
    const turn = ++this.cloudTurn
    this.setData({ cloudRunning: true, busy: '正在准备当前页', candidate: '', deleteArmed: -1 }, () => this.releaseUnusedImages())
    let input: string | undefined
    const cancelled = () => this.closed || turn !== this.cloudTurn || this.current() !== page || page.revision !== revision
    try {
      const result = await renderPage({
        ...renderOptions(page), mode: 'color', enhance: false, denoise: false, dewarp: false,
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
      if (cancelled()) removeFile(output.imagePath)
      else {
        this.generatedImages.add(output.imagePath)
        this.setData({ candidate: output.imagePath })
      }
    } catch (error) {
      if (!cancelled()) notify(errorText(error, '云端增强失败，你可以继续使用本地扫描。'))
    } finally {
      if (input) removeFile(input)
      if (!this.closed && turn === this.cloudTurn) this.setData({ cloudRunning: false, busy: '' })
    }
  },

  cancelCloud() {
    if (this.data.cloudRunning) {
      this.cloudTurn += 1
      this.setData({ busy: '', cloudRunning: false })
    }
  },

  useCandidate() {
    const page = this.current()
    if (!page || !this.data.candidate || this.data.busy) return
    page.enhanced = this.data.candidate
    this.setData({ candidate: '' }, () => this.releaseUnusedImages())
    this.syncSelection(true)
    this.paint()
  },

  dismissCandidate() {
    this.setData({ candidate: '' }, () => this.releaseUnusedImages())
  },

  onUnload() {
    this.closed = true
    this.stopPageDrag()
    for (const path of this.generatedImages) removeFile(path)
    this.generatedImages.clear()
  },
})
