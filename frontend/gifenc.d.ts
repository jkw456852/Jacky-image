declare module 'gifenc' {
  export interface GIFEncoderOptions {
    initialCapacity?: number;
    auto?: boolean;
  }

  export interface WriteFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    /** Frame delay in milliseconds. */
    delay?: number;
    /** First-frame palette (Array of [r,g,b] or [r,g,b,a] tuples). */
    palette?: number[][] | null;
    /** -1 = play once, 0 = forever, >0 = repeat N times. Only honored on the first frame. */
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    readonly stream: unknown;
    writeHeader(): void;
    writeFrame(
      indexedPixels: Uint8Array | Uint8ClampedArray,
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
  }

  export function GIFEncoder(opts?: GIFEncoderOptions): GIFEncoderInstance;

  export interface QuantizeOptions {
    format?: 'rgb565' | 'rgb444' | 'rgba4444';
    clearAlpha?: boolean;
    clearAlphaColor?: number;
    clearAlphaThreshold?: number;
    oneBitAlpha?: boolean | number;
    useSqrt?: boolean;
  }

  export function quantize(
    data: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: QuantizeOptions,
  ): number[][];

  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;

  export function nearestColor(palette: number[][], pixel: number[], distFn?: (a: number[], b: number[]) => number): number[];
  export function nearestColorIndex(palette: number[][], pixel: number[], distFn?: (a: number[], b: number[]) => number): number;
  export function nearestColorIndexWithDistance(
    palette: number[][],
    pixel: number[],
    distFn?: (a: number[], b: number[]) => number,
  ): [number, number];
  export function snapColorsToPalette(palette: number[][], snapColors: number[][], threshold?: number): void;
  export function prequantize(
    data: Uint8Array | Uint8ClampedArray,
    opts?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;

  const _default: typeof GIFEncoder;
  export default _default;
}
