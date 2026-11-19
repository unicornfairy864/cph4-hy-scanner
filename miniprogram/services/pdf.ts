import { EncryptedPDFError, LineCapStyle, PDFAcroSignature, PDFDocument, PDFName, rgb } from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'

const A4_SHORT = 595.28
const A4_LONG = 841.89
export const maxSigningPdfBytes = 10 * 1024 * 1024
const maxSigningPdfPages = 50

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

function drawSignature(
  page: PDFPage, signature: PageSignature, width: number, height: number,
  toPdf: (point: Point) => Point = ({ x, y }) => ({ x, y: height - y }),
): void {
  const rect = signatureRectangle(signature, width, height)
  const color = rgb(0.08, 0.13, 0.12)
  const coordinates = ({ x, y }: Point) => toPdf({ x: rect.left + x * rect.width, y: rect.top + y * rect.height })
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

async function loadSigningPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (bytes.byteLength > maxSigningPdfBytes) throw new Error('请选择 10 MB 以内的 PDF')
  let document: PDFDocument
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
  } catch (error) {
    if (error instanceof EncryptedPDFError
      || (error instanceof Error && error.message.startsWith('Input document to `PDFDocument.load` is encrypted.'))) {
      throw new Error('无法签署加密 PDF')
    }
    throw new Error('无法读取此 PDF，请检查文件是否完整')
  }
  if (!document.getPageCount() || document.getPageCount() > maxSigningPdfPages) throw new Error('请选择 1 至 50 页的 PDF')
  const digitalSignature = document.catalog.getAcroForm()?.getAllFields().some(
    ([field]) => field instanceof PDFAcroSignature && field.dict.has(PDFName.of('V')),
  )
  if (digitalSignature || document.catalog.has(PDFName.of('Perms'))) throw new Error('此 PDF 已含数字签名或编辑限制')
  return document
}

function visiblePage(page: PDFPage) {
  const media = page.getMediaBox()
  const crop = page.getCropBox()
  const left = Math.max(media.x, crop.x)
  const bottom = Math.max(media.y, crop.y)
  const right = Math.min(media.x + media.width, crop.x + crop.width)
  const top = Math.min(media.y + media.height, crop.y + crop.height)
  const rawWidth = right - left
  const rawHeight = top - bottom
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  if (!Number.isFinite(rawWidth) || rawWidth <= 0 || !Number.isFinite(rawHeight) || rawHeight <= 0 || rotation % 90 !== 0) {
    throw new Error('无法读取此 PDF 的页面尺寸')
  }
  const quarterTurn = rotation === 90 || rotation === 270
  return {
    width: quarterTurn ? rawHeight : rawWidth,
    height: quarterTurn ? rawWidth : rawHeight,
    toPdf({ x, y }: Point): Point {
      switch (rotation) {
        case 90: return { x: left + y, y: bottom + x }
        case 180: return { x: right - x, y: bottom + y }
        case 270: return { x: right - y, y: top - x }
        default: return { x: left + x, y: top - y }
      }
    },
  }
}

export async function inspectSigningPdf(bytes: Uint8Array): Promise<Array<{ width: number; height: number }>> {
  const document = await loadSigningPdf(bytes)
  return document.getPages().map((page) => {
    const { width, height } = visiblePage(page)
    return { width, height }
  })
}

export async function signExistingPdf(bytes: Uint8Array, signatures: ReadonlyMap<number, PageSignature>): Promise<Uint8Array> {
  if (!signatures.size) throw new Error('请先在至少一页添加手写签名')
  const document = await loadSigningPdf(bytes)
  const pages = document.getPages()
  for (const [index, signature] of signatures) {
    const page = pages[index]
    if (!page) continue
    const bounds = visiblePage(page)
    drawSignature(page, signature, bounds.width, bounds.height, bounds.toPdf)
  }
  return document.save({ objectsPerTick: 20, useObjectStreams: false, updateFieldAppearances: false })
}

export function readFileBytes(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: ({ data }) => {
        if (typeof data === 'string') {
          reject(new Error('无法读取文件。'))
          return
        }
        resolve(new Uint8Array(data))
      },
      fail: reject,
    })
  })
}

export { readFileBytes as readImageBytes }

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
