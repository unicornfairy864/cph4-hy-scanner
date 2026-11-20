import type { ExamInkBox, ExamInkPoint, ExamInkStroke } from '../../services/cloud'

export interface Size { width: number; height: number }
export interface Stage extends Size { left: number; top: number }

export const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value))

export function stageGeometry(frame: Size, image: Size, zoom: number, dx = 0, dy = 0): Stage {
  const scale = Math.min(frame.width / image.width, frame.height / image.height) * zoom
  const width = image.width * scale
  const height = image.height * scale
  const minX = Math.min(0, (frame.width - width) / 2)
  const minY = Math.min(0, (frame.height - height) / 2)
  return {
    width, height,
    left: (frame.width - width) / 2 + clamp(dx, minX, -minX),
    top: (frame.height - height) / 2 + clamp(dy, minY, -minY),
  }
}

export function zoomGeometry(frame: Size, image: Size, current: Stage, zoom: number): Stage {
  const target = stageGeometry(frame, image, zoom)
  const oldDx = current.left - (frame.width - current.width) / 2
  const oldDy = current.top - (frame.height - current.height) / 2
  return stageGeometry(frame, image, zoom, oldDx * target.width / current.width, oldDy * target.height / current.height)
}

export function pointOnImage(frameLeft: number, frameTop: number, stage: Stage, x: number, y: number): ExamInkPoint {
  return [(x - frameLeft - stage.left) / stage.width, (y - frameTop - stage.top) / stage.height]
}

export function inImage(point: ExamInkPoint): boolean {
  return point.every((coordinate) => coordinate >= 0 && coordinate <= 1)
}

export function clippedPoint([x, y]: ExamInkPoint): ExamInkPoint {
  return [clamp(x), clamp(y)]
}

export function drawBox([x0, y0]: ExamInkPoint, [x1, y1]: ExamInkPoint): ExamInkBox {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]
}

export function moveBox(box: ExamInkBox, first: ExamInkPoint, current: ExamInkPoint): ExamInkBox {
  const [x, y, width, height] = box
  return [clamp(x + current[0] - first[0], 0, 1 - width), clamp(y + current[1] - first[1], 0, 1 - height), width, height]
}

export function resizeBox([x, y, width, height]: ExamInkBox, first: ExamInkPoint, current: ExamInkPoint): ExamInkBox {
  return [x, y, clamp(width + current[0] - first[0], Math.min(0.007, 1 - x), 1 - x),
    clamp(height + current[1] - first[1], Math.min(0.007, 1 - y), 1 - y)]
}

export function boxStyle([x, y, width, height]: ExamInkBox): string {
  return `left:${x * 100}%;top:${y * 100}%;width:${width * 100}%;height:${height * 100}%`
}

export function similarity(a: ExamInkBox, b: ExamInkBox): number {
  const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  if (width <= 0 || height <= 0) return 0
  const overlap = width * height
  return overlap / (a[2] * a[3] + b[2] * b[3] - overlap)
}

export function strokeStyles(stroke: ExamInkStroke, image: Size): string[] {
  const points = stroke.points
  const thickness = 2 * Math.min(image.width, image.height) * stroke.radius
  const w = thickness * 100 / image.width
  const h = thickness * 100 / image.height
  const first = points[0]
  if (!first) return []
  if (points.length === 1) {
    return [`left:${first[0] * 100 - w / 2}%;top:${first[1] * 100 - h / 2}%;width:${w}%;height:${h}%`]
  }
  return points.slice(1).map(([x, y], index) => {
    const [px, py] = points[index]
    const dx = (x - px) * image.width
    const dy = (y - py) * image.height
    const width = (Math.hypot(dx, dy) + thickness) * 100 / image.width
    const angle = Math.atan2(dy, dx) * 180 / Math.PI
    return `left:${px * 100}%;top:${py * 100 - h / 2}%;width:${width}%;height:${h}%;transform:rotate(${angle}deg) translateX(${-50 * w / width}%)`
  })
}
