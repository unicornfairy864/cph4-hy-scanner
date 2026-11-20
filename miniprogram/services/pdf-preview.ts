import { decodePDFRawStream, JpegEmbedder, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'

const maxPdfBytes = 10 * 1024 * 1024
const maxContentBytes = 1024
const maxDecodedContentBytes = 4096
const maxImagePixels = 6_000_000
const documents = new WeakMap<Uint8Array, Promise<PDFDocument>>()
const imageKeys = new Set([
  '/Type', '/Subtype', '/Width', '/Height', '/ColorSpace', '/BitsPerComponent', '/Filter', '/Length',
])
const pdfNumber = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/
const imageName = /^\/[A-Za-z0-9_.+\-]+$/
let fileSequence = 0

interface Position {
  left: number
  top: number
  width: number
  height: number
}

interface ImagePage extends Position {
  jpeg: Uint8Array
  imageWidth: number
  imageHeight: number
  colorSpace: string
}

export interface ImagePdfPreview extends Position {
  imagePath: string
}

function name(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFName)?.asString()
}

function number(dict: PDFDict, key: string): number | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber()
}

function singleImagePaint(contents: Uint8Array) {
  if (!contents.length || contents.length > maxDecodedContentBytes || contents.some((byte) => byte > 127)) return
  const tokens = String.fromCharCode(...contents).trim().split(/[ \t\r\n\f]+/)
  if (tokens[0] === 'q') {
    tokens.shift()
    if (tokens.pop() !== 'Q') return
  }
  if (tokens.pop() !== 'Do') return
  const image = tokens.pop()
  if (!image || !imageName.test(image) || !tokens.length || tokens.length % 7 !== 0) return

  let x = 0
  let y = 0
  let width = 1
  let height = 1
  for (let index = 0; index < tokens.length; index += 7) {
    const operands = tokens.slice(index, index + 6)
    if (tokens[index + 6] !== 'cm' || !operands.every((operand) => pdfNumber.test(operand))) return
    const [a, b, c, d, e, f] = operands.map(Number)
    if (b !== 0 || c !== 0 || a <= 0 || d <= 0 || ![a, d, e, f].every(Number.isFinite)) return
    x += width * e
    y += height * f
    width *= a
    height *= d
  }
  if (width <= 0 || height <= 0 || ![x, y, width, height].every(Number.isFinite)) return
  return { image: image.slice(1), x, y, width, height }
}

function readContent(page: PDFPage): Uint8Array | undefined {
  const contents = page.node.Contents()
  const stream = contents instanceof PDFArray
    ? (contents.size() === 1 ? contents.lookup(0, PDFRawStream) : undefined)
    : contents
  if (!(stream instanceof PDFRawStream) || stream.dict.has(PDFName.of('DecodeParms'))) return
  const bytes = stream.getContents()
  // Bound allocation before decoding a compressed operator stream.
  if (bytes.byteLength > maxContentBytes) return
  if (!stream.dict.has(PDFName.of('Filter'))) return bytes
  if (name(stream.dict, 'Filter') === '/FlateDecode') return decodePDFRawStream(stream).decode()
}

function imagePage(page: PDFPage): ImagePage | undefined {
  if (page.getRotation().angle % 360 !== 0 || page.node.Annots()?.size()
    || page.node.has(PDFName.of('Group')) || page.node.has(PDFName.of('UserUnit'))) return

  const operators = readContent(page)
  const paint = operators && singleImagePaint(operators)
  if (!paint) return
  const resources = page.node.Resources()
  if (!resources || resources.has(PDFName.of('ColorSpace'))) return
  const images = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  const image = images?.lookupMaybe(PDFName.of(paint.image), PDFRawStream)
  const colorSpace = image && name(image.dict, 'ColorSpace')
  if (!image || image.dict.keys().some((key) => !imageKeys.has(key.asString()))
    || name(image.dict, 'Subtype') !== '/Image' || name(image.dict, 'Filter') !== '/DCTDecode'
    || number(image.dict, 'BitsPerComponent') !== 8
    || (colorSpace !== '/DeviceGray' && colorSpace !== '/DeviceRGB')) return

  const imageWidth = number(image.dict, 'Width') ?? 0
  const imageHeight = number(image.dict, 'Height') ?? 0
  if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight) || imageWidth < 1 || imageHeight < 1
    || imageWidth * imageHeight > maxImagePixels) return
  const jpeg = image.getContents()
  if (jpeg.length < 4 || jpeg[0] !== 255 || jpeg[1] !== 216) return

  const media = page.getMediaBox()
  const crop = page.getCropBox()
  const left = Math.max(media.x, crop.x)
  const bottom = Math.max(media.y, crop.y)
  const right = Math.min(media.x + media.width, crop.x + crop.width)
  const top = Math.min(media.y + media.height, crop.y + crop.height)
  if (![left, bottom, right, top].every(Number.isFinite) || right <= left || top <= bottom) return

  const tolerance = 1e-6
  if (paint.x < left - tolerance || paint.y < bottom - tolerance || paint.x + paint.width > right + tolerance
    || paint.y + paint.height > top + tolerance) return

  return {
    jpeg, imageWidth, imageHeight, colorSpace: colorSpace.slice(1),
    left: Math.max(0, (paint.x - left) / (right - left)),
    top: Math.max(0, (top - paint.y - paint.height) / (top - bottom)),
    width: Math.min(1, paint.width / (right - left)),
    height: Math.min(1, paint.height / (top - bottom)),
  }
}

export async function readImagePdfPage(bytes: Uint8Array, pageIndex: number): Promise<ImagePage | undefined> {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || bytes.byteLength > maxPdfBytes) return
  try {
    let loading = documents.get(bytes)
    if (!loading) {
      loading = PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
      documents.set(bytes, loading)
    }
    const document = await loading
    if (document.catalog.has(PDFName.of('OCProperties')) || pageIndex >= document.getPageCount()) return
    return imagePage(document.getPage(pageIndex))
  } catch {
    return undefined
  }
}

/** Preview only a PDF page whose entire visible content is the extracted JPEG. */
export async function buildImagePdfPreview(bytes: Uint8Array, pageIndex: number): Promise<ImagePdfPreview | undefined> {
  const source = await readImagePdfPage(bytes, pageIndex)
  if (!source) return
  const imagePath = `${wx.env.USER_DATA_PATH}/scan-pdf-page-${Date.now()}-${fileSequence++}.jpg`
  const files = wx.getFileSystemManager()
  try {
    // A stream can view a larger PDF buffer, so write only its JPEG bytes.
    const jpeg = Uint8Array.from(source.jpeg)
    const header = await JpegEmbedder.for(jpeg)
    if (header.width !== source.imageWidth || header.height !== source.imageHeight
      || header.bitsPerComponent !== 8 || header.colorSpace !== source.colorSpace) return
    await new Promise<void>((resolve, reject) => {
      files.writeFile({ filePath: imagePath, data: jpeg.buffer, success: () => resolve(), fail: reject })
    })
    const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => {
      wx.getImageInfo({ src: imagePath, success: resolve, fail: reject })
    })
    if (info.width !== source.imageWidth || info.height !== source.imageHeight
      || (info.orientation && info.orientation !== 'up')) throw new Error('Unsupported embedded JPEG')
    return { imagePath, left: source.left, top: source.top, width: source.width, height: source.height }
  } catch {
    files.unlink({ filePath: imagePath, fail: () => undefined })
    return undefined
  }
}
