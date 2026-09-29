export type CameraErrorCode =
  | 'not-supported'
  | 'not-allowed'
  | 'not-found'
  | 'in-use'
  | 'overconstrained'
  | 'invalid-constraints'
  | 'not-live'
  | 'no-frame'
  | 'aborted'
  | 'unknown';

const MESSAGES: Record<CameraErrorCode, string> = {
  'not-supported': 'Camera access is not supported in this browser or context (HTTPS is required).',
  'not-allowed': 'Camera permission was denied.',
  'not-found': 'No camera matching the request was found.',
  'in-use': 'The camera is already in use by another application.',
  overconstrained: 'No camera can satisfy the requested constraints; try another resolution.',
  'invalid-constraints': 'The camera constraints are empty or invalid.',
  'not-live': 'The camera is not running.',
  'no-frame': 'The video did not produce a frame in time.',
  aborted: 'The camera start was cancelled by a newer start() or stop().',
  unknown: 'Unknown camera error.',
};

export class CameraError extends Error {
  readonly code: CameraErrorCode;
  readonly cause: unknown;

  constructor(code: CameraErrorCode, cause?: unknown, message = MESSAGES[code]) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

// Maps getUserMedia DOMException names, including legacy Chrome and Firefox ones.
export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('not-allowed', err);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('not-found', err);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('in-use', err);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError('overconstrained', err);
    case 'TypeError':
      return new CameraError('invalid-constraints', err);
    default:
      return new CameraError('unknown', err);
  }
}
