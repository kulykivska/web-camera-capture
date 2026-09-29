import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraError, WebCamera, scaleToFit } from '../src/index.js';
import { FakeStream, FakeVideo, LegacyVideo, installFakes, type Env } from './fakes.js';

let env: Env;

beforeEach(() => {
  env = installFakes();
  FakeVideo.frameWidth = 1280;
  FakeVideo.frameHeight = 720;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('support and errors', () => {
  it('reports unsupported when getUserMedia is missing', async () => {
    vi.unstubAllGlobals();
    installFakes({ mediaDevices: false });
    expect(WebCamera.isSupported()).toBe(false);
    await expect(new WebCamera().start()).rejects.toMatchObject({ code: 'not-supported' });
  });

  it('maps a permission error and ends in the stopped state', async () => {
    env.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    const cam = new WebCamera();
    const err = await cam.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('not-allowed');
    expect(cam.state).toBe('stopped');
  });

  it('times out when the video never produces a frame', async () => {
    FakeVideo.frameWidth = 0;
    const cam = new WebCamera({ frameTimeoutMs: 60 });
    await expect(cam.start()).rejects.toMatchObject({ code: 'no-frame' });
    const stream = (await env.getUserMedia.mock.results[0]!.value) as FakeStream;
    expect(stream.tracks[0]!.stop).toHaveBeenCalled();
    expect(cam.state).toBe('stopped');
  });
});

describe('start', () => {
  it('requests the selected camera and attaches an inline, muted video', async () => {
    const cam = new WebCamera({ facing: 'environment', width: 1920, height: 1080 });
    await cam.start();

    expect(env.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const video = env.videos[0]!;
    expect(video.srcObject).toBe(cam.stream);
    expect(video.muted).toBe(true);
    expect(video.attributes.has('playsinline')).toBe(true);
    expect(video.attributes.has('autoplay')).toBe(true);
    expect(env.body.children.has(video)).toBe(true);
    expect(cam.state).toBe('live');
  });

  it('uses a provided video element instead of creating one', async () => {
    const own = new FakeVideo();
    const cam = new WebCamera({ video: own as unknown as HTMLVideoElement });
    await cam.start();
    expect(env.videos).toHaveLength(0);
    expect(own.srcObject).toBe(cam.stream);
  });

  it('asks again once when the first stream comes back inactive', async () => {
    env.getUserMedia.mockResolvedValueOnce(new FakeStream(false));
    const cam = new WebCamera();
    await cam.start();
    expect(env.getUserMedia).toHaveBeenCalledTimes(2);
    expect((cam.stream as unknown as FakeStream).active).toBe(true);
  });

  it('stop() during a pending start aborts it and stops the late stream', async () => {
    const d = deferred<FakeStream>();
    env.getUserMedia.mockReturnValueOnce(d.promise);
    const cam = new WebCamera();
    const pending = cam.start();
    cam.stop();
    const late = new FakeStream();
    d.resolve(late);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(late.tracks[0]!.stop).toHaveBeenCalled();
    expect(cam.state).toBe('stopped');
    expect(cam.stream).toBeNull();
  });

  it('a newer start wins and the older one does not stop its stream', async () => {
    const first = deferred<FakeStream>();
    env.getUserMedia.mockReturnValueOnce(first.promise);
    const cam = new WebCamera();
    const a = cam.start();
    const b = cam.start({ facing: 'user' });
    const winner = await b;
    first.resolve(new FakeStream());
    await expect(a).rejects.toMatchObject({ code: 'aborted' });
    expect(cam.stream).toBe(winner);
    expect((winner as unknown as FakeStream).tracks[0]!.stop).not.toHaveBeenCalled();
    expect(cam.state).toBe('live');
  });

  it('stops the running camera before opening another one', async () => {
    const cam = new WebCamera({ facing: 'environment' });
    await cam.start();
    const old = cam.stream as unknown as FakeStream;
    env.getUserMedia.mockImplementationOnce(async () => {
      expect(old.tracks[0]!.stop).toHaveBeenCalled();
      return new FakeStream(true, { facingMode: 'user' });
    });
    await cam.switchCamera();
    const video = env.getUserMedia.mock.calls[1]![0].video;
    expect(video.facingMode).toEqual({ ideal: 'user' });
  });

  it('switchCamera with a deviceId drops the facing preference', async () => {
    const cam = new WebCamera({ facing: 'environment' });
    await cam.start();
    await cam.switchCamera({ deviceId: 'abc' });
    expect(env.getUserMedia.mock.calls[1]![0].video).toEqual({ deviceId: { exact: 'abc' } });
  });
});

describe('capture', () => {
  it('reuses one canvas and allocates its backing store once for many frames', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    for (let i = 0; i < 50; i++) {
      const { blob, width, height } = await cam.captureBlob({ type: 'image/jpeg', quality: 0.8 });
      expect(blob.type).toBe('image/jpeg');
      expect([width, height]).toEqual([1280, 720]);
    }
    expect(env.canvases).toHaveLength(1);
    expect(env.canvases[0]!.resizes).toEqual([
      ['width', 1280],
      ['height', 720],
    ]);
  });

  it('downscales to maxDimension', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    const out = await cam.captureBlob({ maxDimension: 640 });
    expect([out.width, out.height]).toEqual([640, 360]);
  });

  it('releaseAfterCapture shrinks the canvas to 0x0 after every frame', async () => {
    const cam = new WebCamera({ canvas: 'element', releaseAfterCapture: true });
    await cam.start();
    await cam.captureBlob();
    await cam.captureImageData();
    const c = env.canvases[0]!;
    expect([c.width, c.height]).toEqual([0, 0]);
    expect(c.ctx!.clearRect).toHaveBeenCalledTimes(2);
  });

  it('skips blank frames until a real one arrives', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    await cam.captureImageData();
    const ctx = env.canvases[0]!.ctx!;
    ctx.pixelValue = 0;
    setTimeout(() => (ctx.pixelValue = 200), 30);
    const data = await cam.captureImageData({ skipBlankFrames: { delayMs: 20, retries: 10 } });
    expect(data.data[0]).toBe(200);
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(2);
  });

  it('gives up on blank frames after the retry budget', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    await cam.captureImageData();
    const ctx = env.canvases[0]!.ctx!;
    ctx.pixelValue = 0;
    ctx.drawImage.mockClear();
    await cam.captureImageData({ skipBlankFrames: { delayMs: 1, retries: 3 } });
    expect(ctx.drawImage).toHaveBeenCalledTimes(4);
  });

  it('captureBitmap draws on the shared canvas when ImageCapture is missing', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    const bmp = await cam.captureBitmap();
    expect(env.createImageBitmap).toHaveBeenCalledWith(env.canvases[0]);
    expect(bmp.width).toBe(1280);
  });

  it('captureBitmap prefers ImageCapture.grabFrame and falls back if it fails', async () => {
    const grabbed = { width: 1, height: 1, close: vi.fn() };
    const grabFrame = vi.fn().mockResolvedValueOnce(grabbed).mockRejectedValueOnce(new Error('busy'));
    const ctor = vi.fn(function (this: { grabFrame: typeof grabFrame }) {
      this.grabFrame = grabFrame;
    });
    vi.stubGlobal('ImageCapture', ctor);
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    expect(await cam.captureBitmap()).toBe(grabbed);
    const second = await cam.captureBitmap();
    expect(second).toBe(env.bitmaps[0]);
    expect(env.canvases).toHaveLength(1);
  });

  it('captureBitmap skips ImageCapture when useImageCapture is false', async () => {
    const ctor = vi.fn();
    vi.stubGlobal('ImageCapture', ctor);
    const cam = new WebCamera({ canvas: 'element', useImageCapture: false });
    await cam.start();
    await cam.captureBitmap();
    expect(ctor).not.toHaveBeenCalled();
  });

  it('refuses to capture before start and after stop', async () => {
    const cam = new WebCamera();
    await expect(cam.captureBlob()).rejects.toMatchObject({ code: 'not-live' });
    await cam.start();
    cam.stop();
    await expect(cam.captureBlob()).rejects.toMatchObject({ code: 'not-live' });
  });
});

