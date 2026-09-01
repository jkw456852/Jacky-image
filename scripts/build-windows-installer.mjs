import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'));
const nativeBuildDirectory = process.env.JACKY_ELECTRON_NATIVE_BUILD_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(rootDirectory, 'build'), 'JackyImageBuild');
const appDirectory = path.join(nativeBuildDirectory, 'out', 'Jacky Image-win32-x64');
const candidates = [
  process.env.INNO_SETUP_COMPILER,
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean);
const iscc = candidates.find(candidate => fs.existsSync(candidate));
if (!fs.existsSync(appDirectory)) throw new Error(`Packaged application not found: ${appDirectory}`);
if (!iscc) throw new Error('ISCC.exe not found. Install Inno Setup 6 or set INNO_SETUP_COMPILER.');
const outputDirectory = path.join(nativeBuildDirectory, 'out', 'inno');
fs.mkdirSync(outputDirectory, { recursive: true });
const result = spawnSync(iscc, [
  `/DAppVersion=${packageJson.version}`,
  `/DAppSource=${appDirectory}`,
  `/DSetupIcon=${path.join(nativeBuildDirectory, 'icon.ico')}`,
  `/O${outputDirectory}`,
  path.join(rootDirectory, 'installer', 'jacky-image.iss'),
], { cwd: rootDirectory, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Inno Setup failed with code ${result.status}`);
const setupPath = path.join(outputDirectory, 'Jacky-Image-Setup.exe');
if (!fs.existsSync(setupPath)) throw new Error(`Installer was not generated: ${setupPath}`);
console.log(`Installer generated: ${setupPath}`);
