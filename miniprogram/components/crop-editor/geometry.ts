import type { Point, Quad } from '../../image'
import { isValidCrop, pointInImage } from '../../pages/scan/geometry'

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

function limitAxis(coordinate: number, delta: number): number {
  if (delta > 0) return (1 - coordinate) / delta
  if (delta < 0) return -coordinate / delta
  return 1
}

export function moveEdge(corners: Quad, index: number, drag: Point, width: number, height: number): Quad {
  const endIndex = (index + 1) % corners.length
  const start = corners[index]
  const end = corners[endIndex]
  const edgeX = (end.x - start.x) * width
  const edgeY = (end.y - start.y) * height
  const length = Math.hypot(edgeX, edgeY)
  if (length === 0) return corners

  const normalX = -edgeY / length
  const normalY = edgeX / length
  const distance = drag.x * normalX + drag.y * normalY
  const deltaX = distance * normalX / width
  const deltaY = distance * normalY / height
  const bounds = Math.min(1,
    limitAxis(start.x, deltaX), limitAxis(end.x, deltaX),
    limitAxis(start.y, deltaY), limitAxis(end.y, deltaY),
  )
  return furthestValidCrop(corners, (ratio) => {
    const delta = { x: deltaX * bounds * ratio, y: deltaY * bounds * ratio }
    const next: Quad = [...corners]
    next[index] = pointInImage(start.x + delta.x, start.y + delta.y)
    next[endIndex] = pointInImage(end.x + delta.x, end.y + delta.y)
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
