import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameCanvas, dataURLToBlob, releaseCanvas } from '../src/index.js';
import { FakeOffscreenCanvas, FakeVideo, installFakes, type Env } from './fakes.js';

let env: Env;
const source = new FakeVideo() as unknown as CanvasImageSource;

beforeEach(() => {
  env = installFakes();
  FakeOffscreenCanvas.instances = [];
  FakeOffscreenCanvas.contextAvailable = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('releaseCanvas', () => {
  it('sets both dimensions to zero and tolerates null', () => {
    const c = { width: 1920, height: 1080 } as HTMLCanvasElement;
    releaseCanvas(c);
    expect([c.width, c.height]).toEqual([0, 0]);
    expect(() => releaseCanvas(null)).not.toThrow();
  });
});

describe('FrameCanvas', () => {
  it('is lazy: no canvas exists until the first draw', () => {
    const f = new FrameCanvas('element');
    expect(f.activeKind).toBeNull();
    expect(env.canvases).toHaveLength(0);
  });

  it('only reallocates when the size changes', () => {
    const f = new FrameCanvas('element');
    f.draw(source, 100, 50);
    f.draw(source, 100, 50);
    f.draw(source, 200, 50);
    expect(env.canvases[0]!.resizes).toEqual([
      ['width', 100],
      ['height', 50],
      ['width', 200],
      ['height', 50],
    ]);
  });

  it('resets the transform before every draw', () => {
    const f = new FrameCanvas('element');
    f.draw(source, 10, 10);
    expect(env.canvases[0]!.ctx!.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });

  it('auto prefers OffscreenCanvas and encodes with convertToBlob', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const f = new FrameCanvas();
    f.draw(source, 10, 10);
    expect(f.activeKind).toBe('offscreen');
    expect(env.canvases).toHaveLength(0);
    const blob = await f.toBlob({ type: 'image/webp' });
    expect(blob.type).toBe('image/webp');
  });

  it('falls back to an element and releases the offscreen canvas without a 2D context', () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    FakeOffscreenCanvas.contextAvailable = false;
    const f = new FrameCanvas('auto');
    f.draw(source, 10, 10);
    expect(f.activeKind).toBe('element');
    const off = FakeOffscreenCanvas.instances[0]!;
    expect([off.width, off.height]).toEqual([0, 0]);
  });

  it('throws when no 2D context exists at all', () => {
    const f = new FrameCanvas('offscreen');
    expect(() => f.draw(source, 1, 1)).toThrow(/2D/);
  });

  it('falls back to toDataURL when toBlob yields null', async () => {
    const f = new FrameCanvas('element');
    f.draw(source, 10, 10);
    env.canvases[0]!.blobResult = 'null';
    const blob = await f.toBlob({ type: 'image/jpeg' });
    expect(blob.type).toBe('image/jpeg');
    expect(await blob.text()).toBe('frame');
  });

  it('refuses to encode a released canvas', async () => {
    const f = new FrameCanvas('element');
    f.draw(source, 10, 10);
    f.release();
    await expect(f.toBlob()).rejects.toThrow(/Nothing drawn/);
    await expect(f.toBitmap()).rejects.toThrow(/Nothing drawn/);
  });

  it('release clears and zeroes but keeps the canvas for reuse', () => {
    const f = new FrameCanvas('element');
    f.draw(source, 64, 64);
    f.release();
    const c = env.canvases[0]!;
    expect(c.ctx!.clearRect).toHaveBeenCalledWith(0, 0, 64, 64);
    expect([c.width, c.height]).toEqual([0, 0]);
    f.draw(source, 32, 32);
    expect(env.canvases).toHaveLength(1);
  });

  it('dispose releases memory and blocks further use', () => {
    const f = new FrameCanvas('element');
    f.draw(source, 64, 64);
    f.dispose();
    expect(env.canvases[0]!.width).toBe(0);
    expect(() => f.draw(source, 1, 1)).toThrow(/disposed/);
  });
});

describe('dataURLToBlob', () => {
  it('decodes base64 data URLs', async () => {
    const blob = dataURLToBlob(`data:image/png;base64,${btoa('abc')}`);
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('abc');
  });

  it('decodes percent-encoded data URLs', async () => {
    const blob = dataURLToBlob('data:text/plain,hello%20world');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello world');
  });
});
