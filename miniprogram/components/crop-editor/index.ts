import { detectQuad } from '../../image'
import type { Point, Quad, Rotation } from '../../image'
import { edgeStyles, fitImage, fullImageCorners, isValidCrop } from '../../pages/scan/geometry'
import {
  initialView, magnifierPosition, maximumZoom, moveCorner, moveEdge, orientCorners, panView, zoomView,
} from './geometry'
import type { CropView } from './geometry'

type Touch = WechatMiniprogram.TouchEvent['touches'][number]
type Gesture =
  | { kind: 'corner' | 'edge'; id: number; index: number; start: Point; corners: Quad }
  | { kind: 'pan'; id: number; start: Point; view: CropView }
  | { kind: 'pinch'; start: Point; distance: number; focus: Point; view: CropView }

interface Draft {
  draft: Quad
  draftRotation: Rotation
  scores: number[]
  view: CropView
  viewport: Point
}

const gestures = new WeakMap<object, Gesture>()
const detections = new WeakMap<object, symbol>()
const lensSize = 116
const lensZoom = 2.75
const center = { x: 0, y: 0 }

function screenPoint(touch: Touch): Point {
  return { x: touch.clientX, y: touch.clientY }
}

function difference(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function cropFrame(width: number, height: number, rotation: Rotation, viewport: Point): Point {
  if (rotation % 180 === 0) return { x: width, y: height }
  const rotated = fitImage(height, width, viewport.x, viewport.y)
  return { x: rotated.width, y: rotated.height }
}

function photoStyle(center: Point, width: number, height: number, rotation: Rotation): string {
  const swapped = rotation % 180 !== 0
  return `left:${center.x}px;top:${center.y}px;width:${swapped ? height : width}px;height:${swapped ? width : height}px;transform:translate(-50%,-50%) rotate(${rotation}deg)`
}

function handlesFor(corners: Quad, width: number, height: number, scores: number[]) {
  return corners.map((start, index) => {
    const end = corners[(index + 1) % corners.length]
    const angle = Math.atan2((end.y - start.y) * height, (end.x - start.x) * width)
    return {
      index,
      lowConfidence: scores[index] !== undefined && scores[index] < 0.52,
      corner: `left:${start.x * 100}%;top:${start.y * 100}%`,
      edge: `left:${(start.x + end.x) * 50}%;top:${(start.y + end.y) * 50}%;transform:translate(-50%,-50%) rotate(${angle}rad)`,
    }
  })
}

function lensStyles(corner: Point, touch: Point, viewport: Point, width: number, height: number, rotation: Rotation) {
  const size = Math.min(lensSize, viewport.x - 16, viewport.y - 16)
  if (size < 32) return null
  const origin = magnifierPosition(touch, viewport, size)
  const imageWidth = width * lensZoom
  const imageHeight = height * lensZoom
  const imageCenter = {
    x: size / 2 + (0.5 - corner.x) * imageWidth,
    y: size / 2 + (0.5 - corner.y) * imageHeight,
  }
  return {
    box: `left:${origin.x}px;top:${origin.y}px;width:${size}px;height:${size}px`,
    image: photoStyle(imageCenter, imageWidth, imageHeight, rotation),
  }
}

Component({
  properties: {
    source: String,
    corners: Array,
    width: Number,
    height: Number,
    rotation: Number,
    autoDetected: Boolean,
    cornerConfidences: Array,
    partialDetected: Boolean,
  },

  data: {
    draft: fullImageCorners,
    draftRotation: 0 as Rotation,
    scores: [] as number[],
    view: initialView,
    viewport: center,
    handles: [] as ReturnType<typeof handlesFor>,
    lines: [] as string[],
    canvasStyle: '',
    imageStyle: '',
    stageHeight: 0,
    zoomOutDisabled: true,
    zoomInDisabled: false,
    hasUncertainCorners: false,
    active: '',
    detecting: false,
    lens: null as ReturnType<typeof lensStyles>,
  },

  observers: {
    'source, corners, width, height, rotation, autoDetected, cornerConfidences'() {
      if (!this.data.width || !this.data.height) return
      const corners = this.data.corners as Quad
      const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.stopGesture()
      this.cancelDetection()
      this.paint({
        draft: corners.length === 4 && isValidCrop(corners) ? corners : fullImageCorners,
        draftRotation: this.data.rotation as Rotation,
        scores: this.data.autoDetected ? this.data.cornerConfidences : [],
        view: initialView,
        viewport: { x: windowInfo.windowWidth, y: windowInfo.windowHeight },
      })
    },
  },

  lifetimes: {
    detached() {
      gestures.delete(this)
      detections.delete(this)
    },
  },

  methods: {
    paint(changes: Partial<Draft> = {}, lens?: ReturnType<typeof lensStyles>) {
      const { draft, draftRotation, scores, view, viewport } = { ...this.data, ...changes }
      const frame = cropFrame(this.data.width, this.data.height, draftRotation, viewport)
      const width = frame.x * view.zoom
      const height = frame.y * view.zoom
      const corners = orientCorners(draft, draftRotation)
      this.setData({
        ...changes,
        handles: handlesFor(corners, width, height, scores),
        lines: edgeStyles(corners, width, height),
        canvasStyle: `width:${width}px;height:${height}px;transform:translate(-50%,-50%) translate(${view.offset.x}px,${view.offset.y}px)`,
        imageStyle: photoStyle({ x: width / 2, y: height / 2 }, width, height, draftRotation),
        stageHeight: Math.max(148, frame.y + 44),
        zoomOutDisabled: view.zoom <= 1,
        zoomInDisabled: view.zoom >= maximumZoom,
        hasUncertainCorners: scores.some((score) => score < 0.52),
        ...(lens !== undefined ? { lens } : {}),
      })
    },

    startPinch(touches: Touch[]) {
      const a = screenPoint(touches[0])
      const b = screenPoint(touches[1])
      const start = midpoint(a, b)
      const gesture: Gesture = {
        kind: 'pinch', start, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        focus: center, view: this.data.view,
      }
      gestures.set(this, gesture)
      this.setData({ active: '', lens: null })
      this.createSelectorQuery().select('.crop-stage').boundingClientRect((rect) => {
        if (!rect || Array.isArray(rect) || gestures.get(this) !== gesture) return
        gesture.focus = difference(start, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      }).exec()
    },

    startPan(event: WechatMiniprogram.TouchEvent) {
      if (event.touches.length >= 2) this.startPinch(event.touches)
      else if (event.touches[0] && !gestures.has(this)) {
        const touch = event.touches[0]
        gestures.set(this, { kind: 'pan', id: touch.identifier, start: screenPoint(touch), view: this.data.view })
      }
    },

    startHandle(event: WechatMiniprogram.TouchEvent) {
      if (event.touches.length >= 2) {
        this.startPinch(event.touches)
        return
      }
      const touch = event.changedTouches[0]
      const index = Number(event.currentTarget.dataset.index)
      const kind = event.currentTarget.dataset.kind
      const { draft, draftRotation, view, viewport } = this.data
      const corners = orientCorners(draft, draftRotation)
      if (!touch || !corners[index] || (kind !== 'corner' && kind !== 'edge') || gestures.has(this)) return

      this.cancelDetection()
      const start = screenPoint(touch)
      const frame = cropFrame(this.data.width, this.data.height, draftRotation, viewport)
      gestures.set(this, { id: touch.identifier, index, kind, start, corners })
      this.setData({
        active: `${kind}-${index}`,
        lens: kind === 'corner' ? lensStyles(corners[index], start, viewport, frame.x * view.zoom, frame.y * view.zoom, draftRotation) : null,
      })
    },

    moveGesture(event: WechatMiniprogram.TouchEvent) {
      const gesture = gestures.get(this)
      if (!gesture) return
      const { draftRotation, view, viewport } = this.data
      const frame = cropFrame(this.data.width, this.data.height, draftRotation, viewport)
      if (gesture.kind === 'pinch') {
        if (event.touches.length < 2) return
        const a = screenPoint(event.touches[0])
        const b = screenPoint(event.touches[1])
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        this.paint({ view: zoomView(gesture.view, gesture.view.zoom * distance / gesture.distance,
          gesture.focus, difference(midpoint(a, b), gesture.start), frame) })
        return
      }
      const touch = event.touches.find((item) => item.identifier === gesture.id)
      if (!touch) return
      const position = screenPoint(touch)
      const offset = difference(position, gesture.start)
      if (gesture.kind === 'pan') {
        if (gesture.view.zoom > 1) this.paint({ view: panView(gesture.view, offset, frame) })
        return
      }

      const width = frame.x * view.zoom
      const height = frame.y * view.zoom
      const corners = gesture.kind === 'corner'
        ? moveCorner(gesture.corners, gesture.index, { x: offset.x / width, y: offset.y / height })
        : moveEdge(gesture.corners, gesture.index, offset, width, height)
      const draft = orientCorners(corners, ((360 - draftRotation) % 360) as Rotation)
      const scores = [...this.data.scores]
      if (scores.length === 4) {
        scores[gesture.index] = 1
        if (gesture.kind === 'edge') scores[(gesture.index + 1) % corners.length] = 1
      }
      this.paint({ draft, scores }, gesture.kind === 'corner'
        ? lensStyles(corners[gesture.index], position, viewport, width, height, draftRotation)
        : null)
    },

    endGesture(event: WechatMiniprogram.TouchEvent) {
      const gesture = gestures.get(this)
      if (!gesture) return
      if (gesture.kind === 'pinch' && event.touches.length >= 2) return
      if (gesture.kind !== 'pinch' && event.touches.some((touch) => touch.identifier === gesture.id)) return
      this.stopGesture()
      if (gesture.kind === 'pinch' && event.touches.length === 1) this.startPan(event)
    },

    stopGesture() {
      gestures.delete(this)
      this.setData({ active: '', lens: null })
    },

    adjustZoom(event: WechatMiniprogram.BaseEvent) {
      const factor = event.currentTarget.dataset.direction === 'out' ? 1 / 1.5 : 1.5
      const { draftRotation, view, viewport } = this.data
      const frame = cropFrame(this.data.width, this.data.height, draftRotation, viewport)
      this.stopGesture()
      this.paint({ view: zoomView(view, view.zoom * factor, center, center, frame) })
    },

    resetCrop() {
      this.stopGesture()
      this.cancelDetection()
      this.paint({ draft: fullImageCorners, scores: [], view: initialView })
    },

    rotateCrop() {
      this.stopGesture()
      this.cancelDetection()
      this.paint({ draftRotation: ((this.data.draftRotation + 90) % 360) as Rotation, view: initialView })
    },

    async detectCrop() {
      if (!this.data.source || this.data.detecting) return
      this.stopGesture()
      const request = Symbol()
      detections.set(this, request)
      this.setData({ detecting: true })
      try {
        const result = await detectQuad({ imagePath: this.data.source })
        if (detections.get(this) !== request) return
        if (result.corners && isValidCrop(result.corners)) {
          this.paint({ draft: result.corners, scores: result.cornerConfidences })
        } else {
          wx.showToast({ title: '未找到页边，可手动调整', icon: 'none' })
        }
      } catch {
        if (detections.get(this) === request) wx.showToast({ title: '无法识别页边，可手动调整', icon: 'none' })
      } finally {
        if (detections.get(this) === request) this.cancelDetection()
      }
    },

    cancelDetection() {
      detections.delete(this)
      if (this.data.detecting) this.setData({ detecting: false })
    },

    cancelCrop() {
      this.stopGesture()
      this.cancelDetection()
      this.triggerEvent('cancel')
    },

    applyCrop() {
      const { draft, draftRotation } = this.data
      if (!isValidCrop(draft)) return
      this.stopGesture()
      this.cancelDetection()
      this.triggerEvent('apply', { corners: draft, rotation: draftRotation })
    },
  },
})
