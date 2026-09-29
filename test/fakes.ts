import { vi } from 'vitest';

// Minimal stand-ins for the media and canvas APIs, enough to observe
// allocation, release and lifecycle calls without a browser.

export class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
    fill: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4).fill(fill);
  }
}

export class FakeContext {
  pixelValue = 128;
  readonly drawImage = vi.fn();
  readonly clearRect = vi.fn();
  readonly setTransform = vi.fn();
  constructor(readonly canvas: FakeCanvas | FakeOffscreenCanvas) {}
  getImageData(_x: number, _y: number, w: number, h: number): FakeImageData {
    return new FakeImageData(w, h, this.pixelValue);
  }
}

abstract class SizedCanvas {
  private w = 300;
  private h = 150;
  /** Every assignment to width or height, as the backing store is reallocated each time. */
  readonly resizes: Array<['width' | 'height', number]> = [];
  ctx: FakeContext | null;
  constructor() {
    this.ctx = new FakeContext(this as unknown as FakeCanvas);
  }
  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = v;
    this.resizes.push(['width', v]);
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = v;
    this.resizes.push(['height', v]);
  }
  getContext(_kind: string, _opts?: unknown): FakeContext | null {
    return this.ctx;
  }
}

export class FakeCanvas extends SizedCanvas {
  blobResult: 'blob' | 'null' = 'blob';
  toBlob(cb: (b: Blob | null) => void, type = 'image/png', _q?: number): void {
    cb(this.blobResult === 'blob' ? new Blob(['frame'], { type }) : null);
  }
  toDataURL(type = 'image/png'): string {
    return `data:${type};base64,${btoa('frame')}`;
  }
}

export class FakeOffscreenCanvas extends SizedCanvas {
  static instances: FakeOffscreenCanvas[] = [];
  static contextAvailable = true;
  constructor(w: number, h: number) {
    super();
    this.width = w;
    this.height = h;
    this.resizes.length = 0;
    if (!FakeOffscreenCanvas.contextAvailable) this.ctx = null;
    FakeOffscreenCanvas.instances.push(this);
  }
  convertToBlob(opts: { type?: string } = {}): Promise<Blob> {
    return Promise.resolve(new Blob(['frame'], { type: opts.type ?? 'image/png' }));
  }
}

export class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  readonly stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  readonly applyConstraints = vi.fn(async () => undefined);
  private listeners = new Map<string, Set<() => void>>();
  capabilities: Record<string, unknown> = { width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 } };
  constructor(readonly settings: Record<string, unknown> = {}) {}
  getSettings(): Record<string, unknown> {
    return this.settings;
  }
  getCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    this.readyState = 'ended';
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

export class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(
    public active = true,
    settings: Record<string, unknown> = {},
  ) {
    this.tracks = [new FakeTrack(settings)];
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks;
  }
}

export class FakeVideo {
  static frameWidth = 1280;
  static frameHeight = 720;
  readonly attributes = new Map<string, string>();
  readonly style = { cssText: '' };
  muted = false;
  src = '';
  videoWidth = 0;
  videoHeight = 0;
  parent: FakeBody | null = null;
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly load = vi.fn();
  private stream: unknown = null;
  get srcObject(): unknown {
    return this.stream;
  }
  set srcObject(v: unknown) {
    this.stream = v;
    this.videoWidth = v ? FakeVideo.frameWidth : 0;
    this.videoHeight = v ? FakeVideo.frameHeight : 0;
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k);
    if (k === 'src') this.src = '';
  }
  remove(): void {
    this.parent?.children.delete(this);
    this.parent = null;
  }
}

/** A video element from an engine without `srcObject`. */
export class LegacyVideo {
  readonly attributes = new Map<string, string>();
  readonly style = { cssText: '' };
  muted = false;
  videoWidth = 0;
  videoHeight = 0;
  private url = '';
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly load = vi.fn();
  get src(): string {
    return this.url;
  }
  set src(v: string) {
    this.url = v;
    this.videoWidth = v ? 640 : 0;
    this.videoHeight = v ? 480 : 0;
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k);
  }
  remove(): void {}
}

export class FakeBody {
  readonly children = new Set<unknown>();
  appendChild(el: FakeVideo): void {
    this.children.add(el);
    el.parent = this;
  }
}

export interface Env {
  canvases: FakeCanvas[];
  videos: FakeVideo[];
  body: FakeBody;
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
  createImageBitmap: ReturnType<typeof vi.fn>;
  bitmaps: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }>;
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
}

/** Installs the fakes as globals. Pair with `vi.unstubAllGlobals()`. */
export function installFakes(opts: { mediaDevices?: boolean } = {}): Env {
  const canvases: FakeCanvas[] = [];
  const videos: FakeVideo[] = [];
  const body = new FakeBody();
  const bitmaps: Env['bitmaps'] = [];

  const document = {
    body,
    createElement: vi.fn((tag: string) => {
      if (tag === 'canvas') {
        const c = new FakeCanvas();
        canvases.push(c);
        return c;
      }
      if (tag === 'video') {
        const v = new FakeVideo();
        videos.push(v);
        return v;
      }
      throw new Error(`unexpected element ${tag}`);
    }),
  };

  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    const video = c.video as { facingMode?: { ideal?: string; exact?: string } } | true;
    const facing = video === true ? 'user' : (video.facingMode?.ideal ?? video.facingMode?.exact ?? 'user');
    return new FakeStream(true, { facingMode: facing });
  });
  const enumerateDevices = vi.fn(async () => []);

  const createImageBitmap = vi.fn(async (src: { width: number; height: number }) => {
    const b = { width: src.width, height: src.height, close: vi.fn() };
    bitmaps.push(b);
    return b;
  });

  let n = 0;
  const createObjectURL = vi.fn(() => `blob:fake/${++n}`);
  const revokeObjectURL = vi.fn();

  vi.stubGlobal('document', document);
  vi.stubGlobal('navigator', opts.mediaDevices === false ? {} : { mediaDevices: { getUserMedia, enumerateDevices } });
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('OffscreenCanvas', undefined);
  vi.stubGlobal('ImageCapture', undefined);
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));

  return {
    canvases,
    videos,
    body,
    getUserMedia,
    enumerateDevices,
    createImageBitmap,
    bitmaps,
    createObjectURL,
    revokeObjectURL,
  };
}
