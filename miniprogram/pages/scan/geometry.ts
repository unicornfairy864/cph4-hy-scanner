import type { Point, Quad, Rotation } from '../../image'

export const fullImageCorners: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

export function pointInImage(x: number, y: number): Point {
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

export function isValidCrop(corners: Quad): boolean {
  let doubleArea = 0
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index]
    const end = corners[(index + 1) % corners.length]
    const next = corners[(index + 2) % corners.length]
    const cross = (end.x - start.x) * (next.y - end.y) - (end.y - start.y) * (next.x - end.x)
    if (cross <= 0.0001) {
      return false
    }
    doubleArea += start.x * end.y - start.y * end.x
  }
  return doubleArea > 0.005
}

export function fitImage(sourceWidth: number, sourceHeight: number, screenWidth: number, screenHeight: number) {
  const scale = Math.min((screenWidth - 52) / sourceWidth, Math.min(screenHeight * 0.54, 460) / sourceHeight)
  return { width: sourceWidth * scale, height: sourceHeight * scale }
}

export function edgeStyles(corners: Quad, width: number, height: number): string[] {
  return corners.map((start, index) => {
    const end = corners[(index + 1) % corners.length]
    const deltaX = (end.x - start.x) * width
    const deltaY = (end.y - start.y) * height
    const distance = Math.hypot(deltaX, deltaY)
    const angle = Math.atan2(deltaY, deltaX)
    return `left:${start.x * 100}%;top:${start.y * 100}%;width:${distance}px;transform:rotate(${angle}rad)`
  })
}

export function orientCorners([a, b, c, d]: Quad, rotation: Rotation): Quad {
  function orient({ x, y }: Point): Point {
    switch (rotation) {
      case 90: return { x: 1 - y, y: x }
      case 180: return { x: 1 - x, y: 1 - y }
      case 270: return { x: y, y: 1 - x }
      default: return { x, y }
    }
  }
  return [orient(a), orient(b), orient(c), orient(d)]
}

export function fitRotatedImageStyle(width: number, height: number, angle: Rotation, frameWidth: number, frameHeight: number): string {
  const swapSides = angle === 90 || angle === 270
  const scale = Math.min(frameWidth / (swapSides ? height : width), frameHeight / (swapSides ? width : height))
  return `width:${width * scale}px;height:${height * scale}px;transform:translate(-50%,-50%) rotate(${angle}deg)`
}
