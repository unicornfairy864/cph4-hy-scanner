import { createScanPdf, readImageBytes } from '../../services/pdf'
import type { WrongQuestion } from './archive'

const WIDTH = 1000
const HEIGHT = 1414
const MARGIN = 70
const CONTENT_WIDTH = WIDTH - MARGIN * 2
const LINE_HEIGHT = 42
const CONTENT_LINES = 26

interface PrintContext {
  fillStyle: string
  font: string
  textBaseline: 'top'
  fillRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
}

interface PrintCanvas {
  getContext(type: '2d'): PrintContext | null
  toDataURL?(type: 'image/jpeg', quality: number): string
}

const platform = () => wx as unknown as {
  createOffscreenCanvas(options: { type: '2d'; width: number; height: number }): PrintCanvas
  canvasToTempFilePath(options: {
    canvas: PrintCanvas; fileType: 'jpg'; quality: number
    success(result: { tempFilePath: string }): void
    fail(error: unknown): void
  }): void
}

interface PrintLine {
  text: string
  title?: boolean
}

const normalFont = '27px sans-serif'
const boldFont = 'bold 29px sans-serif'

function wrap(text: string, measure: (value: string) => number): string[] {
  const output: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    // Keep ordinary English words intact when possible, and wrap CJK at character boundaries.
    for (const word of paragraph.match(/[a-zA-Z0-9._-]+|\s+|./gu) ?? []) {
      if (line && measure(line + word) > CONTENT_WIDTH) {
        output.push(line.trimEnd())
        line = ''
      }
      if (!line && /^\s+$/u.test(word)) continue
      if (measure(word) <= CONTENT_WIDTH) {
        line += word
        continue
      }
      for (const character of word) {
        if (line && measure(line + character) > CONTENT_WIDTH) {
          output.push(line)
          line = ''
        }
        line += character
      }
    }
    output.push(line.trimEnd())
  }
  return output
}

function paginate(context: PrintContext, questions: WrongQuestion[]): PrintLine[][] {
  const pages: PrintLine[][] = [[]]
  let page = pages[0]
  for (const [index, question] of questions.entries()) {
    const block: PrintLine[] = []
    const append = (text: string, title = false) => {
      context.font = title ? boldFont : normalFont
      block.push(...wrap(text, (value) => context.measureText(value).width).map((line) => ({ text: line, title })))
    }
    append(`${index + 1}. ${question.number ? `题号 ${question.number}` : '错题'}`, true)
    if (question.source) append(question.source)
    append(`题目  ${question.question}`)
    if (question.studentAnswer) append(`原作答  ${question.studentAnswer}`)
    if (question.referenceAnswer) append(`参考答案  ${question.referenceAnswer}`)
    if (question.correction) append(`批改记录  ${question.correction}`)
    if (question.evidence) append(`核对依据  ${question.evidence}`)
    if (page.length && block.length + page.length + 1 > CONTENT_LINES) {
      page = []
      pages.push(page)
    }
    for (const line of block) {
      if (page.length === CONTENT_LINES) {
        page = [{ text: `${index + 1}. 错题（续）`, title: true }]
        pages.push(page)
      }
      page.push(line)
    }
    if (page.length < CONTENT_LINES) page.push({ text: '' })
  }
  return pages
}

async function snapshot(canvas: PrintCanvas): Promise<Uint8Array> {
  let filePath: string | undefined
  try {
    filePath = await new Promise<string>((resolve, reject) => {
      platform().canvasToTempFilePath({
        canvas, fileType: 'jpg', quality: 0.92,
        success: ({ tempFilePath }) => resolve(tempFilePath), fail: reject,
      })
    })
  } catch {
    const prefix = 'data:image/jpeg;base64,'
    const data = canvas.toDataURL?.('image/jpeg', 0.92) ?? ''
    if (!data.startsWith(prefix)) throw new Error('无法生成错题打印页面。')
    return new Uint8Array(wx.base64ToArrayBuffer(data.slice(prefix.length)))
  }
  try {
    return await readImageBytes(filePath)
  } finally {
    wx.getFileSystemManager().unlink({ filePath, fail: () => undefined })
  }
}

export async function createWrongQuestionsPdf(
  questions: WrongQuestion[], isCancelled: () => boolean,
): Promise<Uint8Array> {
  if (!questions.length) throw new Error('请至少选择一道归档错题。')
  const canvas = platform().createOffscreenCanvas({ type: '2d', width: WIDTH, height: HEIGHT })
  const drawing = canvas.getContext('2d')
  if (!drawing) throw new Error('当前微信版本无法生成错题打印页面。')
  const pages = paginate(drawing, questions)
  return createScanPdf(pages.length, async (index) => {
    if (isCancelled()) throw new Error('导出已结束。')
    drawing.fillStyle = '#ffffff'
    drawing.fillRect(0, 0, WIDTH, HEIGHT)
    drawing.textBaseline = 'top'
    drawing.fillStyle = '#1f2422'
    drawing.font = 'bold 47px sans-serif'
    drawing.fillText('错题整理', MARGIN, 55)
    drawing.font = normalFont
    drawing.fillText(`共 ${questions.length} 题 · 第 ${index + 1} / ${pages.length} 页`, MARGIN, 124)
    drawing.fillRect(MARGIN, 168, CONTENT_WIDTH, 2)
    pages[index].forEach(({ text, title }, line) => {
      drawing.font = title ? boldFont : normalFont
      drawing.fillText(text, MARGIN, 198 + line * LINE_HEIGHT)
    })
    return snapshot(canvas)
  })
}
