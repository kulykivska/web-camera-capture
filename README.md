# web-camera-capture

Capture frames from the device camera in the browser without running Safari and iOS WebKit out of canvas memory.

- Zero dependencies, framework-agnostic, ESM with TypeScript types.
- Camera selection by facing (front or back), device id and resolution, with readable errors.
- One reused canvas for every frame, released explicitly when you stop.
- Uses `OffscreenCanvas` and `ImageCapture.grabFrame()` where the browser has them, and falls back to a plain canvas.
- Clean start and stop: every track stopped, the video detached, blob URLs revoked, and no race when `start()` and `stop()` overlap.

```sh
npm install github:kulykivska/web-camera-capture
```

## Usage

```ts
import { WebCamera, closeBitmap, CameraError } from 'web-camera-capture';

const camera = new WebCamera({
  video: document.querySelector('video')!, // optional preview element
  facing: 'environment',
  width: 1920,
  height: 1080,
});

try {
  await camera.start();
} catch (err) {
  if (err instanceof CameraError && err.code === 'not-allowed') showPermissionHelp();
  throw err;
}

// A JPEG for upload. The canvas behind it is reused for the next call.
const { blob, width, height } = await camera.captureBlob({ quality: 0.85, maxDimension: 1920 });

// Many frames for processing. You own each bitmap, so close it.
for (let i = 0; i < 500; i++) {
  const bitmap = await camera.captureBitmap();
  await analyse(bitmap);
  closeBitmap(bitmap);
}

await camera.switchCamera();   // front <-> back
camera.stop();                 // stop tracks, detach video, free the canvas
camera.destroy();              // stop() and drop everything; cannot restart
```

`demo/index.html` has a working page with a burst test that compares the library against a new canvas per frame.

## API

### `new WebCamera(options?)`

| Option | Default | Meaning |
| --- | --- | --- |
| `facing` | none | `'user'` (front) or `'environment'` (back). Sent as `ideal` unless `strict`. |
| `deviceId` | none | Exact device from `listCameras()`. Wins over `facing`. |
| `width`, `height`, `frameRate`, `aspectRatio` | none | Preferred values, sent as `ideal`. |
| `strict` | `false` | Send `facing`, `width` and `height` as `exact` and fail with `overconstrained` if unmet. |
| `video` | created | Preview element. If omitted, a hidden muted one is appended to `document.body`, because iOS only decodes video in an attached element. |
| `canvas` | `'auto'` | `'auto'` tries `OffscreenCanvas` then a detached `<canvas>`; `'element'` or `'offscreen'` force one. |
| `useImageCapture` | `true` | Use `ImageCapture.grabFrame()` for plain `captureBitmap()` calls where available. |
| `releaseAfterCapture` | `false` | Shrink the canvas to 0x0 after every capture. Good for rare captures, wasteful for bursts. |
| `frameTimeoutMs` | `5000` | How long to wait for the first decoded frame. |
| `onEnded` | none | Called when the track ends by itself (device unplugged, permission revoked). The camera is already stopped. |

### Methods and properties

- `start(selection?) => Promise<MediaStream>`: opens the camera, or reopens it with a merged selection. The old stream is stopped first, because iOS will not open a second camera while one runs. If a newer `start()` or a `stop()` happens while it is pending, it rejects with code `aborted` and its stream is stopped.
- `switchCamera(selection?)`: with no argument, flips between front and back.
- `captureBlob(options?) => Promise<{ blob, width, height }>`: encodes the current frame. `type` (default `image/jpeg`), `quality` (default `0.92`), `maxDimension`, `skipBlankFrames`.
- `captureBitmap(options?) => Promise<ImageBitmap>`: the caller must `close()` it.
- `captureImageData(options?) => Promise<ImageData>`: raw RGBA pixels.
- `capabilities()`, `settings`, `track`, `stream`, `videoElement`, `state` (`idle`, `starting`, `live`, `stopped`, `destroyed`).
- `setTorch(on) => Promise<boolean>`: `false` when the track has no torch.
- `stop()`: stops every track this instance opened, pauses and detaches the video, resets it with `load()`, revokes any blob URL, and sets the canvas to 0x0. You can `start()` again.
- `destroy()`: `stop()`, then drops the canvas and removes the video element if the library created it.
- `WebCamera.isSupported()`: `false` when `getUserMedia` is missing, for example on plain HTTP.

`skipBlankFrames: true` retries up to 5 times, 100 ms apart, while the sampled pixels are all black. iOS often returns black frames right after a stream starts or the camera switches. Pass `{ retries, delayMs, samples, threshold }` to tune it.

### Helpers

