import type { ImageDecorations } from '../../image'

export interface DecorateSession {
  imagePath: string
  temporary: boolean
  allowMosaic: boolean
  decorations?: ImageDecorations
}

export interface DecorationEdits {
  decorations: ImageDecorations
  ownedLogos: string[]
}
