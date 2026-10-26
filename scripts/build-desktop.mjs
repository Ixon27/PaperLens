import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppIcon } from './build-app-icon.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('macOS ARM64 또는 Intel 머신에서 해당 아키텍처의 앱을 빌드하세요.');
}
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('웹 빌드가 없습니다. 먼저 npm run build를 실행하세요.');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = join(root, 'build-desktop');
const staged = join(output, 'app');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const common = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24',
  sourcemap: false, legalComments: 'eof', logLevel: 'info',
};
const esm = {
  ...common, format: 'esm', external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas', '@napi-rs/canvas/*'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
};
await Promise.all([
  build({ ...esm, entryPoints: ['src/desktop/main.ts'], outfile: join(output, 'main.mjs') }),
  build({ ...esm, entryPoints: ['src/desktop/backend.ts'], outfile: join(output, 'backend.mjs') }),
  build({ ...common, format: 'cjs', external: ['electron'], entryPoints: ['src/desktop/preload.ts'], outfile: join(output, 'preload.cjs') }),
]);
await buildAppIcon();

// electron-builder always includes production dependencies. A separate, minimal
// application manifest makes that inclusion explicit, never the developer's repo.
mkdirSync(join(staged, 'build-desktop'), { recursive: true });
for (const file of ['main.mjs', 'backend.mjs', 'preload.cjs']) cpSync(join(output, file), join(staged, 'build-desktop', file));
for (const directory of ['dist', 'prompts']) cpSync(join(root, directory), join(staged, directory), { recursive: true, dereference: true });
if (existsSync(join(root, 'LICENSE'))) cpSync(join(root, 'LICENSE'), join(staged, 'LICENSE'));

const nativePackage = `@napi-rs/canvas-darwin-${process.arch}`;
const dependencies = {};
for (const name of ['pdfjs-dist', '@napi-rs/canvas', nativePackage]) {
  const source = join(root, 'node_modules', name);
  if (!existsSync(join(source, 'package.json'))) throw new Error(`런타임 의존성이 없습니다: ${name}. 해당 아키텍처에서 npm ci를 실행하세요.`);
  const dependency = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  dependencies[name] = dependency.version;
  const destination = join(staged, 'node_modules', name);
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}
writeFileSync(join(staged, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, productName: 'Paper Reader',
  description: manifest.description ?? '내 컴퓨터에서 읽고 정리하는 연구 논문',
  author: manifest.author ?? 'Ixon27', license: manifest.license ?? 'MIT',
  type: 'module', main: 'build-desktop/main.mjs', dependencies,
}, null, 2) + '\n');
console.log(`데스크톱 빌드 준비 완료 (${process.arch}): ${staged}`);