- `listCameras() => Promise<CameraInfo[]>`: video inputs with a `facing` guess from the label. Labels are empty until permission has been granted once.
- `buildConstraints(selection)`: the `MediaStreamConstraints` that `start()` would send.
- `resolutionOptions(capabilities)`: the maximum plus common sizes (4K, 1440p, 1080p, 720p, 480p) inside the track's range.
- `FrameCanvas`: the reusable canvas on its own, for code that draws other sources.
- `releaseCanvas(canvas)`: sets width and height to 0.
- `closeBitmap(bitmap)`: null-safe `ImageBitmap.close()`.
- `withObjectURL(blob, fn)`: runs `fn(url)` and always revokes the URL.
- `isBlankImageData(imageData, options?)`: the black-frame check.
- `dataURLToBlob(dataURL)`: used when `canvas.toBlob` hands back `null`.
- `CameraError` with `code`: `not-supported`, `not-allowed`, `not-found`, `in-use`, `overconstrained`, `invalid-constraints`, `not-live`, `no-frame`, `aborted`, `unknown`. `toCameraError(err)` maps raw `getUserMedia` errors, including legacy names.

## The Safari canvas memory problem

The usual way to grab a camera frame is to create a canvas, draw the `<video>` onto it and read it back. Do that for every frame and on iOS, after some dozens of frames, it stops working. The console shows:

```
Total canvas memory use exceeds the maximum limit (384 MB).
```

`getContext('2d')` then returns `null`, and `drawImage` either throws or you get blank images. Reloading fixes it until the next burst.

### Why it happens

Each canvas has a backing store: `width x height x 4` bytes of pixels. A 1920x1080 canvas holds about 8 MB. WebKit on iOS used to keep a running total of live canvas pixel memory and refuse to create new canvas contexts once that total passed a fixed cap.

The catch is when that memory is given back. It happens when the canvas element is garbage collected, not when your code drops its last reference. Garbage collection is not triggered by canvas memory pressure, so a loop that makes a new canvas per frame runs into the cap while the old, unreachable canvases are still waiting for collection. The WebKit report says it directly: canvas elements without strong references are not collected immediately. At 8 MB per 1080p frame, a 384 MB cap is gone after roughly 45 frames.

This is [WebKit bug 195325](https://bugs.webkit.org/show_bug.cgi?id=195325), "Canvas context allocation fails because 'Total canvas memory use exceeds the maximum limit'", reported in March 2019 against iOS 12. The report notes that lowering the iOS limit to 384 MB made the failure easier to hit.

### Status

The fix, [commit 265628@main](https://github.com/WebKit/WebKit/commit/6bd11f3792f05b4e58e5647bf173212879fa62cc) from June 2023, removed the separate canvas limit, so pages now fall under the same memory policy as everything else. Two things keep the workaround useful:

1. Devices on older iOS versions still have the cap.
2. Without the cap the memory is still only reclaimed at GC. A page that allocates a large canvas per frame can still grow until iOS kills the tab, which is a crash instead of a blank image.

### What this library does about it

| Technique | Where |
| --- | --- |
| One canvas per `WebCamera`, created lazily and reused for every frame. Nothing is left for the GC to collect. | `FrameCanvas` |
| The canvas is only resized when the frame size changes. Assigning `width` reallocates the backing store even if the value is the same. | `FrameCanvas.draw` |
| `canvas.width = 0; canvas.height = 0` on `stop()`, `destroy()` and optionally after every capture. Setting the size to zero replaces the backing store at once, so memory comes back without waiting for GC. | `releaseCanvas`, `FrameCanvas.release` |
| An `OffscreenCanvas` that turns out to have no 2D context is released before falling back. | `FrameCanvas` |
| `ImageBitmap`s are handed to you to `close()`, and `closeBitmap` is null-safe. An unclosed bitmap keeps its pixels until GC. | `captureBitmap`, `closeBitmap` |
| Blob URLs are always revoked. A blob URL keeps its Blob alive until revoked or the page unloads. | `withObjectURL`, legacy `video.src` path |
| On stop: every track stopped, the video paused, `srcObject = null`, `src` removed and `load()` called so the element drops its decoder buffers. | `WebCamera.stop` |
| Streams from overlapping `start()` calls are tracked and stopped. Otherwise a stream that resolves after `stop()` keeps the camera light on. | `WebCamera.start` |

If you manage canvases yourself, the rule is: reuse one, and when you are done with it set its width and height to 0 before dropping the reference.

## Browser support

The library needs `navigator.mediaDevices.getUserMedia`, which requires a secure context (HTTPS or localhost), and a 2D canvas. It runs in current Chrome, Edge, Firefox and Safari on desktop, and in Safari and WebKit-based browsers on iOS.

| Feature | Used when available | Fallback |
| --- | --- | --- |
| `OffscreenCanvas` with a 2D context | Chromium, Firefox, Safari 16.4+ | Detached `<canvas>` |
| `ImageCapture.grabFrame()` | Chromium | Canvas plus `createImageBitmap` |
| `canvas.convertToBlob` / `canvas.toBlob` | Everywhere | `toDataURL` decoded to a Blob |
| `HTMLMediaElement.srcObject` | Everywhere current | Blob URL, revoked on stop |

iOS notes: the video must be muted, `playsinline` and attached to the document. The library sets all three when it creates the element. If you pass your own, keep it in the DOM. Only one camera can be open at a time, so `start()` stops the previous stream before asking for a new one.

## Development

```sh
npm install
npm test          # vitest with mocked media and canvas APIs
npm run typecheck
npm run build     # emits dist/ with .d.ts
```

## License

MIT
