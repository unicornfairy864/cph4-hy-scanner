export interface WrongQuestion {
  id: string
  source: string
  number: string
  question: string
  studentAnswer: string
  referenceAnswer: string
  correction: string
  evidence: string
}

const STORAGE_KEY = 'scanner-wrong-questions-v1'
export const MAX_ARCHIVED_QUESTIONS = 50

const textLimits = {
  source: 100,
  number: 48,
  question: 600,
  studentAnswer: 400,
  referenceAnswer: 400,
  correction: 400,
  evidence: 400,
} as const

type QuestionInput = Omit<WrongQuestion, 'id'>

export function normalizeQuestion(input: QuestionInput): QuestionInput {
  return {
    source: input.source.trim().slice(0, textLimits.source),
    number: input.number.trim().slice(0, textLimits.number),
    question: input.question.trim().slice(0, textLimits.question),
    studentAnswer: input.studentAnswer.trim().slice(0, textLimits.studentAnswer),
    referenceAnswer: input.referenceAnswer.trim().slice(0, textLimits.referenceAnswer),
    correction: input.correction.trim().slice(0, textLimits.correction),
    evidence: input.evidence.trim().slice(0, textLimits.evidence),
  }
}

function isStoredQuestion(input: unknown): input is WrongQuestion {
  if (!input || typeof input !== 'object') return false
  const item = input as Record<string, unknown>
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 64
    && Object.keys(textLimits).every((key) => typeof item[key] === 'string')
    && typeof item.question === 'string' && Boolean(item.question.trim())
}

export function loadArchive(): WrongQuestion[] {
  const value: unknown = wx.getStorageSync(STORAGE_KEY)
  if (!Array.isArray(value)) return []
  return value.filter(isStoredQuestion).slice(0, MAX_ARCHIVED_QUESTIONS)
    .map(({ id, ...entry }) => ({ id, ...normalizeQuestion(entry) }))
}

export function persistArchive(entries: WrongQuestion[]): void {
  wx.setStorageSync(STORAGE_KEY, entries)
}

export function mergeArchive(current: WrongQuestion[], entries: QuestionInput[]): { entries: WrongQuestion[]; added: number } {
  const key = (item: QuestionInput) => JSON.stringify([item.question, item.studentAnswer, item.referenceAnswer])
  const seen = new Set(current.map(key))
  const additions: WrongQuestion[] = []
  const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  for (const item of entries) {
    const normalized = normalizeQuestion(item)
    const itemKey = key(normalized)
    if (!normalized.question || seen.has(itemKey) || additions.length + current.length >= MAX_ARCHIVED_QUESTIONS) continue
    seen.add(itemKey)
    additions.push({ id: `${prefix}-${additions.length}`, ...normalized })
  }
  return { entries: [...additions, ...current], added: additions.length }
}
