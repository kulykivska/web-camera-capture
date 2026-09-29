import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConstraints, listCameras, resolutionOptions, toCameraError, CameraError } from '../src/index.js';
import { installFakes, type Env } from './fakes.js';

let env: Env;
beforeEach(() => {
  env = installFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildConstraints', () => {
  it('asks for any camera with audio off by default', () => {
    expect(buildConstraints()).toEqual({ audio: false, video: true });
  });

  it('uses ideal values unless strict', () => {
    expect(buildConstraints({ facing: 'user', width: 640, frameRate: 30 }).video).toEqual({
      facingMode: { ideal: 'user' },
      width: { ideal: 640 },
      frameRate: { ideal: 30 },
    });
    expect(buildConstraints({ facing: 'environment', height: 720, strict: true }).video).toEqual({
      facingMode: { exact: 'environment' },
      height: { exact: 720 },
    });
  });

  it('lets deviceId win over facing', () => {
    expect(buildConstraints({ deviceId: 'd1', facing: 'user', aspectRatio: 1.5 }).video).toEqual({
      deviceId: { exact: 'd1' },
      aspectRatio: { ideal: 1.5 },
    });
  });
});

describe('listCameras', () => {
  it('returns video inputs with a facing guess', async () => {
    env.enumerateDevices.mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'm', label: 'Mic', groupId: 'g' },
      { kind: 'videoinput', deviceId: 'a', label: 'Back Camera', groupId: 'g1' },
      { kind: 'videoinput', deviceId: 'b', label: 'FaceTime HD Camera', groupId: 'g2' },
      { kind: 'videoinput', deviceId: 'c', label: '', groupId: 'g3' },
    ]);
    const cams = await listCameras();
    expect(cams.map((c) => [c.deviceId, c.facing])).toEqual([
      ['a', 'environment'],
      ['b', 'user'],
      ['c', undefined],
    ]);
  });

  it('throws not-supported without mediaDevices', async () => {
    vi.unstubAllGlobals();
    installFakes({ mediaDevices: false });
    await expect(listCameras()).rejects.toMatchObject({ code: 'not-supported' });
  });
});

describe('resolutionOptions', () => {
  it('lists the maximum and common sizes inside the range', () => {
    const caps = { width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 } } as MediaTrackCapabilities;
    expect(resolutionOptions(caps)).toEqual([
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 640, height: 480 },
    ]);
  });

  it('handles a fixed number and missing data', () => {
    expect(resolutionOptions({ width: 800, height: 600 } as unknown as MediaTrackCapabilities)).toEqual([
      { width: 800, height: 600 },
    ]);
    expect(resolutionOptions({})).toEqual([]);
  });
});

describe('toCameraError', () => {
  it.each([
    ['NotAllowedError', 'not-allowed'],
    ['PermissionDeniedError', 'not-allowed'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['OverconstrainedError', 'overconstrained'],
    ['TypeError', 'invalid-constraints'],
    ['Weird', 'unknown'],
  ])('%s -> %s', (name, code) => {
    const err = toCameraError(Object.assign(new Error('x'), { name }));
    expect(err).toBeInstanceOf(CameraError);
    expect(err.code).toBe(code);
  });

  it('passes a CameraError through unchanged', () => {
    const e = new CameraError('aborted');
    expect(toCameraError(e)).toBe(e);
  });
});
