import type { ImageDecorations, ImageMode, Quad, Rotation, SharpenStrength } from '../../image'
import type { PdfPageRange } from '../../services/pdf'

export type ExportScope = 'all' | 'current' | 'range'

export const exportQualities = [
  { label: '标准', maxDimension: 1600, jpegQuality: 0.8 },
  { label: '清晰', maxDimension: 2400, jpegQuality: 0.9 },
]

export interface PreviewImage {
  imagePath: string
  width: number
  height: number
  rotation: Rotation
}

export interface ExportPage {
  imagePath: string
  corners: Quad
  rotation: Rotation
  mode: ImageMode
  enhance: boolean
  denoise: boolean
  dewarp: boolean
  sharpen?: SharpenStrength
  decorations?: ImageDecorations
  enhanced?: string
  preview?: PreviewImage
}

export interface PdfSession {
  pages: ExportPage[]
  selected: number
}

export function exportPageRange(
  scope: ExportScope, count: number, selected: number, first: string, last: string,
): PdfPageRange {
  if (scope === 'all') return { start: 0, end: count }
  if (scope === 'current') return { start: selected, end: selected + 1 }
  const start = /^\d+$/.test(first.trim()) ? Number(first.trim()) : NaN
  const end = /^\d+$/.test(last.trim()) ? Number(last.trim()) : NaN
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > count) {
    throw new Error(`请输入 1 至 ${count} 之间的有效起止页码`)
  }
  return { start: start - 1, end }
}
