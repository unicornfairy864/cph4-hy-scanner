import { degrees, EncryptedPDFError, LineCapStyle, PDFAcroSignature, PDFDocument, PDFName, rgb } from 'pdf-lib'
import type { PDFImage, PDFPage } from 'pdf-lib'

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

export interface SignatureImage {
  imagePath: string
  bytes: Uint8Array
  width: number
  height: number
  format: 'png' | 'jpg'
}

export type PageSignature = { center: Point } & ({ ink: SignatureInk } | { image: SignatureImage })

export interface PdfPageRange {
  start: number
  end: number
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

export function signatureImageFormat(bytes: Uint8Array): SignatureImage['format'] | undefined {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg'
}

export function signatureRectangle(signature: PageSignature, pageWidth: number, pageHeight: number) {
  const { center } = signature
  const art = 'ink' in signature ? signature.ink : signature.image
  const shortSide = Math.min(pageWidth, pageHeight)
  const scale = Math.min(shortSide * 0.34 / art.width, shortSide * 0.18 / art.height)
  const width = art.width * scale
  const height = art.height * scale
  const thickness = shortSide * 0.003
  return {
    left: Math.max(thickness, Math.min(pageWidth - width - thickness, center.x * pageWidth - width / 2)),
    top: Math.max(thickness, Math.min(pageHeight - height - thickness, center.y * pageHeight - height / 2)),
    width, height, thickness,
  }
}

async function drawSignature(
  page: PDFPage, signature: PageSignature, width: number, height: number,
  embeddedImages: Map<SignatureImage, PDFImage>,
  toPdf: (point: Point) => Point = ({ x, y }) => ({ x, y: height - y }),
  rotation = 0,
): Promise<void> {
  const rect = signatureRectangle(signature, width, height)
  if ('image' in signature) {
    const source = signature.image
    let embedded = embeddedImages.get(source)
    if (!embedded) {
      const bytes = wholeByteView(source.bytes)
      embedded = await (source.format === 'png' ? page.doc.embedPng(bytes) : page.doc.embedJpg(bytes))
      embeddedImages.set(source, embedded)
    }
    const origin = toPdf({ x: rect.left, y: rect.top + rect.height })
    page.drawImage(embedded, { ...origin, width: rect.width, height: rect.height, rotate: degrees(rotation) })
    return
  }
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

function wholeByteView(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes)
}

export async function createScanPdf(
  count: number, render: (index: number) => Promise<Uint8Array>, signatureAt?: (index: number) => PageSignature | undefined,
): Promise<Uint8Array> {
  if (count === 0) {
    throw new Error('请先添加至少一页。')
  }

  const document = await PDFDocument.create()
  const embeddedImages = new Map<SignatureImage, PDFImage>()
  for (let index = 0; index < count; index += 1) {
    const bytes = await render(index)
    // pdf-lib reads the JPEG header from the backing buffer, starting at offset zero.
    const image = await document.embedJpg(wholeByteView(bytes))
    const { width, height, image: rect } = scanPdfLayout(image.width, image.height)
    const page = document.addPage([width, height])
    page.drawImage(image, {
      x: rect.left, y: height - rect.top - rect.height,
      width: rect.width, height: rect.height,
    })
    const signature = signatureAt?.(index)
    if (signature) await drawSignature(page, signature, width, height, embeddedImages)
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
    rotation,
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

export async function signExistingPdf(
  bytes: Uint8Array, signatures: ReadonlyMap<number, PageSignature>, range?: PdfPageRange,
): Promise<Uint8Array> {
  if (!signatures.size) throw new Error('请先在至少一页添加签名')
  const original = await loadSigningPdf(bytes)
  const count = original.getPageCount()
  const { start, end } = range ?? { start: 0, end: count }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > count || start >= end) {
    throw new Error('请选择有效的 PDF 页码范围')
  }
  if (![...signatures.keys()].some((index) => index >= start && index < end)) {
    throw new Error('请在所选范围内的至少一页添加签名')
  }
  let document = original
  if (start !== 0 || end !== count) {
    document = await PDFDocument.create()
    const selectedPages = await document.copyPages(original, Array.from({ length: end - start }, (_, index) => start + index))
    for (const page of selectedPages) document.addPage(page)
  }
  const embeddedImages = new Map<SignatureImage, PDFImage>()
  const pages = document.getPages()
  for (let index = 0; index < pages.length; index += 1) {
    const signature = signatures.get(start + index)
    if (!signature) continue
    const page = pages[index]
    const bounds = visiblePage(page)
    await drawSignature(page, signature, bounds.width, bounds.height, embeddedImages, bounds.toPdf, bounds.rotation)
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
