export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point];
export type CornerConfidences = [number, number, number, number];
export type Rotation = 0 | 90 | 180 | 270;
export type ImageMode = 'color' | 'grayscale' | 'bw';
export type ImageQuality = 'preview' | 'export';
export type SharpenStrength = 'off' | 'mild' | 'strong';

export interface MosaicRegion extends Point {
  width: number;
  height: number;
  blockSize?: number;
}

export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FinishOptions {
  sharpen?: SharpenStrength;
  mosaics?: MosaicRegion[];
}

export interface RenderOptions extends FinishOptions {
  corners: Quad;
  rotation: Rotation;
  mode: ImageMode;
  denoise: boolean;
  enhance?: boolean;
  dewarp?: boolean;
  maxDimension: number;
}

export interface Detection {
  corners: Quad | null;
  confidence: number;
  cornerConfidences: CornerConfidences;
}

export type ImageOperation =
  | { type: 'detect' }
  | { type: 'render'; options: RenderOptions }
  | { type: 'finish'; options: FinishOptions };

export interface WorkerRequest {
  id: number;
  operation: ImageOperation;
  width: number;
  height: number;
  pixels: ArrayBuffer;
}

export type WorkerReply =
  | { id: number; type: 'detect'; result: Detection }
  | { id: number; type: 'render'; width: number; height: number; pixels: ArrayBuffer }
  | { id: number; type: 'error'; message: string };
