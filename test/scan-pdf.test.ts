import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib'
import { createScanPdf, normalizeSignature, signatureRectangle } from '../miniprogram/services/pdf'

const portrait = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AUn//2Q==',
  'base64',
)
const landscape = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAQBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AUn//2Q==',
  'base64',
)

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
  const content = (page: typeof signed) => {
    const streams = page.node.Contents()
    assert.ok(streams instanceof PDFArray)
    const stream = streams.lookup(0, PDFRawStream)
    return new TextDecoder().decode(decodePDFRawStream(stream).decode())
  }
  assert.doesNotMatch(content(unsigned), /(?:^|\n)1 J\n/)
  const savedInk = content(signed)
  assert.match(savedInk, /(?:^|\n)1 J\n/)
  const points = Array.from(savedInk.matchAll(/([\d.]+) ([\d.]+) [ml]/g))
  assert.ok(points.some(([, x, y]) => Math.abs(Number(x) - rect.left) < 1e-8 && Math.abs(Number(y) - (595.28 - rect.top)) < 1e-8))
  assert.ok(points.some(([, x, y]) => Math.abs(Number(x) - (rect.left + rect.width)) < 1e-8
    && Math.abs(Number(y) - (595.28 - rect.top - rect.height)) < 1e-8))
})
