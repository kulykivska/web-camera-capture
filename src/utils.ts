/** Closes an ImageBitmap so its pixels are freed now, not at GC.
 * Accepts null and anything without `close`, so callers can use it blindly. */
export function closeBitmap(bitmap: ImageBitmap | null | undefined): void {
  if (bitmap && typeof bitmap.close === 'function') bitmap.close();
}

/** Runs `fn` with a blob: URL and always revokes it afterwards.
 * An unrevoked blob URL pins the Blob in memory until the page unloads. */
export async function withObjectURL<T>(blob: Blob, fn: (url: string) => T | Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob);
  try {
    return await fn(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface BlankCheckOptions {
  /** Pixels to sample before deciding. Defaults to 100. */
  samples?: number;
  /** Channel value at or below which a pixel counts as black. Defaults to 0. */
  threshold?: number;
}

/** True when sampled pixels are all black, which iOS returns for a
 * few frames right after the stream starts or the camera switches. */
export function isBlankImageData(data: ImageData, options: BlankCheckOptions = {}): boolean {
  const samples = Math.max(1, options.samples ?? 100);
  const threshold = options.threshold ?? 0;
  const px = data.data;
  const total = Math.floor(px.length / 4);
  if (total === 0) return true;
  const step = Math.max(1, Math.floor(total / samples));
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    if ((px[i] ?? 0) > threshold || (px[i + 1] ?? 0) > threshold || (px[i + 2] ?? 0) > threshold) {
      return false;
    }
  }
  return true;
}
