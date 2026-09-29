export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Any2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type CanvasKind = 'auto' | 'element' | 'offscreen';

export interface EncodeOptions {
  /** Image MIME type. Defaults to `image/jpeg`. */
  type?: string;
  /** Encoder quality from 0 to 1. Defaults to `0.92`. */
  quality?: number;
}

/** Frees the pixel buffer of a canvas right away instead of waiting for GC.
 * Safe to call on a canvas that is already released. */
export function releaseCanvas(canvas: AnyCanvas | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function createElementCanvas(): HTMLCanvasElement | null {
  const doc = globalThis.document;
  return doc ? doc.createElement('canvas') : null;
}

function createOffscreenCanvas(): OffscreenCanvas | null {
  return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(0, 0) : null;
}

/** Decodes a data URL into a Blob. Used when `toBlob` hands back null. */
export function dataURLToBlob(dataURL: string): Blob {
  const comma = dataURL.indexOf(',');
  const header = dataURL.slice(0, comma);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const body = dataURL.slice(comma + 1);
  if (!header.includes(';base64')) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** One canvas reused for every frame. WebKit frees a canvas backing store
 * only on GC, so making a new canvas per frame piles up memory. */
export class FrameCanvas {
  private canvas: AnyCanvas | null = null;
  private ctx: Any2DContext | null = null;
  private readonly kind: CanvasKind;
  private disposed = false;

  constructor(kind: CanvasKind = 'auto') {
    this.kind = kind;
  }

  get width(): number {
    return this.canvas?.width ?? 0;
  }

  get height(): number {
    return this.canvas?.height ?? 0;
  }

  /** The kind that was actually created, or `null` before first use. */
  get activeKind(): 'element' | 'offscreen' | null {
    if (!this.canvas) return null;
    return typeof OffscreenCanvas === 'function' && this.canvas instanceof OffscreenCanvas
      ? 'offscreen'
      : 'element';
  }

  private ensure(): Any2DContext {
    if (this.disposed) throw new Error('FrameCanvas has been disposed');
    if (this.ctx && this.canvas) return this.ctx;

    const order: Array<() => AnyCanvas | null> =
      this.kind === 'element'
        ? [createElementCanvas]
        : this.kind === 'offscreen'
          ? [createOffscreenCanvas]
          : [createOffscreenCanvas, createElementCanvas];

    for (const make of order) {
      const canvas = make();
      if (!canvas) continue;
      // alpha:false skips the alpha channel work; willReadFrequently keeps
      // getImageData on the CPU path.
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as Any2DContext | null;
      if (ctx) {
        this.canvas = canvas;
        this.ctx = ctx;
        return ctx;
      }
      releaseCanvas(canvas);
    }
    throw new Error('No 2D canvas context available');
  }

  /** Draws a source scaled to width x height, resizing only when needed. */
  draw(source: CanvasImageSource, width: number, height: number): Any2DContext {
    const ctx = this.ensure();
    const canvas = this.canvas as AnyCanvas;
    // Assigning width reallocates the backing store even if unchanged.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source, 0, 0, width, height);
    return ctx;
  }

  async toBlob(options: EncodeOptions = {}): Promise<Blob> {
    const canvas = this.canvas;
    if (!canvas || !canvas.width) throw new Error('Nothing drawn on the canvas');
    const type = options.type ?? 'image/jpeg';
    const quality = options.quality ?? 0.92;

    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });

    const blob = await new Promise<Blob | null>((resolve) => {
      if (typeof canvas.toBlob !== 'function') return resolve(null);
      canvas.toBlob(resolve, type, quality);
    });
    return blob ?? dataURLToBlob(canvas.toDataURL(type, quality));
  }

  toImageData(): ImageData {
    const ctx = this.ensure();
    return ctx.getImageData(0, 0, this.width, this.height);
  }

  async toBitmap(): Promise<ImageBitmap> {
    if (!this.canvas || !this.canvas.width) throw new Error('Nothing drawn on the canvas');
    return createImageBitmap(this.canvas);
  }

  /** Releases the backing store but keeps the canvas for the next frame. */
  release(): void {
    if (!this.canvas) return;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    releaseCanvas(this.canvas);
  }

  /** Releases the backing store and drops all references. */
  dispose(): void {
    this.release();
    this.canvas = null;
    this.ctx = null;
    this.disposed = true;
  }
}
