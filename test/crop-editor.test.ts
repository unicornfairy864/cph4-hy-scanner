import assert from 'node:assert/strict'
import test from 'node:test'
import type { Quad, Rotation } from '../miniprogram/image'
import {
  initialView, magnifierPosition, moveCorner, moveEdge, orientCorners, panView, zoomView,
} from '../miniprogram/components/crop-editor/geometry'
import { fullImageCorners, isValidCrop } from '../miniprogram/pages/scan/geometry'

const skewed: Quad = [
  { x: 0.15, y: 0.2 },
  { x: 0.75, y: 0.32 },
  { x: 0.8, y: 0.78 },
  { x: 0.12, y: 0.82 },
]

function closeTo(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`)
}

test('a slanted edge translates both endpoints along its normal in display pixels', () => {
  const width = 240
  const height = 440
  const result = moveEdge(skewed, 0, { x: 10, y: 28 }, width, height)
  const displacementX = (result[0].x - skewed[0].x) * width
  const displacementY = (result[0].y - skewed[0].y) * height
  const edgeX = (skewed[1].x - skewed[0].x) * width
  const edgeY = (skewed[1].y - skewed[0].y) * height

  assert.ok(displacementY > 0)
  closeTo(displacementX * edgeX + displacementY * edgeY, 0)
  closeTo(result[1].x - skewed[1].x, result[0].x - skewed[0].x)
  closeTo(result[1].y - skewed[1].y, result[0].y - skewed[0].y)
  assert.deepEqual(result.slice(2), skewed.slice(2))
})

test('edge motion stops at the image boundary or before the crop becomes invalid', () => {
  const outside = moveEdge(skewed, 0, { x: 0, y: -2000 }, 240, 440)
  closeTo(outside[0].y, 0)
  closeTo(outside[1].y - outside[0].y, skewed[1].y - skewed[0].y)

  const pastOpposite = moveEdge(fullImageCorners, 0, { x: 0, y: 2000 }, 240, 440)
  assert.ok(isValidCrop(pastOpposite))
  assert.ok(pastOpposite[0].y > 0.9)
  assert.deepEqual(pastOpposite[0], { x: 0, y: pastOpposite[1].y })

  const wrapped = moveEdge(fullImageCorners, 3, { x: 48, y: 0 }, 240, 440)
  closeTo(wrapped[3].x, 0.2)
  closeTo(wrapped[0].x, 0.2)
  assert.deepEqual(wrapped.slice(1, 3), fullImageCorners.slice(1, 3))
})

test('corners stay within the image without crossing the other crop corners', () => {
  const bounded = moveCorner(skewed, 0, { x: -2, y: -2 })
  assert.deepEqual(bounded[0], { x: 0, y: 0 })
  const crossing = moveCorner(fullImageCorners, 0, { x: 1, y: 1 })
  assert.ok(isValidCrop(crossing))
  assert.ok(crossing[0].x > 0.4 && crossing[0].x < 0.5)
  assert.deepEqual(crossing.slice(1), fullImageCorners.slice(1))
})

test('magnifier prefers above the finger and switches below when it cannot fit', () => {
  const viewport = { x: 360, y: 700 }
  assert.deepEqual(magnifierPosition({ x: 180, y: 200 }, viewport, 116), { x: 122, y: 62 })
  assert.deepEqual(magnifierPosition({ x: 359, y: 60 }, viewport, 116), { x: 236, y: 82 })
})

test('rotating the display preserves the source vertex indices and crop coordinates', () => {
  const rotations: Rotation[] = [0, 90, 180, 270]
  for (const rotation of rotations) {
    const oriented = orientCorners(skewed, rotation)
    assert.ok(isValidCrop(oriented))
    const source = orientCorners(oriented, ((360 - rotation) % 360) as Rotation)
    for (let index = 0; index < 4; index += 1) {
      closeTo(source[index].x, skewed[index].x)
      closeTo(source[index].y, skewed[index].y)
    }
  }
  const oriented = orientCorners(skewed, 90)
  const edited = orientCorners(moveCorner(oriented, 0, { x: 0, y: 0.1 }), 270)
  closeTo(edited[0].x, skewed[0].x + 0.1)
  closeTo(edited[0].y, skewed[0].y)
})

test('pinch retains its focus, and pan and zoom are bounded by the image', () => {
  const frame = { x: 200, y: 300 }
  const zoom = zoomView(initialView, 2, { x: 30, y: -40 }, { x: 8, y: 2 }, frame)
  assert.deepEqual(zoom, { zoom: 2, offset: { x: -22, y: 42 } })
  const panned = panView(zoom, { x: 900, y: -900 }, frame)
  assert.deepEqual(panned, { zoom: 2, offset: { x: 100, y: -150 } })
  const centered = zoomView(panned, 0.5, { x: 0, y: 0 }, { x: 0, y: 0 }, frame)
  assert.deepEqual(centered, initialView)
  assert.equal(zoomView(initialView, 20, { x: 0, y: 0 }, { x: 0, y: 0 }, frame).zoom, 4)
})
