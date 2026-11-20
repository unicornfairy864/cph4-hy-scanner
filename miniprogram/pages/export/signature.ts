import { signatureRectangle } from '../../services/pdf'
import type { PageSignature } from '../../services/pdf'

export interface SignaturePoint {
  x: number
  y: number
}

interface InkContext {
  lineWidth: number
  lineCap: string
  strokeStyle: string
  fillStyle: string
  scale(x: number, y: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  fill(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
}

export interface InkCanvas {
  width: number
  height: number
  getContext(type: '2d'): InkContext | null
}

export interface InkPad {
  left: number
  top: number
  width: number
  height: number
  context: InkContext
}

const inkColor = '#14211f'

export function setupInkPad(canvas: InkCanvas, bounds: Omit<InkPad, 'context'>, pixelRatio: number): InkPad | undefined {
  const context = canvas.getContext('2d')
  if (!context || !bounds.width || !bounds.height) return
  canvas.width = Math.round(bounds.width * pixelRatio)
  canvas.height = Math.round(bounds.height * pixelRatio)
  context.scale(pixelRatio, pixelRatio)
  context.lineWidth = 2.6
  context.lineCap = 'round'
  context.strokeStyle = inkColor
  context.fillStyle = inkColor
  return { ...bounds, context }
}

export function drawInkPoint(pad: InkPad, point: SignaturePoint, previous?: SignaturePoint): void {
  const { context } = pad
  context.beginPath()
  if (!previous) {
    context.arc(point.x, point.y, context.lineWidth / 2, 0, 2 * Math.PI)
    context.fill()
    return
  }
  context.moveTo(previous.x, previous.y)
  context.lineTo(point.x, point.y)
  context.stroke()
}

export function pointInPad(pad: InkPad, x: number, y: number): SignaturePoint {
  return { x: Math.max(0, Math.min(pad.width, x - pad.left)), y: Math.max(0, Math.min(pad.height, y - pad.top)) }
}

export function signatureOverlay(signature: PageSignature, pageWidth: number, pageHeight: number) {
  const rect = signatureRectangle(signature, pageWidth, pageHeight)
  const thickness = rect.thickness
  const styles = ('ink' in signature ? signature.ink.strokes : []).flatMap((stroke) => stroke.map((point, index) => {
    const x = point.x * rect.width
    const y = point.y * rect.height
    const next = stroke[index + 1]
    if (!next) return `left:${x - thickness / 2}px;top:${y - thickness / 2}px;width:${thickness}px;height:${thickness}px`
    const deltaX = next.x * rect.width - x
    const deltaY = next.y * rect.height - y
    const angle = Math.atan2(deltaY, deltaX)
    return `left:${x}px;top:${y}px;width:${Math.hypot(deltaX, deltaY) + thickness}px;height:${thickness}px;transform:rotate(${angle}rad) translate(${-thickness / 2}px,${-thickness / 2}px)`
  }))
  return {
    style: `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`,
    segments: styles.map((style, id) => ({ id, style })),
    imagePath: 'image' in signature ? signature.image.imagePath : '',
  }
}
