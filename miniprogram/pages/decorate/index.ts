import { decorateImage } from '../../image'
import type { ImageDecorations, MosaicRegion, Watermark } from '../../image'
import type { DecorateSession, DecorationEdits } from './session'

type Tool = 'mosaic' | 'watermark'
type MarkKind = 'none' | 'text' | 'image'
type SliderName = 'mosaicSize' | 'opacity' | 'size' | 'angle' | 'spacing'
type Touch = WechatMiniprogram.TouchEvent
type EditorMosaic = MosaicRegion & { key: number }

interface ImagePoint {
  x: number
  y: number
}

interface DrawGesture {
  touchId: number
  index: number
  first: { clientX: number; clientY: number }
  bounds?: { left: number; top: number }
  previous?: MosaicRegion
  resize: boolean
}

interface EditorData {
  ready: boolean
  allowMosaic: boolean
  preview: string
  width: number
  height: number
  tool: Tool
  mosaics: EditorMosaic[]
  selectedMosaic: number
  draftMosaic: MosaicRegion | null
  mosaicSize: number
  kind: MarkKind
  layout: 'single' | 'tile'
  text: string
  logo: string
  color: string
  opacity: number
  size: number
  angle: number
  spacing: number
  stagger: boolean
  position: ImagePoint
  busy: string
  error: string
  applying: boolean
}

interface EditorActions {
  session?: DecorateSession
  ownedLogos: Set<string>
  gesture?: DrawGesture
  rendered?: string
  renderRevision: number
  rendering: boolean
  applied?: ReturnType<typeof setTimeout>
  closed: boolean
  onLoad(): void
  onUnload(): void
  openSession(session: DecorateSession): Promise<void>
  chooseTool(event: Touch): void
  selectKind(event: Touch): void
  selectLayout(event: Touch): void
  setText(event: WechatMiniprogram.Input): void
  chooseLogo(): Promise<void>
  changeSlider(event: { currentTarget: { dataset: { name?: string } }; detail: { value: number } }): void
  toggleStagger(event: WechatMiniprogram.SwitchChange): void
  chooseColor(event: Touch): void
  startGesture(event: Touch): void
  moveGesture(event: Touch): void
  endGesture(event: Touch): void
  cancelGesture(): void
  selectMosaic(event: Touch): void
  removeMosaic(): void
  schedulePreview(): void
  renderPreview(): Promise<void>
  apply(): void
  cancel(): void
}

const colors = ['#ffffff', '#293338', '#a63238', '#2b6759']
const defaultColor = colors[1]
let logoSequence = 0
let mosaicSequence = 0

function removeFile(filePath: string): void {
  wx.getFileSystemManager().unlink({ filePath, fail: () => undefined })
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value))
}

function pickLogo(): Promise<string | undefined> {
  return new Promise((resolve, reject) => wx.chooseMedia({
    count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'],
    success: ({ tempFiles }) => resolve(tempFiles[0]?.tempFilePath),
    fail: (error) => error.errMsg.includes('cancel') ? resolve(undefined) : reject(error),
  }))
}

function copyLogo(srcPath: string): Promise<string> {
  const extension = srcPath.match(/\.[a-zA-Z\d]{2,5}(?=$|\?)/)?.[0] ?? '.png'
  const destPath = `${wx.env.USER_DATA_PATH}/scan-logo-${Date.now()}-${logoSequence++}${extension}`
  return new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({
    srcPath, destPath, success: () => resolve(destPath), fail: reject,
  }))
}

function draftFromData(data: EditorData): ImageDecorations {
  const mosaics = data.mosaics.map(({ key: _key, ...region }) => region)
  const shared = {
    layout: data.layout, opacity: data.opacity / 100, size: data.size / 100,
    angle: data.angle, x: data.position.x, y: data.position.y,
    stagger: data.stagger, spacing: data.spacing / 100,
  }
  let watermark: Watermark | undefined
  if (data.kind === 'text' && data.text.trim()) {
    watermark = { ...shared, kind: 'text', text: data.text.trim(), color: data.color }
  } else if (data.kind === 'image' && data.logo) {
    watermark = { ...shared, kind: 'image', imagePath: data.logo }
  }
  return { mosaics, watermarks: watermark ? [watermark] : [] }
}

