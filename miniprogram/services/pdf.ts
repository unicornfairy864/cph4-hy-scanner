import { LineCapStyle, PDFDocument, rgb } from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'

const A4_SHORT = 595.28
const A4_LONG = 841.89

interface Point {
  x: number
  y: number
}

export interface SignatureInk {
  width: number
  height: number
  strokes: Point[][]
}

export interface PageSignature {
  ink: SignatureInk
  center: Point
}

interface Rectangle {
  left: number
  top: number
  width: number
  height: number
}

export function fitRectangle(width: number, height: number, withinWidth: number, withinHeight: number): Rectangle {
  const scale = Math.min(withinWidth / width, withinHeight / height)
  return {
    left: (withinWidth - width * scale) / 2,
    top: (withinHeight - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  }
}

export function scanPdfLayout(imageWidth: number, imageHeight: number) {
  const landscape = imageWidth > imageHeight
  const width = landscape ? A4_LONG : A4_SHORT
  const height = landscape ? A4_SHORT : A4_LONG
  return { width, height, image: fitRectangle(imageWidth, imageHeight, width, height) }
}

export function normalizeSignature(strokes: Point[][]): SignatureInk | undefined {
  const points = strokes.flat()
  if (!points.length) return
  const xs = points.map(({ x }) => x)
  const ys = points.map(({ y }) => y)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const width = Math.max(8, right - left)
  const height = Math.max(8, bottom - top)
  const x0 = (left + right - width) / 2
  const y0 = (top + bottom - height) / 2
  return {
    width, height,
    strokes: strokes.map((stroke) => stroke.map(({ x, y }) => ({ x: (x - x0) / width, y: (y - y0) / height }))),
  }
}

export function signatureRectangle({ ink, center }: PageSignature, pageWidth: number, pageHeight: number) {
  const shortSide = Math.min(pageWidth, pageHeight)
  const scale = Math.min(shortSide * 0.34 / ink.width, shortSide * 0.18 / ink.height)
  const width = ink.width * scale
  const height = ink.height * scale
  const thickness = shortSide * 0.003
  return {
    left: Math.max(thickness, Math.min(pageWidth - width - thickness, center.x * pageWidth - width / 2)),
    top: Math.max(thickness, Math.min(pageHeight - height - thickness, center.y * pageHeight - height / 2)),
    width, height, thickness,
  }
}

function drawSignature(page: PDFPage, signature: PageSignature, width: number, height: number): void {
  const rect = signatureRectangle(signature, width, height)
  const color = rgb(0.08, 0.13, 0.12)
  const coordinates = ({ x, y }: Point) => ({ x: rect.left + x * rect.width, y: height - rect.top - y * rect.height })
  for (const stroke of signature.ink.strokes) {
    if (stroke.length === 1) {
      page.drawCircle({ ...coordinates(stroke[0]), size: rect.thickness / 2, color })
    }
    for (let index = 1; index < stroke.length; index += 1) {
      page.drawLine({
        start: coordinates(stroke[index - 1]), end: coordinates(stroke[index]),
        thickness: rect.thickness, color, lineCap: LineCapStyle.Round,
      })
    }
  }
}

export async function createScanPdf(
  count: number, render: (index: number) => Promise<Uint8Array>, signatureAt?: (index: number) => PageSignature | undefined,
): Promise<Uint8Array> {
  if (count === 0) {
    throw new Error('请先添加至少一页。')
  }

  const document = await PDFDocument.create()
  for (let index = 0; index < count; index += 1) {
    const bytes = await render(index)
    // pdf-lib reads the JPEG header from the backing buffer, starting at offset zero.
    const jpeg = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes)
    const image = await document.embedJpg(jpeg)
    const { width, height, image: rect } = scanPdfLayout(image.width, image.height)
    const page = document.addPage([width, height])
    page.drawImage(image, {
      x: rect.left, y: height - rect.top - rect.height,
      width: rect.width, height: rect.height,
    })
    const signature = signatureAt?.(index)
    if (signature) drawSignature(page, signature, width, height)
  }

  return document.save({ objectsPerTick: 20, useObjectStreams: false })
}

export function readImageBytes(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: ({ data }) => {
        if (typeof data === 'string') {
          reject(new Error('无法读取扫描图片。'))
          return
        }
        resolve(new Uint8Array(data))
      },
      fail: reject,
    })
  })
}

export function writeScanPdf(filePath: string, bytes: Uint8Array): Promise<void> {
  let buffer: ArrayBuffer
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    buffer = bytes.buffer
  } else {
    buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
  }
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: buffer,
      success: () => resolve(),
      fail: reject,
    })
  })
}
