import { detectQuad, prepareImage, renderPage } from '../../image'
import type { ImageMode, Quad, Rotation } from '../../image'
import { cloudEnabled, runCloudEnhancement } from '../../services/cloud'
import type { CloudOperation } from '../../services/cloud'
import { exportQualities } from '../export/session'
import type { ExportPage, PdfSession, PreviewImage } from '../export/session'
import { edgeStyles, fitImage, fitRotatedImageStyle, fullImageCorners, isValidCrop, orientCorners } from './geometry'

const MAX_PAGES = 30
const TILE_CARD_WIDTH = 158
const TILE_CARD_HEIGHT = 228
const TILE_STRIDE = TILE_CARD_WIDTH + 15
const TILE_PHOTO_WIDTH = 140
const TILE_PHOTO_HEIGHT = 158
const DRAG_HOLD_MS = 300
const SWAP_DURATION = 150
const THUMB_PROGRESS_MAX = 1000
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
  preview?: PreviewImage
  enhanced?: string
}

interface PagePress {
  id: number
  touchId: number
  from: number
  x: number
  y: number
  scroll: number
  currentX: number
  currentY: number
}

interface PageDrag {
  press: PagePress
  startScroll: number
  scroll: number
  x: number
  y: number
  gripX: number
  gripY: number
  target: number
  originLeft: number
  originTop: number
  bounds?: { left: number; right: number; width: number }
  timer?: ReturnType<typeof setInterval>
  settling?: boolean
  settleTimer?: ReturnType<typeof setTimeout>
}

interface ButtonSwap {
  from: number
  to: number
  scroll: number
  timer?: ReturnType<typeof setTimeout>
}

interface Thumbnail {
  id: number
  source: string
  width: number
  height: number
  photoStyle: string
  lines: Array<{ id: number; style: string }>
}

interface DragGhost extends Thumbnail {
  number: number
  left: number
  top: number
}

interface PreviewLayer {
  path: string
  style: string
  visible: boolean
}

