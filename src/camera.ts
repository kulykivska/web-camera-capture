import { FrameCanvas, type CanvasKind, type EncodeOptions } from './canvas.js';
import { buildConstraints, type CameraSelection, type FacingMode } from './constraints.js';
import { CameraError, toCameraError } from './errors.js';
import { isBlankImageData, type BlankCheckOptions } from './utils.js';

export type CameraState = 'idle' | 'starting' | 'live' | 'stopped' | 'destroyed';

export interface WebCameraOptions extends CameraSelection {
  /** Preview element. When omitted a hidden, muted one is created and
   * appended to `document.body`, because iOS only decodes attached videos. */
  video?: HTMLVideoElement;
  /** Canvas used for frame grabs. `auto` prefers OffscreenCanvas. */
  canvas?: CanvasKind;
  /** Use `ImageCapture.grabFrame()` for bitmaps where the browser has it. */
  useImageCapture?: boolean;
  /** Shrink the canvas to 0x0 after every capture. Saves memory between
   * sparse captures, costs a reallocation per frame. */
  releaseAfterCapture?: boolean;
  /** How long to wait for the first decoded frame, in ms. Defaults to 5000. */
  frameTimeoutMs?: number;
  /** Called when the track ends on its own, e.g. permission revoked. */
  onEnded?: () => void;
}

export interface CaptureOptions {
  /** Downscale so the longest side is at most this many pixels. */
  maxDimension?: number;
  /** Retry while the frame is all black, as iOS returns after a camera
   * switch. `true` means 5 retries 100 ms apart. */
  skipBlankFrames?: boolean | (BlankCheckOptions & { retries?: number; delayMs?: number });
}