function imageBounds(data: EditorData, gesture: DrawGesture, clientX: number, clientY: number): ImagePoint | undefined {
  if (!gesture.bounds) return
  return {
    x: clamp((clientX - gesture.bounds.left) / data.width),
    y: clamp((clientY - gesture.bounds.top) / data.height),
  }
}

function failure(message: string): void {
  wx.showToast({ title: message, icon: 'none' })
}

Page<EditorData, EditorActions>({
  data: {
    ready: false, allowMosaic: true, preview: '', width: 0, height: 0, tool: 'mosaic',
    mosaics: [], selectedMosaic: -1, draftMosaic: null, mosaicSize: 3, kind: 'none', layout: 'single',
    text: '', logo: '', color: defaultColor, opacity: 45, size: 12, angle: -30, spacing: 10,
    stagger: true, position: { x: 0.5, y: 0.5 }, busy: '', error: '', applying: false,
  },
  ownedLogos: new Set(),
  renderRevision: 0,
  rendering: false,
  closed: false,

  onLoad() {
    this.ownedLogos = new Set()
    const channel = this.getOpenerEventChannel?.()
    channel?.on?.('decoratePage', (session: DecorateSession) => void this.openSession(session))
    channel?.on?.('decorateAccepted', (paths: string[]) => {
      if (this.closed || !this.data.applying) return
      for (const path of paths) this.ownedLogos.delete(path)
      if (this.applied !== undefined) clearTimeout(this.applied)
      wx.navigateBack()
    })
  },

  async openSession(session) {
    if (this.closed || this.session) return
    this.session = session
    this.setData({ busy: '正在读取页面' })
    try {
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) =>
        wx.getImageInfo({ src: session.imagePath, success: resolve, fail: reject }))
      if (this.closed) return
      const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const scale = Math.min(window.windowWidth * (650 / 750) / info.width, window.windowHeight * 0.5 / info.height)
      const mosaics = (session.decorations?.mosaics ?? []).map((region) => ({ ...region, key: mosaicSequence++ }))
      const watermark = session.decorations?.watermarks?.[0]
      this.setData({
        ready: true, allowMosaic: session.allowMosaic, busy: '',
        width: Math.max(2, Math.round(scale * info.width)), height: Math.max(2, Math.round(scale * info.height)),
        mosaics, selectedMosaic: -1, tool: !session.allowMosaic || (watermark && !mosaics.length) ? 'watermark' : 'mosaic',
        kind: watermark?.kind ?? 'none', layout: watermark?.layout ?? 'single',
        text: watermark?.kind === 'text' ? watermark.text : '',
        logo: watermark?.kind === 'image' ? watermark.imagePath : '',
        color: watermark?.kind === 'text' ? watermark.color ?? defaultColor : defaultColor,
        opacity: Math.round((watermark?.opacity ?? 0.45) * 100), size: Math.round((watermark?.size ?? 0.12) * 100),
        angle: watermark?.angle ?? -30, spacing: Math.round((watermark?.spacing ?? 0.1) * 100),
        stagger: watermark?.stagger ?? true,
        position: { x: watermark?.x ?? 0.5, y: watermark?.y ?? 0.5 },
      })
      this.schedulePreview()
    } catch {
      if (!this.closed) this.setData({ busy: '', error: '无法读取页面。请返回扫描页重试。' })
    }
  },

  chooseTool(event) {
    const tool: unknown = event.currentTarget.dataset.tool
    if ((tool === 'mosaic' && this.data.allowMosaic) || tool === 'watermark') this.setData({ tool })
  },

  selectKind(event) {
    const kind: unknown = event.currentTarget.dataset.kind
    if (kind !== 'none' && kind !== 'text' && kind !== 'image') return
    this.setData({ kind })
    this.schedulePreview()
  },

  selectLayout(event) {
    const layout: unknown = event.currentTarget.dataset.layout
    if (layout !== 'single' && layout !== 'tile') return
    this.setData({ layout })
    this.schedulePreview()
  },

  setText(event) {
    this.setData({ text: event.detail.value })
  },

  async chooseLogo() {
    if (this.data.applying) return
    try {
      const picked = await pickLogo()
      if (!picked || this.closed) return
      const logo = await copyLogo(picked)
      if (this.closed) {
        removeFile(logo)
        return
      }
      this.ownedLogos.add(logo)
      this.setData({ logo })
      this.schedulePreview()
    } catch {
      if (!this.closed) failure('无法导入水印图片。')
    }
  },

  changeSlider(event) {
    const name = event.currentTarget.dataset.name as SliderName | undefined
    if (!name || !['mosaicSize', 'opacity', 'size', 'angle', 'spacing'].includes(name)) return
    const value = event.detail.value
    if (name === 'mosaicSize') {
      const selected = this.data.selectedMosaic
      this.setData({ mosaicSize: value })
      if (this.data.mosaics[selected]) {
        this.setData({ [`mosaics[${selected}].blockSize`]: value / 100 })
        this.schedulePreview()
      }
      return
    }
    this.setData({ [name]: value })
    this.schedulePreview()
  },

  toggleStagger(event) {
    this.setData({ stagger: event.detail.value })
    this.schedulePreview()
  },

  chooseColor(event) {
    const color: unknown = event.currentTarget.dataset.color
    if (typeof color !== 'string' || !colors.includes(color)) return
    this.setData({ color })
    this.schedulePreview()
  },

  startGesture(event) {
    if (this.gesture || this.data.applying || !this.data.ready) return
    if (this.data.tool === 'watermark' && (this.data.layout !== 'single' || this.data.kind === 'none')) return
    const touch = event.changedTouches[0]
    if (!touch) return
    const fromMask = event.target.dataset.mask
    const index = fromMask === undefined || this.data.tool !== 'mosaic' ? -1 : Number(fromMask)
    const previous = this.data.mosaics[index]
    const gesture: DrawGesture = { touchId: touch.identifier, index, first: touch, previous, resize: Boolean(event.target.dataset.resize) }
    this.gesture = gesture
    if (previous) this.setData({ selectedMosaic: index, mosaicSize: Math.round((previous.blockSize ?? 0.025) * 100) })
    this.createSelectorQuery().select('.decorate-stage').boundingClientRect((bounds) => {
      if (this.gesture !== gesture || !bounds || Array.isArray(bounds)) return
      gesture.bounds = bounds
    }).exec()
  },

  moveGesture(event) {
    const gesture = this.gesture
    const touch = gesture && event.touches.find(({ identifier }) => identifier === gesture.touchId)
    if (!gesture || !touch) return
    const last = imageBounds(this.data, gesture, touch.clientX, touch.clientY)
    if (!last) return
    if (this.data.tool === 'watermark') {
      this.setData({ position: last })
      return
    }
    const first = imageBounds(this.data, gesture, gesture.first.clientX, gesture.first.clientY)
    if (!first) return
    const previous = gesture.previous
    const dx = last.x - first.x
    const dy = last.y - first.y
    let draft: MosaicRegion
    if (!previous) {
      draft = { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width: Math.abs(dx), height: Math.abs(dy), blockSize: this.data.mosaicSize / 100 }
    } else if (gesture.resize) {
      draft = { ...previous, width: clamp(previous.width + dx, 0.01, 1 - previous.x), height: clamp(previous.height + dy, 0.01, 1 - previous.y) }
    } else {
      draft = { ...previous, x: clamp(previous.x + dx, 0, 1 - previous.width), y: clamp(previous.y + dy, 0, 1 - previous.height) }
    }
    this.setData({ draftMosaic: draft })
  },

  endGesture(event) {
    const gesture = this.gesture
    const touch = gesture && event.changedTouches.find(({ identifier }) => identifier === gesture.touchId)
    if (!gesture || !touch) return
    this.gesture = undefined
    if (this.data.tool === 'watermark') {
      const position = imageBounds(this.data, gesture, touch.clientX, touch.clientY)
      if (position) {
        this.setData({ position })
        this.schedulePreview()
      }
      return
    }
    const region = this.data.draftMosaic
    this.setData({ draftMosaic: null })
    if (!region || region.width < 0.01 || region.height < 0.01) return
    const mosaics = this.data.mosaics.slice()
    const index = gesture.index < 0 ? mosaics.length : gesture.index
    if (index >= 24) {
      failure('每页最多添加 24 个马赛克区域。')
      return
    }
    mosaics[index] = { ...region, key: mosaics[index]?.key ?? mosaicSequence++ }
    this.setData({ mosaics, selectedMosaic: index })
    this.schedulePreview()
  },

  cancelGesture() {
    this.gesture = undefined
    this.setData({ draftMosaic: null })
  },

  selectMosaic(event) {
    const selected = Number(event.currentTarget.dataset.index)
    const region = this.data.mosaics[selected]
    if (region) this.setData({ selectedMosaic: selected, mosaicSize: Math.round((region.blockSize ?? 0.025) * 100) })
  },

  removeMosaic() {
    const selected = this.data.selectedMosaic
    if (!this.data.mosaics[selected]) return
    this.setData({ mosaics: this.data.mosaics.filter((_item, index) => index !== selected), selectedMosaic: -1 })
    this.schedulePreview()
  },

  schedulePreview() {
    this.renderRevision += 1
    void this.renderPreview()
  },

  async renderPreview() {
    const session = this.session
    if (!session || this.closed || !this.data.ready || this.rendering) return
    const revision = this.renderRevision
    const decorations = draftFromData(this.data)
    const previous = this.rendered
    if (!decorations.mosaics?.length && !decorations.watermarks?.length) {
      this.rendered = undefined
      this.setData({ preview: session.imagePath, busy: '', error: '' }, () => {
        if (previous) removeFile(previous)
      })
      return
    }
    this.rendering = true
    this.setData({ busy: '正在更新预览', error: '' })
    try {
      const result = await decorateImage({ imagePath: session.imagePath, decorations, quality: 'preview' })
      if (this.closed || revision !== this.renderRevision) {
        if (result.imagePath !== session.imagePath) removeFile(result.imagePath)
        return
      }
      this.rendered = result.imagePath === session.imagePath ? undefined : result.imagePath
      this.setData({ preview: result.imagePath, busy: '' }, () => {
        if (previous && previous !== result.imagePath) removeFile(previous)
      })
    } catch {
      if (!this.closed && revision === this.renderRevision) {
        this.setData({ busy: '', error: '无法生成编辑预览。请调整标记或重试。' })
      }
    } finally {
      this.rendering = false
      if (!this.closed && revision !== this.renderRevision) void this.renderPreview()
    }
  },

  apply() {
    if (!this.data.ready || this.data.applying || this.data.busy || this.data.error) return
    if (this.data.kind === 'text' && !this.data.text.trim()) {
      failure('请输入水印文字。')
      return
    }
    if (this.data.kind === 'image' && !this.data.logo) {
      failure('请先选择水印图片。')
      return
    }
    const channel = this.getOpenerEventChannel?.()
    if (!channel?.emit) return
    const decorations = draftFromData(this.data)
    const used = (decorations.watermarks ?? []).filter((item) => item.kind === 'image').map((item) => item.imagePath)
    const edits: DecorationEdits = { decorations, ownedLogos: used.filter((path) => this.ownedLogos.has(path)) }
    this.setData({ applying: true })
    this.applied = setTimeout(() => {
      if (!this.closed) {
        this.setData({ applying: false })
        failure('无法保存编辑。请返回扫描页后重试。')
      }
    }, 1500)
    channel.emit('decorateApply', edits)
  },

  cancel() {
    wx.navigateBack()
  },

  onUnload() {
    this.closed = true
    if (this.applied !== undefined) clearTimeout(this.applied)
    if (this.session?.temporary) removeFile(this.session.imagePath)
    if (this.rendered) removeFile(this.rendered)
    for (const path of this.ownedLogos) removeFile(path)
    this.ownedLogos.clear()
  },
})
