// Load a PNG or JPG texture as { data: RGBA Uint8, width, height } — pure JS.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export function loadTexture(path) {
  const buf = readFileSync(path);
  if (/\.png$/i.test(path)) {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { data: img.data, width: img.width, height: img.height };
}