interface ScannerData {
  pages: Thumbnail[]
  pageCount: number
  selected: number
  source: string
  previewLayers: PreviewLayer[]
  previewHeight: number
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
  dragFrom: number
  dragTarget: number
  dragNeighborShift: number
  dragSettling: boolean
  dragGhost: DragGhost | null
  swapFrom: number
  swapTo: number
  swapShift: number
  thumbTrackShift: number
  thumbScrollLeft: number
  thumbAnchor: string
  thumbMaxOffset: number
  thumbProgress: number
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
  previewWidth: number
  actualThumbScroll: number
  thumbViewportWidth: number
  thumbScrubbing: boolean
  pagePress?: PagePress
  pagePressTimer?: ReturnType<typeof setTimeout>
  pageDrag?: PageDrag
  buttonSwap?: ButtonSwap
  pendingMoves: Array<-1 | 1>
  suppressTapUntil: number
  closed: boolean
  cloudTurn: number
  takePhoto(): void
  showImportOptions(): void
  addPages(source: ImageSource): Promise<void>
  current(): ScanPage | undefined
  galleryPages(): Thumbnail[]
  syncGallery(): void
  syncSelection(resetOriginal?: boolean): void
  display(path?: string, style?: string): void
  paint(): void
  finishPreviewLoad(event: WechatMiniprogram.BaseEvent): void
  failPreviewLoad(event: WechatMiniprogram.BaseEvent): void
  releaseUnusedImages(): void
  refreshPreview(): Promise<void>
  invalidate(page: ScanPage): void
  selectPage(event: WechatMiniprogram.TouchEvent): void
  activatePage(index: number, scrollToPage?: boolean): void
  changePage(event: WechatMiniprogram.TouchEvent): void
  onThumbnailsScroll(event: { detail: { scrollLeft: number } }): void
  beginThumbScrub(): void
  scrubThumbnails(event: { detail: { value: number } }): void
  finishThumbScrub(event: { detail: { value: number } }): void
  endThumbTouch(): void
  cancelThumbScrub(): void
  rememberPageTouch(event: WechatMiniprogram.TouchEvent): void
  startPageDrag(press: PagePress): void
  updatePageDrag(): void
  movePageDrag(event: WechatMiniprogram.TouchEvent): void
  endPageDrag(event: WechatMiniprogram.TouchEvent): void
  cancelPageDrag(event?: WechatMiniprogram.TouchEvent): void
  stopPageDrag(commit?: boolean): void
  insertPage(from: number, to: number, reset: Partial<ScannerData>, applied?: () => void): void
  moveSelectedPage(event: WechatMiniprogram.TouchEvent): void
  startButtonSwap(): void
  finishButtonSwap(continueQueued: boolean): void
  openCrop(): void
  closeCrop(): void
  applyCrop(event: { detail: { corners: Quad; rotation: Rotation } }): void
  rotate(): void
  rotatePage(page: ScanPage, rotation: Rotation): void
  restoreCrop(): void
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
  syncWorkspaceSize(window: { windowWidth: number; windowHeight: number }): void
  onLoad(): void
  onResize(event: { size: { windowWidth: number; windowHeight: number } }): void
  onHide(): void
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

function previewRenderRotation(page: ScanPage): Rotation {
  return page.dewarp ? page.rotation : 0
}

function hasCurrentPreview(page: ScanPage): boolean {
  return page.previewRevision === page.revision && page.preview?.rotation === previewRenderRotation(page)
}

function scrollProgress(offset: number, maxOffset: number): number {
  return maxOffset > 0 ? Math.round(Math.max(0, Math.min(1, offset / maxOffset)) * THUMB_PROGRESS_MAX) : 0
}

Page<ScannerData, ScannerActions>({
  data: {
    pages: [], pageCount: 0, selected: 0, source: '', previewLayers: [], previewHeight: 0,
    showOriginal: false, hasEnhanced: false, autoDetected: false, partialDetected: false,
    cornerConfidences: [0, 0, 0, 0], mode: 'color', enhance: true, denoise: true, dewarp: false,
    cropOpen: false, cropWidth: 0, cropHeight: 0, cropRotation: 0, corners: fullImageCorners, modes,
    deleteArmed: -1, dragId: -1, dragFrom: -1, dragTarget: -1, dragNeighborShift: 0, dragSettling: false, dragGhost: null,
    swapFrom: -1, swapTo: -1, swapShift: 0,
    thumbTrackShift: 0, thumbScrollLeft: 0, thumbAnchor: '', thumbMaxOffset: 0, thumbProgress: 0,
    busy: '', needsAlbumAccess: false,
    cloudEnabled, cloudRunning: false, candidate: '',
  },
  scans: [],
  currentId: 0,
  selectedPage: 0,
  generatedImages: new Set(),
  rpx: 0.5,
  previewWidth: 0,
  actualThumbScroll: 0,
  thumbViewportWidth: 0,
  thumbScrubbing: false,
  pendingMoves: [],
  suppressTapUntil: 0,
  closed: false,
  cloudTurn: 0,

  onLoad() {
    this.scans = []
    this.generatedImages = new Set()
    this.pendingMoves = []
    this.syncWorkspaceSize(wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
  },

  syncWorkspaceSize(window) {
    this.rpx = window.windowWidth / 750
    this.previewWidth = window.windowWidth - 40 * this.rpx
    this.thumbViewportWidth = window.windowWidth - 90 * this.rpx
    this.setData({ previewHeight: Math.round(window.windowHeight * 0.4) })
  },

  takePhoto() {
    void this.addPages('camera')
  },

  showImportOptions() {
    if (this.data.busy || this.pageDrag || this.buttonSwap) return
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
    if (this.data.busy || this.pageDrag || this.buttonSwap) return
    const openSlots = MAX_PAGES - this.scans.length
    if (openSlots <= 0) {
      notify(`当前文档最多添加 ${MAX_PAGES} 页。`)
      return
    }
    const opening = { camera: '正在打开相机', album: '正在打开相册', chat: '正在打开聊天文件' }
    this.setData({ busy: opening[source], deleteArmed: -1 })
    const start = this.scans.length
    let rejected = 0
    let skipCrop = false
    try {
      const paths = await selectImages(source, source === 'camera' ? 1 : Math.min(9, openSlots))
      skipCrop = paths.length > 1
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
        if (!skipCrop || start > 0) this.paint()
      }
      if (rejected) notify(`${rejected} 张图片读取失败，请重试。`)
    } catch (error) {
      notify(errorText(error, '无法读取图片，请检查相机或相册权限。'))
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
    if (!this.closed && this.scans.length > start) {
      if (skipCrop) await this.refreshPreview()
      else this.openCrop()
    }
  },

  current() {
    return this.scans[this.selectedPage]
  },

  galleryPages() {
    return this.scans.map((page) => {
      const swapSides = page.rotation === 90 || page.rotation === 270
      const imageWidth = swapSides ? page.height : page.width
      const imageHeight = swapSides ? page.width : page.height
      const scale = Math.min(TILE_PHOTO_WIDTH * this.rpx / imageWidth, TILE_PHOTO_HEIGHT * this.rpx / imageHeight)
      const width = imageWidth * scale
      const height = imageHeight * scale
      return {
        id: page.id, source: page.source, width, height,
        photoStyle: `width:${page.width * scale}px;height:${page.height * scale}px;transform:translate(-50%,-50%) rotate(${page.rotation}deg)`,
        lines: edgeStyles(orientCorners(page.corners, page.rotation), width, height).map((style, id) => ({ id, style })),
      }
    })
  },

  syncGallery() {
    if (this.closed) return
    const pages = this.galleryPages()
    const thumbMaxOffset = Math.max(0, pages.length * TILE_STRIDE * this.rpx - this.thumbViewportWidth)
    const thumbScrollLeft = Math.min(this.data.thumbScrollLeft, Math.round(thumbMaxOffset))
    this.actualThumbScroll = Math.min(this.actualThumbScroll, thumbMaxOffset)
    this.setData({
      pages, pageCount: pages.length, thumbMaxOffset, thumbScrollLeft,
      thumbProgress: scrollProgress(this.actualThumbScroll, thumbMaxOffset),
    })
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

  display(path, style = '') {
    const layers = this.data.previewLayers
    const visible = layers.find((layer) => layer.visible)
    if (!path || visible?.path === path) {
      if (layers.length && (layers.length !== 1 || !path || visible?.style !== style)) {
        this.setData({ previewLayers: path && visible ? [{ ...visible, style }] : [] }, () => this.releaseUnusedImages())
      }
      return
    }
    if (layers.some((layer) => layer.path === path && layer.style === style)) return
    const staged = { path, style, visible: false }
    this.setData({ previewLayers: visible ? [visible, staged] : [staged] }, () => this.releaseUnusedImages())
  },

  paint() {
    const page = this.current()
    if (!page) {
      this.display()
      return
    }
    if (this.data.showOriginal || page.enhanced) {
      this.display(this.data.showOriginal ? page.source : page.enhanced)
      return
    }
    const preview = page.preview ?? { imagePath: page.source, width: page.width, height: page.height, rotation: 0 }
    const angle = ((page.rotation - preview.rotation + 360) % 360) as Rotation
    this.display(preview.imagePath, fitRotatedImageStyle(preview.width, preview.height, angle, this.previewWidth, this.data.previewHeight))
  },

  finishPreviewLoad(event) {
    const path: unknown = event.currentTarget.dataset.path
    const ready = this.data.previewLayers.find((layer) => layer.path === path && !layer.visible)
    if (!ready) return
    this.setData({ previewLayers: [{ ...ready, visible: true }] }, () => this.releaseUnusedImages())
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
      if (page.preview) used.add(page.preview.imagePath)
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
    if (!page || hasCurrentPreview(page) || page.renderingRevision !== undefined || page.enhanced || this.data.cropOpen) return
    const revision = page.revision
    const rotation = previewRenderRotation(page)
    page.renderingRevision = revision
    try {
      const result = await renderPage({ ...renderOptions(page), rotation, quality: 'preview' })
      if (this.closed || !this.scans.includes(page) || revision !== page.revision || rotation !== previewRenderRotation(page)) {
        removeFile(result.imagePath)
        return
      }
      this.generatedImages.add(result.imagePath)
      page.preview = { ...result, rotation }
      page.previewRevision = revision
      if (this.current() === page && !this.data.showOriginal && !this.data.cropOpen) this.paint()
      else this.releaseUnusedImages()
    } catch (error) {
      if (this.current() === page && !this.closed && revision === page.revision && rotation === previewRenderRotation(page)) {
        this.paint()
        notify(errorText(error, '无法处理这张图片。请调整裁剪或重拍。'))
      }
    } finally {
      page.renderingRevision = undefined
      if (!this.closed && this.current() === page && (revision !== page.revision || rotation !== previewRenderRotation(page))) {
        void this.refreshPreview()
      }
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
    if (this.pageDrag || this.buttonSwap || this.suppressTapUntil > Date.now()) return
    const index = Number(event.currentTarget.dataset.index)
    if (index === this.selectedPage && this.data.deleteArmed >= 0) this.setData({ deleteArmed: -1 })
    else this.activatePage(index)
  },

  activatePage(index, scrollToPage = false) {
    if (this.data.busy || this.data.cropOpen || this.pageDrag || this.buttonSwap) return
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

  openCrop() {
    const page = this.current()
    if (!page || this.data.busy || this.pageDrag || this.buttonSwap) return
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
      page.rotation = rotation
      this.syncGallery()
      this.invalidate(page)
    } else if (rotationChanged) {
      this.rotatePage(page, rotation)
    } else {
      this.paint()
      void this.refreshPreview()
    }
  },

  rotate() {
    const page = this.current()
    if (!page || this.data.busy || this.pageDrag || this.buttonSwap) return
    this.rotatePage(page, ((page.rotation + 90) % 360) as Rotation)
  },

  rotatePage(page, rotation) {
    page.rotation = rotation
    page.enhanced = undefined
    this.setData({ candidate: '', deleteArmed: -1 }, () => this.releaseUnusedImages())
    this.syncGallery()
    this.syncSelection()
    this.paint()
    void this.refreshPreview()
  },

  restoreCrop() {
    const page = this.current()
    if (!page || this.data.busy || this.pageDrag || this.buttonSwap) return
    const cropChanged = page.corners.some((point, index) => point.x !== fullImageCorners[index].x || point.y !== fullImageCorners[index].y)
    if (!cropChanged && !page.autoDetected) return
    page.corners = copyCorners(fullImageCorners)
    page.autoDetected = false
    page.cornerConfidences = [0, 0, 0, 0]
    if (cropChanged) {
      this.syncGallery()
      this.invalidate(page)
    } else this.syncSelection()
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
    if (this.pagePress && !this.pageDrag && Math.abs(this.pagePress.scroll - event.detail.scrollLeft) > 4) {
      this.stopPageDrag()
    }
    this.actualThumbScroll = Math.max(0, Math.min(this.data.thumbMaxOffset, event.detail.scrollLeft))
    if (this.pageDrag) this.updatePageDrag()
    else if (!this.thumbScrubbing) {
      const thumbProgress = scrollProgress(this.actualThumbScroll, this.data.thumbMaxOffset)
      if (thumbProgress !== this.data.thumbProgress) this.setData({ thumbProgress })
    }
  },

  beginThumbScrub() {
    if (this.pageDrag || !this.data.thumbMaxOffset) return
    this.stopPageDrag()
    this.thumbScrubbing = true
    this.setData({ thumbAnchor: '', thumbScrollLeft: Math.round(this.actualThumbScroll) })
  },

  scrubThumbnails(event) {
    if (this.pageDrag || !this.data.thumbMaxOffset || !Number.isFinite(event.detail.value)) return
    if (!this.thumbScrubbing) this.beginThumbScrub()
    const thumbProgress = Math.max(0, Math.min(THUMB_PROGRESS_MAX, Math.round(event.detail.value)))
    const thumbScrollLeft = Math.round(this.data.thumbMaxOffset * thumbProgress / THUMB_PROGRESS_MAX)
    this.setData({ thumbProgress, thumbScrollLeft })
  },

  finishThumbScrub(event) {
    this.scrubThumbnails(event)
    this.thumbScrubbing = false
  },

  endThumbTouch() {
    this.thumbScrubbing = false
  },

  cancelThumbScrub() {
    if (!this.thumbScrubbing) return
    this.thumbScrubbing = false
    this.setData({ thumbProgress: scrollProgress(this.actualThumbScroll, this.data.thumbMaxOffset) })
  },

  rememberPageTouch(event) {
    if (this.pageDrag) return
    this.stopPageDrag()
    this.suppressTapUntil = 0
    if (event.target?.dataset?.deleteControl || event.touches.length !== 1 || this.data.busy || this.buttonSwap || this.thumbScrubbing || this.scans.length < 2) return
    const touch = event.changedTouches[0]
    const from = Number(event.currentTarget.dataset.index)
    const page = this.scans[from]
    if (!touch || !page) return
    const press: PagePress = {
      id: page.id, from, touchId: touch.identifier, x: touch.clientX, y: touch.clientY,
      scroll: this.actualThumbScroll, currentX: touch.clientX, currentY: touch.clientY,
    }
    this.pagePress = press
    this.pagePressTimer = setTimeout(() => {
      this.pagePressTimer = undefined
      if (this.pagePress === press) this.startPageDrag(press)
    }, DRAG_HOLD_MS)
  },

  startPageDrag(press) {
    const { from, currentX: x, currentY: y } = press
    const tile = this.data.pages[from]
    if (!tile || press.id !== tile.id || this.pageDrag || this.buttonSwap || this.closed || this.data.busy || this.data.cropOpen) {
      this.stopPageDrag()
      return
    }
    const drag: PageDrag = {
      press, startScroll: this.actualThumbScroll, scroll: this.actualThumbScroll,
      x, y, gripX: TILE_CARD_WIDTH * this.rpx / 2, gripY: TILE_CARD_HEIGHT * this.rpx / 2, target: from,
      originLeft: press.x - TILE_CARD_WIDTH * this.rpx / 2, originTop: press.y - TILE_CARD_HEIGHT * this.rpx / 2,
    }
    this.pageDrag = drag
    this.setData({
      dragId: press.id, dragFrom: from, dragTarget: from, dragNeighborShift: 0, deleteArmed: -1, thumbAnchor: '',
      dragGhost: { ...tile, number: from + 1, left: x - drag.gripX, top: y - drag.gripY },
      thumbScrollLeft: Math.round(drag.scroll),
    })
    const query = this.createSelectorQuery()
    query.select(`#scan-page-${press.id}`).boundingClientRect((bounds) => {
      if (this.pageDrag !== drag || !bounds || Array.isArray(bounds)) return
      drag.originLeft = bounds.left
      drag.originTop = bounds.top
      drag.gripX = Math.min(bounds.width, Math.max(0, press.x - bounds.left))
      drag.gripY = Math.min(bounds.height, Math.max(0, press.y - bounds.top))
      this.updatePageDrag()
    })
    query.select('.thumbnail-strip').boundingClientRect((bounds) => {
      if (this.pageDrag !== drag || !bounds || Array.isArray(bounds)) return
      drag.bounds = bounds
      this.thumbViewportWidth = bounds.width
      const thumbMaxOffset = Math.max(0, this.scans.length * TILE_STRIDE * this.rpx - bounds.width)
      this.setData({ thumbMaxOffset, thumbProgress: scrollProgress(drag.scroll, thumbMaxOffset) })
      drag.timer = setInterval(() => {
        const viewport = drag.bounds
        if (!viewport || this.pageDrag !== drag || Math.abs(drag.x - press.x) < 5) return
        const margin = 28
        const step = drag.x > viewport.right - margin ? 15 : drag.x < viewport.left + margin ? -15 : 0
        if (!step) return
        const next = Math.max(0, Math.min(this.data.thumbMaxOffset, drag.scroll + step))
        if (next === drag.scroll) return
        drag.scroll = next
        this.updatePageDrag()
      }, 65)
    })
    query.exec()
  },

  updatePageDrag() {
    const drag = this.pageDrag
    if (!drag) return
    if (drag.settling) {
      const shift = this.actualThumbScroll - drag.scroll
      if (shift !== this.data.thumbTrackShift) this.setData({ thumbTrackShift: shift })
      return
    }
    const delta = drag.x - drag.press.x + drag.scroll - drag.startScroll
    drag.target = Math.max(0, Math.min(this.scans.length - 1, drag.press.from + Math.round(delta / (TILE_STRIDE * this.rpx))))
    this.setData({
      dragTarget: drag.target,
      dragNeighborShift: Math.sign(drag.press.from - drag.target) * TILE_STRIDE * this.rpx,
      thumbTrackShift: this.actualThumbScroll - drag.scroll,
      thumbProgress: scrollProgress(drag.scroll, this.data.thumbMaxOffset),
      'dragGhost.left': drag.x - drag.gripX,
      'dragGhost.top': drag.y - drag.gripY,
    })
  },

  movePageDrag(event) {
    const press = this.pagePress
    if (press && !this.pageDrag && event.touches.length !== 1) {
      this.stopPageDrag()
      return
    }
    const touch = press && event.touches.find((point) => point.identifier === press.touchId)
    if (!press || !touch) return
    if (!this.pageDrag) {
      if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) this.stopPageDrag()
      else {
        press.currentX = touch.clientX
        press.currentY = touch.clientY
      }
      return
    }
    this.pageDrag.x = touch.clientX
    this.pageDrag.y = touch.clientY
    this.updatePageDrag()
  },

  endPageDrag(event) {
    const press = this.pagePress
    if (!press) return
    const touch = event.changedTouches.find((point) => point.identifier === press.touchId)
    if (!touch) return
    const drag = this.pageDrag
    if (!drag) {
      this.stopPageDrag()
      return
    }
    drag.x = touch.clientX
    drag.y = touch.clientY
    this.updatePageDrag()
    this.pagePress = undefined
    drag.settling = true
    if (drag.timer !== undefined) clearInterval(drag.timer)
    const left = drag.originLeft + (drag.target - press.from) * TILE_STRIDE * this.rpx + drag.startScroll - drag.scroll
    this.setData({ dragSettling: true, 'dragGhost.left': left, 'dragGhost.top': drag.originTop }, () => {
      if (this.pageDrag !== drag) return
      drag.settleTimer = setTimeout(() => {
        if (this.pageDrag === drag) this.stopPageDrag(true)
      }, SWAP_DURATION)
    })
  },

  cancelPageDrag(event) {
    if (this.pageDrag?.settling) return
    const press = this.pagePress
    const cancelled = event?.changedTouches
    if (press && cancelled?.length && !cancelled.some((touch) => touch.identifier === press.touchId)) return
    this.stopPageDrag()
  },

  stopPageDrag(commit = false) {
    const drag = this.pageDrag
    this.pagePress = undefined
    if (this.pagePressTimer !== undefined) clearTimeout(this.pagePressTimer)
    this.pagePressTimer = undefined
    if (!drag) return
    this.pageDrag = undefined
    this.suppressTapUntil = Date.now() + 300
    if (drag.timer !== undefined) clearInterval(drag.timer)
    if (drag.settleTimer !== undefined) clearTimeout(drag.settleTimer)
    if (this.closed) return
    const reset: Partial<ScannerData> = {
      dragId: -1, dragFrom: -1, dragTarget: -1, dragNeighborShift: 0, dragSettling: false, dragGhost: null,
      thumbTrackShift: 0, thumbScrollLeft: Math.round(drag.scroll), thumbProgress: scrollProgress(drag.scroll, this.data.thumbMaxOffset),
    }
    if (commit) this.insertPage(drag.press.from, drag.target, reset)
    else this.setData(reset)
  },

  insertPage(from, to, reset, applied) {
    const selected = this.current()
    if (!selected || !this.scans[from] || !this.scans[to] || from === to) {
      this.setData(reset, applied)
      return
    }
    const [source] = this.scans.splice(from, 1)
    this.scans.splice(to, 0, source)
    this.selectedPage = this.scans.indexOf(selected)
    this.setData({ ...reset, pages: this.galleryPages(), selected: this.selectedPage }, applied)
  },

  moveSelectedPage(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if ((direction !== -1 && direction !== 1) || this.data.busy || this.pageDrag) return
    if (this.pendingMoves.length < MAX_PAGES) this.pendingMoves.push(direction)
    this.startButtonSwap()
  },

  startButtonSwap() {
    if (this.closed || this.buttonSwap) return
    while (this.pendingMoves.length) {
      const direction = this.pendingMoves.shift()!
      const from = this.selectedPage
      const to = from + direction
      if (!this.scans[to]) continue
      this.stopPageDrag()
      const swap: ButtonSwap = { from, to, scroll: this.actualThumbScroll }
      this.buttonSwap = swap
      this.setData({ swapFrom: from, swapTo: to, swapShift: direction * TILE_STRIDE * this.rpx, deleteArmed: -1, thumbAnchor: '' }, () => {
        if (this.buttonSwap !== swap) return
        swap.timer = setTimeout(() => {
          if (this.buttonSwap === swap) this.finishButtonSwap(true)
        }, SWAP_DURATION)
      })
      return
    }
  },

  finishButtonSwap(continueQueued) {
    if (!continueQueued) this.pendingMoves = []
    const swap = this.buttonSwap
    if (!swap) return
    this.buttonSwap = undefined
    if (swap.timer !== undefined) clearTimeout(swap.timer)
    if (this.closed) return
    const anchor = continueQueued && !this.thumbScrubbing && Math.abs(this.actualThumbScroll - swap.scroll) < 1
    this.insertPage(swap.from, swap.to, { swapFrom: -1, swapTo: -1, swapShift: 0 }, () => {
      if (!continueQueued || this.closed) return
      this.startButtonSwap()
      const page = this.current()
      if (!this.buttonSwap && page && anchor && !this.thumbScrubbing) this.setData({ thumbAnchor: `scan-page-${page.id}` })
    })
  },

  removePage(event) {
    const page = this.current()
    if (!page || this.data.busy || this.pageDrag || this.buttonSwap || this.suppressTapUntil > Date.now() || Number(event.currentTarget.dataset.id) !== page.id) return
    if (this.data.deleteArmed !== page.id) {
      this.setData({ deleteArmed: page.id })
      return
    }
    this.scans.splice(this.selectedPage, 1)
    this.selectedPage = Math.max(0, Math.min(this.selectedPage, this.scans.length - 1))
    this.setData({
      candidate: '', deleteArmed: -1, thumbAnchor: this.scans.length ? `scan-page-${this.current()?.id}` : '',
    })
    this.syncGallery()
    this.syncSelection(true)
    this.paint()
    this.releaseUnusedImages()
    void this.refreshPreview()
  },

  openExport() {
    if (!this.scans.length || this.data.busy || this.pageDrag || this.buttonSwap) return
    const pages = this.scans.map((page) => ({
      ...renderOptions(page), corners: copyCorners(page.corners), enhanced: page.enhanced,
      preview: hasCurrentPreview(page) ? page.preview : undefined,
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
    if (!page || this.data.busy || this.pageDrag || this.buttonSwap) return
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

  onResize({ size }) {
    this.onHide()
    this.syncWorkspaceSize(size)
    this.syncGallery()
    this.paint()
  },

  onHide() {
    this.stopPageDrag(Boolean(this.pageDrag?.settling))
    this.finishButtonSwap(false)
    this.cancelThumbScrub()
  },

  onUnload() {
    this.closed = true
    this.stopPageDrag()
    this.finishButtonSwap(false)
    for (const path of this.generatedImages) removeFile(path)
    this.generatedImages.clear()
  },
})
