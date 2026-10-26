import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildAppIcon() {
  if (process.platform !== 'darwin') throw new Error('macOS 앱 아이콘은 macOS에서 빌드하세요.');
  const output = join(root, 'build-assets');
  const iconset = join(output, 'PaperReader.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const image = await loadImage(readFileSync(join(root, 'assets/app-icon.svg')));
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      const canvas = createCanvas(pixels, pixels);
      canvas.getContext('2d').drawImage(image, 0, 0, pixels, pixels);
      writeFileSync(join(iconset, `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`), canvas.toBuffer('image/png'));
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', join(output, 'icon.icns'), iconset], { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
}