export interface CapturedBlob {
  blob: Blob;
  width: number;
  height: number;
}

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function scaleToFit(width: number, height: number, maxDimension?: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!maxDimension || longest <= maxDimension) return { width, height };
  const k = maxDimension / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export class WebCamera {
  private readonly options: WebCameraOptions;
  private selection: CameraSelection;
  private readonly frame: FrameCanvas;
  private video: HTMLVideoElement | null;
  private readonly ownsVideo: boolean;
  private mediaStream: MediaStream | null = null;
  private readonly openStreams = new Set<MediaStream>();
  private legacyObjectURL: string | null = null;
  private imageCapture: ImageCaptureLike | null = null;
  private generation = 0;
  private _state: CameraState = 'idle';
  private readonly handleEnded = () => {
    if (this._state !== 'live') return;
    this.stop();
    this.options.onEnded?.();
  };

  constructor(options: WebCameraOptions = {}) {
    this.options = options;
    const { facing, deviceId, width, height, frameRate, aspectRatio, strict } = options;
    this.selection = { facing, deviceId, width, height, frameRate, aspectRatio, strict };
    this.frame = new FrameCanvas(options.canvas ?? 'auto');
    this.video = options.video ?? null;
    this.ownsVideo = !options.video;
  }

  /** True when getUserMedia exists. It is missing on plain HTTP pages. */
  static isSupported(): boolean {
    return typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';
  }

  get state(): CameraState {
    return this._state;
  }

  get stream(): MediaStream | null {
    return this.mediaStream;
  }

  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  get track(): MediaStreamTrack | null {
    return this.mediaStream?.getVideoTracks()[0] ?? null;
  }

  /** Actual settings the browser picked, which may differ from the request. */
  get settings(): MediaTrackSettings | null {
    return this.track?.getSettings?.() ?? null;
  }

  capabilities(): MediaTrackCapabilities | null {
    const t = this.track;
    return t && typeof t.getCapabilities === 'function' ? t.getCapabilities() : null;
  }

  /** Opens the camera, or reopens it with a new selection. A newer start()
   * or stop() makes a pending start() reject with code `aborted`. */
  async start(selection?: CameraSelection): Promise<MediaStream> {
    if (this._state === 'destroyed') throw new Error('WebCamera has been destroyed');
    if (!WebCamera.isSupported()) throw new CameraError('not-supported');
    if (selection) this.selection = { ...this.selection, ...selection };

    // iOS cannot open a second camera while one is running.
    this.stopStreams();
    this.detachVideo();
    const gen = ++this.generation;
    this._state = 'starting';

    try {
      const constraints = buildConstraints(this.selection);
      let stream = await this.getUserMedia(constraints, gen);
      if (!stream.active) stream = await this.getUserMedia(constraints, gen);

      this.mediaStream = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', this.handleEnded);
      await this.attachVideo(stream);
      await this.waitForFrame(gen);
      this.assertCurrent(gen);
      this._state = 'live';
      return stream;
    } catch (err) {
      if (gen === this.generation) {
        this.stopStreams();
        this.detachVideo();
        this._state = 'stopped';
      }
      throw toCameraError(err);
    }
  }

  /** Switches camera. With no argument it flips between front and back. */
  switchCamera(selection?: CameraSelection): Promise<MediaStream> {
    if (selection) return this.start({ deviceId: undefined, ...selection });
    const current: FacingMode | undefined =
      (this.settings?.facingMode as FacingMode | undefined) ?? this.selection.facing;
    const facing: FacingMode = current === 'user' ? 'environment' : 'user';
    return this.start({ facing, deviceId: undefined });
  }

  async captureBlob(options: CaptureOptions & EncodeOptions = {}): Promise<CapturedBlob> {
    return this.withFrame(options, async () => {
      const blob = await this.frame.toBlob(options);
      return { blob, width: this.frame.width, height: this.frame.height };
    });
  }

  async captureImageData(options: CaptureOptions = {}): Promise<ImageData> {
    return this.withFrame(options, async () => this.frame.toImageData());
  }

  /** Returns an ImageBitmap. The caller owns it and should call
   * `bitmap.close()` (or `closeBitmap`) when done. */
  async captureBitmap(options: CaptureOptions = {}): Promise<ImageBitmap> {
    const plain = !options.maxDimension && !options.skipBlankFrames;
    if (plain && this.options.useImageCapture !== false) {
      const grabber = this.getImageCapture();
      if (grabber) {
        await this.assertReady();
        try {
          return await grabber.grabFrame();
        } catch {
          // Some browsers reject grabFrame on a busy track; the canvas path still works.
          this.imageCapture = null;
        }
      }
    }
    return this.withFrame(options, () => this.frame.toBitmap());
  }

  async setTorch(on: boolean): Promise<boolean> {
    const track = this.track;
    const caps = this.capabilities() as (MediaTrackCapabilities & { torch?: boolean }) | null;
    if (!track || !caps?.torch) return false;
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  }

  /** Stops every track, detaches the video and frees the canvas backing
   * store. The instance can be started again. */
  stop(): void {
    if (this._state === 'destroyed') return;
    this.generation++;
    this.stopStreams();
    this.detachVideo();
    this.frame.release();
    this.imageCapture = null;
    this._state = 'stopped';
  }

  /** stop() plus dropping the canvas and any video element we created. */
  destroy(): void {
    this.stop();
    this.frame.dispose();
    if (this.ownsVideo && this.video) this.video.remove();
    this.video = null;
    this._state = 'destroyed';
  }

  private async getUserMedia(constraints: MediaStreamConstraints, gen: number): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (gen !== this.generation) {
      // Stop only this stream; a newer start() may already own another one.
      for (const t of stream.getTracks()) t.stop();
      throw new CameraError('aborted');
    }
    this.openStreams.add(stream);
    return stream;
  }

  private assertCurrent(gen: number): void {
    if (gen !== this.generation) throw new CameraError('aborted');
  }

  private stopStreams(): void {
    this.mediaStream?.getVideoTracks()[0]?.removeEventListener('ended', this.handleEnded);
    for (const s of this.openStreams) for (const t of s.getTracks()) t.stop();
    this.openStreams.clear();
    this.mediaStream = null;
    this.imageCapture = null;
  }

  private ensureVideo(): HTMLVideoElement {
    if (this.video) return this.video;
    const v = document.createElement('video');
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    v.setAttribute('aria-hidden', 'true');
    document.body.appendChild(v);
    this.video = v;
    return v;
  }

  private async attachVideo(stream: MediaStream): Promise<void> {
    const v = this.ensureVideo();
    // iOS needs muted + playsinline to autoplay inline; the attributes are
    // set too because WebKit reads them, not only the properties.
    v.muted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('autoplay', '');
    if ('srcObject' in v) {
      v.srcObject = stream;
    } else {
      // Very old browsers: blob URL for the stream, revoked in detachVideo().
      const legacy = v as HTMLVideoElement;
      this.legacyObjectURL = URL.createObjectURL(stream as unknown as Blob);
      legacy.src = this.legacyObjectURL;
    }
    try {
      await v.play();
    } catch {
      // Autoplay may be refused without a gesture; waitForFrame() reports it.
    }
  }

  private detachVideo(): void {
    const v = this.video;
    if (v) {
      v.pause();
      if ('srcObject' in v) v.srcObject = null;
      v.removeAttribute('src');
      // load() with no source resets the element and drops decoder buffers.
      try {
        v.load();
      } catch {
        /* not all engines allow load() here */
      }
    }
    if (this.legacyObjectURL) {
      URL.revokeObjectURL(this.legacyObjectURL);
      this.legacyObjectURL = null;
    }
  }

  private async waitForFrame(gen?: number): Promise<void> {
    const v = this.video;
    const deadline = Date.now() + (this.options.frameTimeoutMs ?? 5000);
    while (!v || v.videoWidth === 0 || v.videoHeight === 0) {
      if (gen !== undefined) this.assertCurrent(gen);
      if (Date.now() >= deadline) throw new CameraError('no-frame');
      await sleep(50);
    }
  }

  private async assertReady(): Promise<void> {
    const t = this.track;
    if (this._state !== 'live' || !t || t.readyState !== 'live') throw new CameraError('not-live');
    await this.waitForFrame();
  }

  private getImageCapture(): ImageCaptureLike | null {
    if (this.imageCapture) return this.imageCapture;
    const Ctor = (globalThis as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    const t = this.track;
    if (typeof Ctor !== 'function' || !t) return null;
    try {
      this.imageCapture = new Ctor(t);
    } catch {
      this.imageCapture = null;
    }
    return this.imageCapture;
  }

  private async withFrame<T>(options: CaptureOptions, read: () => Promise<T>): Promise<T> {
    await this.assertReady();
    const v = this.video as HTMLVideoElement;
    const blank = options.skipBlankFrames;
    const cfg = typeof blank === 'object' ? blank : {};
    const retries = blank ? (cfg.retries ?? 5) : 0;
    const delayMs = cfg.delayMs ?? 100;

    try {
      for (let attempt = 0; ; attempt++) {
        const { width, height } = scaleToFit(v.videoWidth, v.videoHeight, options.maxDimension);
        this.frame.draw(v, width, height);
        if (!blank || attempt >= retries || !isBlankImageData(this.frame.toImageData(), cfg)) break;
        await sleep(delayMs);
        await this.assertReady();
      }
      return await read();
    } finally {
      if (this.options.releaseAfterCapture) this.frame.release();
    }
  }
}
