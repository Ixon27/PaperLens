import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = fileURLToPath(new URL('../', import.meta.url));

/** `build-assets/icon.png` (Windows: electron-builder makes the .ico) and, on macOS, `icon.icns`. */
export async function buildAppIcon() {
  const output = join(root, 'build-assets');
  mkdirSync(output, { recursive: true });
  const image = await loadImage(readFileSync(join(root, 'assets/app-icon.svg')));
  const render = (pixels) => {
    const canvas = createCanvas(pixels, pixels);
    canvas.getContext('2d').drawImage(image, 0, 0, pixels, pixels);
    return canvas.toBuffer('image/png');
  };
  writeFileSync(join(output, 'icon.png'), render(1024));
  if (process.platform !== 'darwin') return;

  const iconset = join(output, 'PaperLens.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      writeFileSync(join(iconset, `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`), render(points * scale));
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', join(output, 'icon.icns'), iconset], { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
}
