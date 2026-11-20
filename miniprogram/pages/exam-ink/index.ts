import { cloudEnabled, runExamInkApply, runExamInkCandidates } from '../../services/cloud'
import type { CloudStatus, ExamInkBox, ExamInkPlan, ExamInkPoint, ExamInkStroke } from '../../services/cloud'
import {
  boxStyle, clamp, clippedPoint, drawBox, inImage, moveBox, pointOnImage, resizeBox, similarity, stageGeometry, strokeStyles, zoomGeometry,
} from './geometry'
import type { Size, Stage } from './geometry'

type Tool = 'region' | 'erase' | 'protect' | 'pan'
type Status = 'pending' | 'accepted' | 'rejected'
type Touch = WechatMiniprogram.TouchEvent
type Position = { x: number; y: number }

interface InkSession { imagePath: string; temporary: boolean; canAdopt: boolean; number: number }
interface Region { id: number; box: ExamInkBox; style: string; status: Status; review: boolean }
interface StrokeView { id: number; kind: 'erase' | 'protect'; stroke: ExamInkStroke; styles: string[] }
interface InkState { regions: Region[]; strokes: StrokeView[] }

interface Gesture {
  tool: Tool
  id: number
  from: Position
  last: Position
  stage: Stage
  moved?: boolean
  box?: Region
  resize?: boolean
  bounds?: { left: number; top: number }
  draft?: ExamInkBox
  stroke: ExamInkPoint[]
  ended?: boolean
}

interface EditorData extends InkState {
  source: string
  result: string
  view: 'original' | 'result'
  showMarks: boolean
  pageNumber: number
  ready: boolean
  enabled: boolean
  canAdopt: boolean
  busy: string
  running: boolean
  error: string
  frame: Size
  stage: Stage
  zoom: number
  tool: Tool
  slider: number
  selected: number
  draftId: number
  draftBox: string
  draftStroke: string[]
  pending: number
  accepted: number
  canUndo: boolean
  canApply: boolean
}

interface EditorActions {
  session?: InkSession
  image?: Size
  closed: boolean
  turn: number
  sequence: number
  uploads: number
  confirming: boolean
  history: InkState[]
  saving?: string
  gesture?: Gesture
  onLoad(): void
  onUnload(): void
  openSession(session: InkSession): Promise<void>
  chooseTool(event: Touch): void
  selectView(event: Touch): void
  toggleMarks(): void
  changeZoom(event: Touch): void
  changeRadius(event: { detail: { value: number } }): void
  startGesture(event: Touch): void
  moveGesture(event: Touch): void
  endGesture(event: Touch): void
  cancelGesture(): void
  updateGesture(): void
  finishGesture(): void
  selectRegion(event: Touch): void
  reviewRegion(event: Touch): void
  editState(state: InkState, selected?: number): void
  undo(): void
  suggest(event: Touch): void
  preview(): void
  confirmRun(kind: 'local' | 'ai' | 'apply'): void
  run(kind: 'local' | 'ai' | 'apply', session: InkSession): Promise<void>
  cancelRun(): void
  save(): Promise<void>
  adopt(): void
}

const MAX_REGIONS = 64
const MAX_STROKES = 48
const MAX_POINTS = 384
const MAX_STROKE_POINTS = 64
const MAX_HISTORY = 20

const statusText: Record<CloudStatus, string> = {
  queued: '已上传，正在排队',
  running: '正在处理当前页',
  succeeded: '正在取回结果',
  failed: '正在读取任务状态',
}

function unlink(filePath?: string): void {
  if (filePath) wx.getFileSystemManager().unlink({ filePath, fail: () => undefined })
}

function toast(title: string): void {
  wx.showToast({ title, icon: 'none' })
}

