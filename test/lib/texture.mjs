// Deterministic procedural greyscale "displacement map" as an ImageData-like
// object ({ data, width, height }). Avoids any Canvas/DOM dependency so the
// displacement pipeline can run headless. The patterns are arbitrary but fixed,
// so the golden fingerprint is stable across runs.

export function proceduralTexture(width = 128, height = 128, kind = 'checker') {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let g;
      if (kind === 'checker') {
        g = (((x >> 4) + (y >> 4)) & 1) ? 205 : 55;
      } else if (kind === 'sine') {
        g = Math.round(127.5 + 100 * Math.sin(x / 7) * Math.cos(y / 9));
      } else { // 'ramp'
        g = Math.round((x / (width - 1)) * 255);
      }
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
