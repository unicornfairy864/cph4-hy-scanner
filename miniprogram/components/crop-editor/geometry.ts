import type { Point, Quad } from '../../image'
import { isValidCrop, pointInImage } from '../../pages/scan/geometry'

export { orientCorners } from '../../pages/scan/geometry'

function furthestValidCrop(corners: Quad, position: (ratio: number) => Quad): Quad {
  const target = position(1)
  if (isValidCrop(target)) return target

  let lower = 0
  let upper = 1
  let result = corners
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const ratio = (lower + upper) / 2
    const candidate = position(ratio)
    if (isValidCrop(candidate)) {
      lower = ratio
      result = candidate
    } else {
      upper = ratio
    }
  }
  return result
}

export function moveCorner(corners: Quad, index: number, offset: Point): Quad {
  const origin = corners[index]
  const target = pointInImage(origin.x + offset.x, origin.y + offset.y)
  return furthestValidCrop(corners, (ratio) => {
    const next: Quad = [...corners]
    next[index] = { x: origin.x + (target.x - origin.x) * ratio, y: origin.y + (target.y - origin.y) * ratio }
    return next
  })
}

function lineBounds(coordinate: number, direction: number): [number, number] {
  if (direction === 0) return [-Infinity, Infinity]
  const near = -coordinate / direction
  const far = (1 - coordinate) / direction
  return [Math.min(near, far), Math.max(near, far)]
}

export function moveEdge(corners: Quad, index: number, drag: Point, width: number, height: number): Quad {
  if (width <= 0 || height <= 0) return corners
  const endIndex = (index + 1) % corners.length
  const start = corners[index]
  const end = corners[endIndex]
  const directionX = end.x - start.x
  const directionY = end.y - start.y
  const edgeX = directionX * width
  const edgeY = directionY * height
  const length = Math.hypot(edgeX, edgeY)
  if (length === 0) return corners

  const normalX = -edgeY / length
  const normalY = edgeX / length
  const projectionX = normalX * width
  const projectionY = normalY * height
  const origin = start.x * projectionX + start.y * projectionY
  const minDistance = Math.min(0, projectionX) + Math.min(0, projectionY) - origin
  const maxDistance = Math.max(0, projectionX) + Math.max(0, projectionY) - origin
  const distance = Math.max(minDistance, Math.min(maxDistance, drag.x * normalX + drag.y * normalY))
  const deltaX = distance * normalX / width
  const deltaY = distance * normalY / height
  return furthestValidCrop(corners, (ratio) => {
    const x = start.x + deltaX * ratio
    const y = start.y + deltaY * ratio
    // Clamp each endpoint along the translated line so touching the frame never changes the angle.
    const [minX, maxX] = lineBounds(x, directionX)
    const [minY, maxY] = lineBounds(y, directionY)
    const min = Math.max(minX, minY)
    const max = Math.min(maxX, maxY)
    const startAlong = Math.max(min, Math.min(max, 0))
    const endAlong = Math.max(min, Math.min(max, 1))
    const next: Quad = [...corners]
    next[index] = pointInImage(x + directionX * startAlong, y + directionY * startAlong)
    next[endIndex] = pointInImage(x + directionX * endAlong, y + directionY * endAlong)
    return next
  })
}

const LENS_GAP = 22
const VIEWPORT_MARGIN = 8

export function magnifierPosition(touch: Point, viewport: Point, size: number): Point {
  const above = touch.y - size - LENS_GAP
  const preferredY = above >= VIEWPORT_MARGIN ? above : touch.y + LENS_GAP
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(viewport.x - size - VIEWPORT_MARGIN, touch.x - size / 2)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(viewport.y - size - VIEWPORT_MARGIN, preferredY)),
  }
}

export interface CropView {
  zoom: number
  offset: Point
}

export const maximumZoom = 4
export const initialView: CropView = { zoom: 1, offset: { x: 0, y: 0 } }

function keepInFrame(offset: Point, zoom: number, frame: Point): Point {
  const maxX = frame.x * (zoom - 1) / 2
  const maxY = frame.y * (zoom - 1) / 2
  return { x: Math.max(-maxX, Math.min(maxX, offset.x)), y: Math.max(-maxY, Math.min(maxY, offset.y)) }
}

export function panView(view: CropView, delta: Point, frame: Point): CropView {
  const offset = { x: view.offset.x + delta.x, y: view.offset.y + delta.y }
  return { zoom: view.zoom, offset: keepInFrame(offset, view.zoom, frame) }
}

export function zoomView(view: CropView, target: number, focus: Point, delta: Point, frame: Point): CropView {
  const zoom = Math.max(1, Math.min(maximumZoom, target))
  if (zoom === 1) return initialView
  const ratio = zoom / view.zoom
  const offset = {
    x: focus.x - (focus.x - view.offset.x) * ratio + delta.x,
    y: focus.y - (focus.y - view.offset.y) * ratio + delta.y,
  }
  return { zoom, offset: keepInFrame(offset, zoom, frame) }
}
