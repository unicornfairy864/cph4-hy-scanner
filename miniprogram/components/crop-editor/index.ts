import type { Point, Quad } from '../../image'
import { edgeStyles, fullImageCorners, isValidCrop } from '../../pages/scan/geometry'
import { magnifierPosition, moveCorner, moveEdge } from './geometry'

interface Drag {
  id: number
  index: number
  kind: 'corner' | 'edge'
  start: Point
  corners: Quad
  viewport: Point
}

const activeDrags = new WeakMap<object, Drag>()
const lensSize = 116
const lensZoom = 2.75

function screenPoint(touch: WechatMiniprogram.TouchEvent['touches'][number]): Point {
  return { x: touch.clientX, y: touch.clientY }
}

function handleStyles(corners: Quad, width: number, height: number) {
  return corners.map((start, index) => {
    const end = corners[(index + 1) % corners.length]
    const angle = Math.atan2((end.y - start.y) * height, (end.x - start.x) * width)
    return {
      index,
      corner: `left:${start.x * 100}%;top:${start.y * 100}%`,
      edge: `left:${(start.x + end.x) * 50}%;top:${(start.y + end.y) * 50}%;transform:translate(-50%,-50%) rotate(${angle}rad)`,
    }
  })
}

function lensStyles(corner: Point, touch: Point, viewport: Point, width: number, height: number) {
  const size = Math.min(lensSize, viewport.x - 16, viewport.y - 16)
  if (size < 32) return null
  const origin = magnifierPosition(touch, viewport, size)
  const imageWidth = width * lensZoom
  const imageHeight = height * lensZoom
  return {
    box: `left:${origin.x}px;top:${origin.y}px;width:${size}px;height:${size}px`,
    image: `left:${size / 2 - corner.x * imageWidth}px;top:${size / 2 - corner.y * imageHeight}px;width:${imageWidth}px;height:${imageHeight}px`,
  }
}

Component({
  properties: {
    source: String,
    corners: Array,
    width: Number,
    height: Number,
    autoDetected: Boolean,
    partialDetected: Boolean,
    cornerConfidences: Array,
  },

  data: {
    draft: fullImageCorners,
    handles: [] as ReturnType<typeof handleStyles>,
    lines: [] as string[],
    active: '',
    lens: null as ReturnType<typeof lensStyles>,
  },

  observers: {
    'source, corners, width, height'() {
      if (!this.data.width || !this.data.height) return
      const corners = this.data.corners as Quad
      this.stopDrag()
      this.updateCrop(corners.length === 4 && isValidCrop(corners) ? corners : fullImageCorners)
    },
  },

  methods: {
    updateCrop(draft: Quad) {
      const { width, height } = this.data
      this.setData({ draft, handles: handleStyles(draft, width, height), lines: edgeStyles(draft, width, height) })
    },

    startDrag(event: WechatMiniprogram.TouchEvent) {
      const touch = event.changedTouches[0]
      const index = Number(event.currentTarget.dataset.index)
      const kind = event.currentTarget.dataset.kind
      const corner = this.data.draft[index]
      if (!touch || !corner || (kind !== 'corner' && kind !== 'edge') || activeDrags.has(this)) return

      const window = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const viewport = { x: window.windowWidth, y: window.windowHeight }
      const start = screenPoint(touch)
      const { draft, width, height } = this.data
      activeDrags.set(this, { id: touch.identifier, index, kind, start, corners: draft, viewport })
      this.setData({
        active: `${kind}-${index}`,
        lens: kind === 'corner' ? lensStyles(corner, start, viewport, width, height) : null,
      })
    },

    drag(event: WechatMiniprogram.TouchEvent) {
      const drag = activeDrags.get(this)
      if (!drag) return
      const touch = event.touches.find((point) => point.identifier === drag.id)
      if (!touch) return

      const { width, height } = this.data
      const point = screenPoint(touch)
      const offset = { x: point.x - drag.start.x, y: point.y - drag.start.y }
      const draft = drag.kind === 'corner'
        ? moveCorner(drag.corners, drag.index, { x: offset.x / width, y: offset.y / height })
        : moveEdge(drag.corners, drag.index, offset, width, height)
      this.setData({
        draft,
        handles: handleStyles(draft, width, height),
        lines: edgeStyles(draft, width, height),
        lens: drag.kind === 'corner' ? lensStyles(draft[drag.index], point, drag.viewport, width, height) : null,
      })
    },

    endDrag(event: WechatMiniprogram.TouchEvent) {
      const drag = activeDrags.get(this)
      if (drag && !event.touches.some((touch) => touch.identifier === drag.id)) this.stopDrag()
    },

    stopDrag() {
      activeDrags.delete(this)
      this.setData({ active: '', lens: null })
    },

    resetCrop() {
      this.stopDrag()
      this.updateCrop(fullImageCorners)
    },

    cancelCrop() {
      this.stopDrag()
      this.triggerEvent('cancel')
    },

    applyCrop() {
      if (isValidCrop(this.data.draft)) {
        this.stopDrag()
        this.triggerEvent('apply', { corners: this.data.draft })
      }
    },
  },
})
