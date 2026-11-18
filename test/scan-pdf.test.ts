import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { createScanPdf } from '../miniprogram/services/pdf'

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
