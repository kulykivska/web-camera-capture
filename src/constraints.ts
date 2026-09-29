import { CameraError, toCameraError } from './errors.js';

export type FacingMode = 'user' | 'environment';

export interface CameraSelection {
  /** Preferred camera direction. Ignored when `deviceId` is set. */
  facing?: FacingMode;
  /** Exact device to open, from `listCameras()`. */
  deviceId?: string;
  /** Preferred width in pixels (sent as `ideal`). */
  width?: number;
  /** Preferred height in pixels (sent as `ideal`). */
  height?: number;
  /** Preferred frame rate (sent as `ideal`). */
  frameRate?: number;
  /** Preferred aspect ratio, for example `16 / 9`. */
  aspectRatio?: number;
  /** Fail instead of falling back when facing, width or height cannot be met. */
  strict?: boolean;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
  groupId: string;
  /** Best guess from the label; `undefined` when the label says nothing. */
  facing: FacingMode | undefined;
}

export interface ResolutionOption {
  width: number;
  height: number;
}

type Ranged = number | { min?: number; max?: number; ideal?: number; exact?: number };

function pref(value: number | undefined, strict: boolean): Ranged | undefined {
  if (value === undefined) return undefined;
  return strict ? { exact: value } : { ideal: value };
}

/** Turns a friendly selection into `MediaStreamConstraints` with audio off. */
export function buildConstraints(selection: CameraSelection = {}): MediaStreamConstraints {
  const strict = selection.strict ?? false;
  const video: MediaTrackConstraints = {};

  // deviceId and facingMode together can conflict on iOS, so deviceId wins.
  if (selection.deviceId) {
    video.deviceId = { exact: selection.deviceId };
  } else if (selection.facing) {
    video.facingMode = strict ? { exact: selection.facing } : { ideal: selection.facing };
  }

  const width = pref(selection.width, strict);
  const height = pref(selection.height, strict);
  const frameRate = pref(selection.frameRate, false);
  const aspectRatio = pref(selection.aspectRatio, false);
  if (width !== undefined) video.width = width;
  if (height !== undefined) video.height = height;
  if (frameRate !== undefined) video.frameRate = frameRate;
  if (aspectRatio !== undefined) video.aspectRatio = aspectRatio;

  return { audio: false, video: Object.keys(video).length ? video : true };
}

function guessFacing(label: string): FacingMode | undefined {
  const l = label.toLowerCase();
  if (/\b(back|rear|environment|world)\b/.test(l)) return 'environment';
  if (/\b(front|user|facetime|selfie)\b/.test(l)) return 'user';
  return undefined;
}

/** Lists video input devices. Labels stay empty until camera permission
 * has been granted once, so call it after `start()` to get names. */
export async function listCameras(): Promise<CameraInfo[]> {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.enumerateDevices) throw new CameraError('not-supported');
  try {
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        groupId: d.groupId,
        facing: guessFacing(d.label),
      }));
  } catch (err) {
    throw toCameraError(err);
  }
}

function range(value: unknown): { min: number; max: number } | undefined {
  if (typeof value === 'number') return { min: value, max: value };
  const r = value as { min?: number; max?: number } | undefined;
  if (r && typeof r.max === 'number') return { min: r.min ?? r.max, max: r.max };
  return undefined;
}

const COMMON: ResolutionOption[] = [
  { width: 3840, height: 2160 },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 640, height: 480 },
];

/** Suggests resolutions a track can deliver, largest first: the maximum,
 * then common sizes inside the reported range. */
export function resolutionOptions(capabilities: MediaTrackCapabilities): ResolutionOption[] {
  const w = range(capabilities.width);
  const h = range(capabilities.height);
  if (!w || !h) return [];
  const out: ResolutionOption[] = [{ width: w.max, height: h.max }];
  for (const c of COMMON) {
    const fits = c.width <= w.max && c.width >= w.min && c.height <= h.max && c.height >= h.min;
    const dup = out.some((o) => o.width === c.width && o.height === c.height);
    if (fits && !dup) out.push(c);
  }
  return out;
}
