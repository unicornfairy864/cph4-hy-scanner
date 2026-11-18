import type { ImageMode, Quad, Rotation } from '../../image'

export const exportQualities = [
  { label: '标准', maxDimension: 1600, jpegQuality: 0.8 },
  { label: '清晰', maxDimension: 2400, jpegQuality: 0.9 },
]

export interface ExportPage {
  imagePath: string
  corners: Quad
  rotation: Rotation
  mode: ImageMode
  enhance: boolean
  denoise: boolean
  dewarp: boolean
  enhanced?: string
}

export interface PdfSession {
  pages: ExportPage[]
  selected: number
}