function explain(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function summarize({ regions, strokes }: InkState) {
  const accepted = regions.filter(({ status }) => status === 'accepted').length
  return {
    accepted,
    pending: regions.filter(({ status }) => status === 'pending').length,
    canApply: accepted > 0 || strokes.some(({ kind }) => kind === 'erase'),
  }
}

function toPlan({ regions, strokes }: InkState): ExamInkPlan {
  return {
    regions: regions.filter(({ status }) => status === 'accepted').map(({ box }) => box),
    erase: strokes.filter(({ kind }) => kind === 'erase').map(({ stroke }) => stroke),
    protect: strokes.filter(({ kind }) => kind === 'protect').map(({ stroke }) => stroke),
  }
}

function brushBudget(strokes: StrokeView[]): number {
  return Math.max(0, MAX_POINTS - strokes.reduce((total, { stroke }) => total + stroke.points.length, 0))
}

function stateOf({ regions, strokes }: EditorData): InkState {
  return { regions, strokes }
}

Page<EditorData, EditorActions>({
  data: {
    source: '', result: '', view: 'original', showMarks: true, pageNumber: 0, ready: false, enabled: cloudEnabled, canAdopt: false,
    busy: '', running: false, error: '', frame: { width: 0, height: 0 }, stage: { width: 0, height: 0, left: 0, top: 0 },
    zoom: 1, tool: 'region', slider: 12, selected: -1, draftId: -1, draftBox: '', draftStroke: [],
    regions: [], strokes: [], pending: 0, accepted: 0, canUndo: false, canApply: false,
  },
  closed: false,
  turn: 0,
  sequence: 0,
  uploads: 0,
  confirming: false,
  history: [],

  onLoad() {
    this.history = []
    this.getOpenerEventChannel?.()?.on?.('examInkStart', (session: InkSession) => void this.openSession(session))
  },

  async openSession(session) {
    if (this.closed || this.session || !session?.imagePath) return
    this.session = session
    this.setData({ busy: '正在读取试卷' })
    try {
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) =>
        wx.getImageInfo({ src: session.imagePath, success: resolve, fail: reject }))
      if (this.closed) return
      if (info.width <= 0 || info.height <= 0) throw new Error('无法读取试卷尺寸。')
      this.image = { width: info.width, height: info.height }
      const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const frame = { width: Math.round(window.windowWidth * 0.88), height: Math.round(window.windowHeight * 0.48) }
      this.setData({
        source: session.imagePath, canAdopt: session.canAdopt, pageNumber: session.number, ready: true,
        frame, stage: stageGeometry(frame, this.image, 1),
      })
    } catch (error) {
      if (!this.closed) this.setData({ error: explain(error, '无法读取试卷，请返回扫描页重试。') })
    } finally {
      if (!this.closed) this.setData({ busy: '' })
    }
  },

  onUnload() {
    this.closed = true
    this.turn += 1
    if (this.session?.temporary && !this.uploads) unlink(this.session.imagePath)
    if (this.data.result !== this.saving) unlink(this.data.result)
  },

  chooseTool(event) {
    if (this.data.busy) return
    const tool: unknown = event.currentTarget.dataset.tool
    if (tool === 'region' || tool === 'erase' || tool === 'protect' || tool === 'pan') {
      this.cancelGesture()
      this.setData({ tool, view: tool === 'pan' ? this.data.view : 'original', showMarks: tool === 'pan' ? this.data.showMarks : true })
    }
  },

  selectView(event) {
    const view: unknown = event.currentTarget.dataset.view
    if (this.data.busy || (view !== 'original' && (view !== 'result' || !this.data.result))) return
    this.cancelGesture()
    this.setData({ view, showMarks: !this.data.result })
  },

  toggleMarks() {
    if (this.data.view === 'original' && !this.data.busy) this.setData({ showMarks: !this.data.showMarks })
  },

  changeZoom(event) {
    if (!this.image || this.data.busy) return
    const direction = Number(event.currentTarget.dataset.direction)
    if (direction !== -1 && direction !== 1) return
    const zoom = clamp(this.data.zoom + direction, 1, 4)
    this.cancelGesture()
    this.setData({ zoom, stage: zoomGeometry(this.data.frame, this.image, this.data.stage, zoom) })
  },

  changeRadius(event) {
    if (!this.gesture && !this.data.busy) this.setData({ slider: clamp(Number(event.detail.value) || 12, 3, 36) })
  },

  startGesture(event) {
    if (this.gesture || !this.image || !this.data.ready || this.data.busy || event.touches.length !== 1) return
    const touch = event.touches[0]
    const tool = this.data.view === 'result' || !this.data.showMarks ? 'pan' : this.data.tool
    const dataset = event.target.dataset ?? {}
    const box = tool === 'region' ? this.data.regions.find(({ id, status }) => id === Number(dataset.region) && status !== 'rejected') : undefined
    if (tool === 'erase' || tool === 'protect') {
      if (!brushBudget(this.data.strokes) || this.data.strokes.filter(({ kind }) => kind === tool).length >= MAX_STROKES) {
        toast('已达到画笔上限，可撤销后调整。')
        return
      }
    }
    const start = { x: touch.clientX, y: touch.clientY }
    const gesture: Gesture = {
      tool, id: touch.identifier, from: start, last: start, stage: this.data.stage, box,
      resize: Boolean(dataset.resize), stroke: [],
    }
    this.gesture = gesture
    if (box) this.setData({ selected: box.id })
    if (tool === 'pan') return
    this.createSelectorQuery().select('.ink-frame').boundingClientRect((bounds) => {
      if (this.gesture !== gesture || this.closed) return
      if (!bounds || Array.isArray(bounds)) return this.cancelGesture()
      gesture.bounds = { left: bounds.left, top: bounds.top }
      this.updateGesture()
      if (gesture.ended) this.finishGesture()
    }).exec()
  },

  moveGesture(event) {
    const gesture = this.gesture
    const touch = gesture && event.touches.find(({ identifier }) => identifier === gesture.id)
    if (!gesture || !touch) return
    gesture.last = { x: touch.clientX, y: touch.clientY }
    this.updateGesture()
  },

  endGesture(event) {
    const gesture = this.gesture
    const touch = gesture && event.changedTouches.find(({ identifier }) => identifier === gesture.id)
    if (!gesture || !touch) return
    gesture.last = { x: touch.clientX, y: touch.clientY }
    gesture.ended = true
    if (!gesture.bounds && gesture.tool !== 'pan') return
    this.updateGesture()
    this.finishGesture()
  },

  cancelGesture() {
    if (!this.gesture) return
    this.gesture = undefined
    this.setData({ draftBox: '', draftId: -1, draftStroke: [] })
  },

  updateGesture() {
    const g = this.gesture
    const image = this.image
    if (!g || !image) return
    if (g.tool === 'pan') {
      const { frame, zoom } = this.data
      const dx = g.stage.left - (frame.width - g.stage.width) / 2 + g.last.x - g.from.x
      const dy = g.stage.top - (frame.height - g.stage.height) / 2 + g.last.y - g.from.y
      this.setData({ stage: stageGeometry(frame, image, zoom, dx, dy) })
      return
    }
    if (!g.bounds) return
    const pointAt = ({ x, y }: Position) => pointOnImage(g.bounds!.left, g.bounds!.top, g.stage, x, y)
    const start = pointAt(g.from)
    if (!g.box && !inImage(start)) return this.cancelGesture()
    const last = clippedPoint(pointAt(g.last))
    if (Math.hypot(g.last.x - g.from.x, g.last.y - g.from.y) >= 3) g.moved = true
    if (g.tool === 'region') {
      if (!g.moved) return
      g.draft = g.box ? (g.resize ? resizeBox(g.box.box, start, last) : moveBox(g.box.box, start, last)) : drawBox(start, last)
      this.setData({ draftBox: boxStyle(g.draft), draftId: g.box?.id ?? -1 })
      return
    }

    const previous = g.stroke[g.stroke.length - 1]
    if (!previous) g.stroke.push(clippedPoint(start))
    const [x, y] = g.stroke[g.stroke.length - 1]
    const distance = Math.hypot((x - last[0]) * g.stage.width, (y - last[1]) * g.stage.height)
    const budget = Math.min(MAX_STROKE_POINTS, brushBudget(this.data.strokes))
    if (distance >= (g.ended ? 1 : 4) && g.stroke.length < budget) g.stroke.push(last)
    const radius = this.data.slider / 1000
    this.setData({ draftStroke: strokeStyles({ points: g.stroke, radius }, image) })
  },

  finishGesture() {
    const g = this.gesture
    const image = this.image
    if (!g || !image) return
    this.cancelGesture()
    if (g.tool === 'pan') return
    const state = stateOf(this.data)
    if (g.tool === 'region') {
      const box = g.draft
      if (!box || box[2] < 0.007 || box[3] < 0.007) return
      if (g.box) {
        const id = g.box.id
        this.editState({ ...state, regions: state.regions.map((item) => item.id === id ? { ...item, box, style: boxStyle(box) } : item) }, id)
        return
      }
      if (state.regions.length >= MAX_REGIONS) return toast('已达到区域上限，可撤销后调整。')
      const id = ++this.sequence
      this.editState({ ...state, regions: [...state.regions, { id, box, style: boxStyle(box), status: 'accepted', review: false }] }, id)
      return
    }
    if (!g.stroke.length) return
    const stroke = { points: g.stroke, radius: this.data.slider / 1000 }
    this.editState({ ...state, strokes: [...state.strokes, { id: ++this.sequence, kind: g.tool, stroke, styles: strokeStyles(stroke, image) }] })
  },

  selectRegion(event) {
    if (this.data.busy) return
    const id = Number(event.currentTarget.dataset.id)
    const region = this.data.regions.find((item) => item.id === id)
    if (!region || !this.image) return
    const [x, y, width, height] = region.box
    const { frame, stage, zoom } = this.data
    this.setData({
      selected: id, tool: 'region', view: 'original', showMarks: true,
      stage: stageGeometry(frame, this.image, zoom, (0.5 - x - width / 2) * stage.width, (0.5 - y - height / 2) * stage.height),
    })
  },

  reviewRegion(event) {
    if (this.data.busy) return
    const id = Number(event.currentTarget.dataset.id)
    const status: unknown = event.currentTarget.dataset.status
    if (!this.data.regions.some((item) => item.id === id)) return
    if (status === 'removed') {
      this.editState({ regions: this.data.regions.filter((item) => item.id !== id), strokes: this.data.strokes }, -1)
      return
    }
    if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') return
    const regions = this.data.regions.map((item): Region => item.id === id ? { ...item, status } : item)
    this.editState({ regions, strokes: this.data.strokes }, id)
  },

  editState(state, selected) {
    const history = this.history
    if (history.length === MAX_HISTORY) history.shift()
    history.push(stateOf(this.data))
    unlink(this.data.result)
    this.setData({
      ...state, ...summarize(state), selected: selected ?? this.data.selected,
      canUndo: true, result: '', view: 'original', showMarks: true, error: '',
    })
  },

  undo() {
    if (this.data.busy) return
    const state = this.history.pop()
    if (!state) return
    this.cancelGesture()
    unlink(this.data.result)
    this.setData({ ...state, ...summarize(state), selected: -1, canUndo: this.history.length > 0, result: '', view: 'original', showMarks: true, error: '' })
  },

  suggest(event) {
    this.confirmRun(event.currentTarget.dataset.ai ? 'ai' : 'local')
  },

  preview() {
    if (this.data.canApply) this.confirmRun('apply')
  },

  confirmRun(kind) {
    const session = this.session
    if (!session || !this.data.ready || !cloudEnabled || this.data.busy || this.confirming || this.closed) return
    this.confirming = true
    const ai = kind === 'ai'
    const title = ai ? '用 DeepSeek 提示区域' : kind === 'local' ? '让 VPS 提示区域' : '生成擦除预览'
    const content = ai
      ? '当前处理页将上传至本项目的 VPS，再交给已配置的 DeepSeek 视觉服务，只请求可疑笔迹位置。'
      : kind === 'local'
        ? '仅把当前处理页上传至本项目的 VPS，在服务器上查找可疑笔迹。每个区域仍需核对。'
        : '仅把当前处理页和已确认的区域、笔刷标记上传至本项目的 VPS，以生成可核对的擦除预览。'
    wx.showModal({
      title, content, confirmText: ai ? '同意上传' : '上传处理',
      success: ({ confirm }) => { if (confirm && !this.closed && this.session === session && !this.data.busy) void this.run(kind, session) },
      complete: () => { this.confirming = false },
    })
  },

  async run(kind, session) {
    this.cancelGesture()
    const turn = ++this.turn
    const isCancelled = () => this.closed || turn !== this.turn
    const onStatus = (status: CloudStatus) => { if (!isCancelled()) this.setData({ busy: statusText[status] }) }
    this.uploads += 1
    this.setData({ busy: '正在上传当前页', running: true, error: '' })
    try {
      if (kind === 'apply') {
        const outcome = await runExamInkApply({ imagePath: session.imagePath, plan: toPlan(this.data), onStatus, isCancelled })
        if (isCancelled()) unlink(outcome.imagePath)
        else {
          if (this.data.result !== outcome.imagePath) unlink(this.data.result)
          this.setData({ result: outcome.imagePath, view: 'result', showMarks: false })
          wx.pageScrollTo({ scrollTop: 0, duration: 180 })
        }
      } else {
        const outcome = await runExamInkCandidates({ imagePath: session.imagePath, ai: kind === 'ai', onStatus, isCancelled })
        if (isCancelled()) return
        const image = this.image
        if (!image || outcome.width !== image.width || outcome.height !== image.height) throw new Error('候选区域尺寸与当前试卷不一致，请重试。')
        const regions = [...this.data.regions]
        for (const { box, review } of outcome.candidates) {
          if (regions.length >= MAX_REGIONS) break
          if (regions.some((item) => similarity(item.box, box) >= 0.68)) continue
          regions.push({ id: ++this.sequence, box, style: boxStyle(box), status: 'pending', review })
        }
        if (regions.length === this.data.regions.length) this.setData({ error: '没有新增候选区域，可手动标记。' })
        else {
          const next = regions[this.data.regions.length]
          this.editState({ regions, strokes: this.data.strokes }, next.id)
          this.setData({ tool: 'region' })
        }
      }
    } catch (error) {
      if (!isCancelled()) this.setData({ error: explain(error, '处理失败，请重试。') })
    } finally {
      this.uploads -= 1
      if (this.closed && !this.uploads && session.temporary) unlink(session.imagePath)
      if (!isCancelled()) this.setData({ busy: '', running: false })
    }
  },

  cancelRun() {
    if (!this.data.running) return
    this.turn += 1
    this.setData({ busy: '', running: false, error: '已取消本次处理。' })
  },

  async save() {
    const filePath = this.data.result
    if (!filePath || this.data.busy) return
    this.saving = filePath
    this.setData({ busy: '正在保存图片' })
    try {
      await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath, success: () => resolve(), fail: reject }))
      if (!this.closed) toast('已保存到相册。')
    } catch {
      if (!this.closed) toast('保存失败，请检查相册权限。')
    } finally {
      this.saving = undefined
      if (this.closed) unlink(filePath)
      else this.setData({ busy: '' })
    }
  },

  adopt() {
    const imagePath = this.data.result
    if (!imagePath || !this.data.canAdopt || this.data.busy) return
    const channel = this.getOpenerEventChannel?.()
    let adopted = false
    const accept = (result: { imagePath: string }) => { adopted = result.imagePath === imagePath }
    channel?.on?.('examInkAdopted', accept)
    channel?.emit?.('examInkAdopt', { imagePath })
    channel?.off?.('examInkAdopted', accept)
    if (!adopted) return toast('未能应用到扫描页，可另存图片。')
    this.setData({ result: '' })
    wx.navigateBack({ delta: 2 })
  },
})
