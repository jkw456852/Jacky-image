import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
const nativeBuildDirectory = process.env.JACKY_ELECTRON_NATIVE_BUILD_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(rootDirectory, 'build'), 'JackyImageBuild');
const appDirectory = path.join(nativeBuildDirectory, 'out', 'Jacky Image-win32-x64');
const updateConfigPath = path.join(appDirectory, 'resources', 'app-update.yml');

const npmCliPath = process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const packageResult = spawnSync(process.execPath, [npmCliPath, 'run', 'desktop:package'], {
  cwd: rootDirectory,
  env: process.env,
  stdio: 'inherit',
});
if (packageResult.status !== 0) process.exit(packageResult.status ?? 1);

if (!fs.existsSync(path.join(appDirectory, 'resources'))) {
  throw new Error(`Packaged Electron resources directory not found: ${appDirectory}`);
}
fs.writeFileSync(updateConfigPath, [
  'provider: github',
  'owner: jkw456852',
  'repo: Jacky-image',
  'releaseType: release',
  '',
].join('\n'), 'utf8');

const builderCli = path.join(rootDirectory, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const builderResult = spawnSync(process.execPath, [
  builderCli,
  '--win', 'nsis', '--x64', '--prepackaged', appDirectory,
  '--publish', process.argv.includes('--publish') ? 'always' : 'never',
], { cwd: rootDirectory, env: process.env, stdio: 'inherit' });
process.exit(builderResult.status ?? 1);
