import { PDFDocument } from 'pdf-lib'

const A4_SHORT = 595.28
const A4_LONG = 841.89

export async function createScanPdf(count: number, render: (index: number) => Promise<Uint8Array>): Promise<Uint8Array> {
  if (count === 0) {
    throw new Error('请先添加至少一页。')
  }

  const document = await PDFDocument.create()
  for (let index = 0; index < count; index += 1) {
    const bytes = await render(index)
    const image = await document.embedJpg(bytes)
    const landscape = image.width > image.height
    const width = landscape ? A4_LONG : A4_SHORT
    const height = landscape ? A4_SHORT : A4_LONG
    const scale = Math.min(width / image.width, height / image.height)
    const imageWidth = image.width * scale
    const imageHeight = image.height * scale
    document.addPage([width, height]).drawImage(image, {
      x: (width - imageWidth) / 2,
      y: (height - imageHeight) / 2,
      width: imageWidth,
      height: imageHeight,
    })
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
