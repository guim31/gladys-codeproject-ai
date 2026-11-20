// -----------------------------------------------------------------------------
// Worker thread of src/image.js: decode one JPEG at a reduced size, shrink it,
// draw the boxes of the detections, encode it again until it fits a Gladys
// camera image, post the bytes back.
// The parent ends the worker right after, so nothing outlives the conversion.
//
// Decoding: src/jpeg-scaled.js, which reads a 4K frame straight at 1/4 in a
// few megabytes. A file it does not handle (progressive…) goes to jpeg-js,
// only up to 1080p: jpeg-js holds the full frame, ~50 bytes per pixel.
// -----------------------------------------------------------------------------

import { parentPort, workerData } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import { MAX_DECODED_PIXELS, fitsCamera, jpegSize } from './image.js';
import { UnsupportedJpeg, chooseScale, decodeScaled } from './jpeg-scaled.js';

// Widths tried in turn, with their JPEG quality: the first that fits wins.
// 960 pixels is more than a dashboard card or a chat message shows.
export const ATTEMPTS = [
  { width: 960, quality: 75 },
  { width: 640, quality: 70 },
  { width: 480, quality: 60 },
  { width: 320, quality: 50 },
];

/**
 * Shrink an RGBA image to `width` by averaging the source pixels each target
 * pixel covers (a box filter).
 */
export function shrink({ width: sourceWidth, height: sourceHeight, data }, width) {
  if (width >= sourceWidth) {
    return { width: sourceWidth, height: sourceHeight, data };
  }
  const scale = sourceWidth / width;
  const height = Math.max(1, Math.round(sourceHeight / scale));
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(sourceHeight, Math.max(y0 + 1, Math.floor((y + 1) * scale)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(sourceWidth, Math.max(x0 + 1, Math.floor((x + 1) * scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let at = (sy * sourceWidth + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1) {
          r += data[at];
          g += data[at + 1];
          b += data[at + 2];
          at += 4;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
      out[to + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Decode at about the largest width tried, the cheapest way available. */
export function decode(bytes) {
  const size = jpegSize(bytes);
  if (!size) {
    throw new Error('The snapshot has no JPEG frame header');
  }
  try {
    return decodeScaled(bytes, chooseScale(size.width, ATTEMPTS[0].width));
  } catch (err) {
    if (!(err instanceof UnsupportedJpeg)) {
      throw err;
    }
  }
  if (size.width * size.height > MAX_DECODED_PIXELS) {
    throw new Error(`The snapshot is too large to resize (${size.width}×${size.height} pixels)`);
  }
  return jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 2.1,
    maxMemoryUsageInMB: 160,
  });
}

// Outline thickness, in pixels of the picture sent to Gladys.
const LINE = 3;

/**
 * Draw rectangle outlines on an RGBA image, in place.
 * @param {{ width: number, height: number, data: Buffer }} image
 * @param {Array<{ x0: number, y0: number, x1: number, y1: number, color: number[] }>} boxes
 *   corners relative to the picture (0-1)
 */
export function drawBoxes(image, boxes) {
  const { width, height, data } = image;
  const paint = (x, y, color) => {
    const at = (y * width + x) * 4;
    data[at] = color[0];
    data[at + 1] = color[1];
    data[at + 2] = color[2];
  };
  const clampX = (value) => Math.min(width - 1, Math.max(0, Math.round(value * width)));
  const clampY = (value) => Math.min(height - 1, Math.max(0, Math.round(value * height)));
  for (const box of boxes) {
    const x0 = clampX(box.x0);
    const x1 = clampX(box.x1);
    const y0 = clampY(box.y0);
    const y1 = clampY(box.y1);
    for (let k = 0; k < LINE; k += 1) {
      for (let x = x0; x <= x1; x += 1) {
        paint(x, Math.min(y0 + k, y1), box.color);
        paint(x, Math.max(y1 - k, y0), box.color);
      }
      for (let y = y0; y <= y1; y += 1) {
        paint(Math.min(x0 + k, x1), y, box.color);
        paint(Math.max(x1 - k, x0), y, box.color);
      }
    }
  }
  return image;
}

/** Decode, then encode smaller and smaller (with the boxes) until it fits. */
export function convert(bytes, boxes = []) {
  const decoded = decode(bytes);
  for (const { width, quality } of ATTEMPTS) {
    let image = shrink(decoded, width);
    if (boxes.length > 0) {
      // Never draw on the decoded frame itself: the next width starts clean.
      image = image === decoded ? { ...image, data: Buffer.from(image.data) } : image;
      drawBoxes(image, boxes);
    }
    const encoded = Buffer.from(jpeg.encode(image, quality).data);
    if (fitsCamera(encoded)) {
      return encoded;
    }
  }
  throw new Error('The snapshot cannot be made small enough');
}

if (parentPort) {
  try {
    const out = convert(Buffer.from(workerData.bytes), workerData.boxes ?? []);
    parentPort.postMessage({ bytes: out });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
}