describe('stop and cleanup', () => {
  it('stops tracks, detaches the video and releases the canvas', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    await cam.captureBlob();
    const stream = cam.stream as unknown as FakeStream;
    const video = env.videos[0]!;
    const canvas = env.canvases[0]!;

    cam.stop();

    expect(stream.tracks[0]!.stop).toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(video.load).toHaveBeenCalled();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(cam.state).toBe('stopped');
    expect(cam.stream).toBeNull();
  });

  it('can start again after stop and reuses the same canvas', async () => {
    const cam = new WebCamera({ canvas: 'element' });
    await cam.start();
    await cam.captureBlob();
    cam.stop();
    await cam.start();
    await cam.captureBlob();
    expect(env.canvases).toHaveLength(1);
    expect(env.videos).toHaveLength(1);
  });

  it('destroy removes a video it created', async () => {
    const cam = new WebCamera();
    await cam.start();
    const video = env.videos[0]!;
    cam.destroy();
    expect(env.body.children.has(video)).toBe(false);
    expect(cam.state).toBe('destroyed');
    await expect(cam.start()).rejects.toThrow(/destroyed/);
  });

  it('destroy leaves a caller-owned video in place', async () => {
    const own = new FakeVideo();
    env.body.appendChild(own);
    const cam = new WebCamera({ video: own as unknown as HTMLVideoElement });
    await cam.start();
    cam.destroy();
    expect(env.body.children.has(own)).toBe(true);
    expect(own.srcObject).toBeNull();
  });

  it('revokes the blob URL used for engines without srcObject', async () => {
    const legacy = new LegacyVideo();
    const cam = new WebCamera({ video: legacy as unknown as HTMLVideoElement });
    await cam.start();
    expect(env.createObjectURL).toHaveBeenCalledTimes(1);
    const url = env.createObjectURL.mock.results[0]!.value as string;
    expect(legacy.src).toBe(url);
    cam.stop();
    expect(env.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it('cleans up and notifies when the track ends on its own', async () => {
    const onEnded = vi.fn();
    const cam = new WebCamera({ onEnded });
    await cam.start();
    (cam.stream as unknown as FakeStream).tracks[0]!.fire('ended');
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(cam.state).toBe('stopped');
    expect(env.videos[0]!.srcObject).toBeNull();
  });
});

describe('track features', () => {
  it('setTorch returns false when the track has no torch', async () => {
    const cam = new WebCamera();
    await cam.start();
    expect(await cam.setTorch(true)).toBe(false);
  });

  it('setTorch applies the advanced constraint when supported', async () => {
    const cam = new WebCamera();
    await cam.start();
    const track = (cam.stream as unknown as FakeStream).tracks[0]!;
    track.capabilities = { torch: true };
    expect(await cam.setTorch(true)).toBe(true);
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });

  it('scaleToFit keeps the aspect ratio', () => {
    expect(scaleToFit(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 });
    expect(scaleToFit(720, 1280, 640)).toEqual({ width: 360, height: 640 });
    expect(scaleToFit(100, 50)).toEqual({ width: 100, height: 50 });
  });
});
