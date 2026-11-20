import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePDFRawStream, degrees, PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import {
  createScanPdf, inspectSigningPdf, maxSigningPdfBytes, normalizeSignature, signExistingPdf, signatureRectangle,
} from '../miniprogram/services/pdf'

const portrait = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AUn//2Q==',
  'base64',
)
const landscape = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAQBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AUn//2Q==',
  'base64',
)

function pageContent(page: ReturnType<PDFDocument['getPage']>): string {
  const streams = page.node.Contents()
  if (!streams) return ''
  assert.ok(streams instanceof PDFArray)
  return Array.from({ length: streams.size() }, (_, index) => {
    return new TextDecoder().decode(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode())
  }).join('\n')
}

test('merges selected JPGs in order and preserves each page orientation', async () => {
  const images = [landscape, portrait, landscape]
  const rendered: number[] = []
  const bytes = await createScanPdf(images.length, async (index) => {
    rendered.push(index)
    return images[index]
  })
  assert.deepEqual(rendered, [0, 1, 2])
  const document = await PDFDocument.load(bytes)
  assert.equal(document.getPageCount(), 3)
  assert.deepEqual(document.getPages().map((page) => page.getSize()), [
    { width: 841.89, height: 595.28 },
    { width: 595.28, height: 841.89 },
    { width: 841.89, height: 595.28 },
  ])
})

test('rejects an empty PDF export', async () => {
  await assert.rejects(createScanPdf(0, async () => portrait), /至少一页/)
})

test('stamps vector ink only on selected PDF pages, including landscape edges', async () => {
  assert.equal(normalizeSignature([]), undefined)
  const ink = normalizeSignature([[{ x: 22, y: 15 }, { x: 72, y: 31 }]])
  assert.ok(ink)
  assert.equal(ink.width, 50)
  assert.equal(ink.height, 16)
  const signature = { ink, center: { x: 1.5, y: -1 } }
  const rect = signatureRectangle(signature, 841.89, 595.28)
  assert.ok(rect.left + rect.width + rect.thickness <= 841.89)
  assert.equal(rect.top, rect.thickness)

  const bytes = await createScanPdf(2, async (index) => index === 0 ? portrait : landscape,
    (index) => index === 1 ? signature : undefined)
  const document = await PDFDocument.load(bytes)
  const [unsigned, signed] = document.getPages()
  assert.deepEqual(unsigned.getSize(), { width: 595.28, height: 841.89 })
  assert.deepEqual(signed.getSize(), { width: 841.89, height: 595.28 })
  assert.doesNotMatch(pageContent(unsigned), /(?:^|\n)1 J\n/)
  const savedInk = pageContent(signed)
  assert.match(savedInk, /(?:^|\n)1 J\n/)
  const points = Array.from(savedInk.matchAll(/([\d.]+) ([\d.]+) [ml]/g))
  assert.ok(points.some(([, x, y]) => Math.abs(Number(x) - rect.left) < 1e-8 && Math.abs(Number(y) - (595.28 - rect.top)) < 1e-8))
  assert.ok(points.some(([, x, y]) => Math.abs(Number(x) - (rect.left + rect.width)) < 1e-8
    && Math.abs(Number(y) - (595.28 - rect.top - rect.height)) < 1e-8))
})

test('signs an imported page using the visible crop and rotation without changing the source or other pages', async () => {
  const source = await PDFDocument.create()
  const untouched = source.addPage([400, 605])
  untouched.drawText('Original first page')
  const rotated = source.addPage([600, 800])
  rotated.setMediaBox(10, 20, 600, 800)
  rotated.setCropBox(40, 65, 500, 715)
  rotated.setRotation(degrees(90))
  rotated.drawText('Original rotated page')
  const original = await source.save()
  const originalBytes = original.slice()
  const originalDocument = await PDFDocument.load(original)
  const pages = await inspectSigningPdf(original)
  assert.deepEqual(pages, [{ width: 400, height: 605 }, { width: 715, height: 500 }])

  const ink = normalizeSignature([[{ x: 22, y: 15 }, { x: 72, y: 31 }]])
  assert.ok(ink)
  const signature = { ink, center: { x: 0.8, y: 0.8 } }
  const rect = signatureRectangle(signature, pages[1].width, pages[1].height)
  const signed = await signExistingPdf(original, new Map([[1, signature]]))
  assert.deepEqual(original, originalBytes)
  assert.notDeepEqual(signed, original)
  const reopened = await PDFDocument.load(signed)
  assert.equal(reopened.getPageCount(), 2)
  assert.equal(reopened.getPage(1).getRotation().angle, 90)
  assert.deepEqual(reopened.getPage(1).getMediaBox(), { x: 10, y: 20, width: 600, height: 800 })
  assert.deepEqual(reopened.getPage(1).getCropBox(), { x: 40, y: 65, width: 500, height: 715 })
  assert.equal(pageContent(reopened.getPage(0)), pageContent(originalDocument.getPage(0)))
  const contents = pageContent(reopened.getPage(1))
  assert.ok(contents.includes(pageContent(originalDocument.getPage(1))))
  const points = Array.from(contents.matchAll(/([\d.]+) ([\d.]+) [ml]/g))
  assert.ok(points.some(([, x, y]) => Math.abs(Number(x) - (40 + rect.top)) < 1e-8
    && Math.abs(Number(y) - (65 + rect.left)) < 1e-8))
})

test('rejects unsupported PDF inputs before attempting to sign', async () => {
  await assert.rejects(inspectSigningPdf(new Uint8Array(maxSigningPdfBytes + 1)), /10 MB/)
  await assert.rejects(inspectSigningPdf(new Uint8Array([1, 2, 3])), /无法读取/)
  const oversized = await PDFDocument.create()
  for (let index = 0; index < 51; index += 1) oversized.addPage()
  await assert.rejects(inspectSigningPdf(await oversized.save()), /50 页/)
  const restricted = await PDFDocument.create()
  restricted.addPage()
  restricted.catalog.set(PDFName.of('Perms'), restricted.context.obj({}))
  await assert.rejects(inspectSigningPdf(await restricted.save()), /编辑限制/)
  const encrypted = await PDFDocument.create()
  encrypted.addPage()
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2 }))
  await assert.rejects(inspectSigningPdf(await encrypted.save()), /加密 PDF/)
})
