import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
const sourcePath = path.join(rootDirectory, 'frontend', 'public', 'icon-512.png');
const outputDirectory = path.join(rootDirectory, 'build');
const outputPath = path.join(outputDirectory, 'icon.ico');
const nativeBuildDirectory = process.env.JACKY_ELECTRON_NATIVE_BUILD_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(rootDirectory, 'build'), 'JackyImageBuild');
const nativeOutputPath = path.join(nativeBuildDirectory, 'icon.ico');

await fs.mkdir(outputDirectory, { recursive: true });
await fs.mkdir(nativeBuildDirectory, { recursive: true });
const iconBuffer = await pngToIco(sourcePath);
await fs.writeFile(outputPath, iconBuffer);
await fs.writeFile(nativeOutputPath, iconBuffer);
console.log(`Electron icon generated: ${outputPath}`);
console.log(`Native build icon generated: ${nativeOutputPath}`);
