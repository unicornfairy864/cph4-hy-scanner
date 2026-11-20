import assert from 'node:assert/strict'
import { test } from 'node:test'
import { degrees, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { buildImagePdfPreview, readImagePdfPage } from '../miniprogram/services/pdf-preview'
import { createScanPdf, scanPdfLayout } from '../miniprogram/services/pdf'

const jpeg = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AUn//2Q==',
  'base64',
))

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${actual} to equal ${expected}`)
}

test('extracts the sole JPEG from a scanner PDF and matches its centered position', async () => {
  const bytes = await createScanPdf(2, async () => jpeg)
  const page = await readImagePdfPage(bytes, 1)
  assert.ok(page)
  assert.deepEqual(page.jpeg, jpeg)
  assert.deepEqual([page.imageWidth, page.imageHeight], [2, 3])
  const layout = scanPdfLayout(2, 3)
  near(page.left, layout.image.left / layout.width)
  near(page.top, layout.image.top / layout.height)
  near(page.width, layout.image.width / layout.width)
  near(page.height, layout.image.height / layout.height)
  assert.equal(await readImagePdfPage(bytes, 2), undefined)
})

test('preserves translation and scale relative to the visible crop when the JPEG fits entirely', async () => {
  const document = await PDFDocument.create()
  const image = await document.embedJpg(jpeg)
  const page = document.addPage([600, 800])
  page.setMediaBox(10, 20, 600, 800)
  page.setCropBox(40, 70, 500, 715)
  page.drawImage(image, { x: 80, y: 100, width: 420, height: 600 })
  const preview = await readImagePdfPage(await document.save(), 0)
  assert.ok(preview)
  near(preview.left, 40 / 500)
  near(preview.top, 85 / 715)
  near(preview.width, 420 / 500)
  near(preview.height, 600 / 715)
})

test('declines pages with extra marks, annotations, rotation, clipping, or unsupported image objects', async () => {
  const document = await PDFDocument.create()
  const image = await document.embedJpg(jpeg)
  const picture = () => {
    const page = document.addPage([210, 300])
    page.drawImage(image, { x: 30, y: 20, width: 150, height: 240 })
    return page
  }
  picture().drawText('Text over the photo', { x: 70, y: 120 })
  picture().setRotation(degrees(90))
  picture().setCropBox(40, 25, 160, 220)
  picture().drawImage(image, { x: 175, y: 225, width: 20, height: 30 })
  const annotated = picture()
  annotated.node.set(PDFName.of('Annots'), document.context.obj([document.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [100, 100, 120, 120],
  })]))
  const invalidImage = picture()
  const resources = invalidImage.node.Resources()
  assert.ok(resources)
  const xObjects = resources.lookup(PDFName.of('XObject'), PDFDict)
  const [imageKey] = xObjects.keys()
  assert.ok(imageKey)
  xObjects.set(imageKey, document.context.obj({ Type: 'XObject', Subtype: 'Image' }))
  const bytes = await document.save()
  for (let i = 0; i < document.getPageCount(); i += 1) {
    assert.equal(await readImagePdfPage(bytes, i), undefined)
  }
})

test('provides a caller-owned preview JPEG and deletes the temporary file if WeChat rejects it', async () => {
  const bytes = await createScanPdf(1, async () => jpeg)
  const writes: string[] = []
  const deleted: string[] = []
  let orientation = 'up'
  Object.defineProperty(globalThis, 'wx', {
    configurable: true,
    value: {
      env: { USER_DATA_PATH: 'wxfile://usr' },
      getFileSystemManager: () => ({
        writeFile: ({ filePath, data, success }: { filePath: string; data: ArrayBuffer; success: () => void }) => {
          assert.deepEqual(new Uint8Array(data), jpeg)
          writes.push(filePath)
          success()
        },
        unlink: ({ filePath }: { filePath: string }) => { deleted.push(filePath) },
      }),
      getImageInfo: ({ src, success }: { src: string; success: (value: object) => void }) => {
        assert.equal(src, writes[writes.length - 1])
        success({ width: 2, height: 3, orientation })
      },
    },
  })

  try {
    const preview = await buildImagePdfPreview(bytes, 0)
    assert.ok(preview)
    assert.equal(preview.imagePath, writes[0])
    assert.equal(deleted.length, 0)
    orientation = 'right'
    assert.equal(await buildImagePdfPreview(bytes, 0), undefined)
    assert.deepEqual(deleted, [writes[1]])
  } finally {
    Reflect.deleteProperty(globalThis, 'wx')
  }
})
