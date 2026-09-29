import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeBitmap, isBlankImageData, withObjectURL } from '../src/index.js';
import { FakeImageData, installFakes, type Env } from './fakes.js';

let env: Env;
beforeEach(() => {
  env = installFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('closeBitmap', () => {
  it('closes a bitmap and ignores null', () => {
    const close = vi.fn();
    closeBitmap({ close } as unknown as ImageBitmap);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => closeBitmap(null)).not.toThrow();
  });
});

describe('withObjectURL', () => {
  it('revokes the URL after success', async () => {
    const out = await withObjectURL(new Blob(['x']), (url) => url.toUpperCase());
    expect(out).toBe('BLOB:FAKE/1');
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:fake/1');
  });

  it('revokes the URL when the callback throws', async () => {
    await expect(
      withObjectURL(new Blob(['x']), async () => {
        throw new Error('decode failed');
      }),
    ).rejects.toThrow('decode failed');
    expect(env.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('isBlankImageData', () => {
  it('detects all-black frames', () => {
    expect(isBlankImageData(new FakeImageData(10, 10, 0) as unknown as ImageData)).toBe(true);
    expect(isBlankImageData(new FakeImageData(10, 10, 40) as unknown as ImageData)).toBe(false);
  });

  it('respects the threshold and treats empty data as blank', () => {
    expect(isBlankImageData(new FakeImageData(4, 4, 5) as unknown as ImageData, { threshold: 8 })).toBe(true);
    expect(isBlankImageData(new FakeImageData(0, 0, 0) as unknown as ImageData)).toBe(true);
  });
});
