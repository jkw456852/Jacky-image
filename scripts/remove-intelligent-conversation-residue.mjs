import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceTargets = [
  path.join(root, 'mastra'),
  path.join(root, 'build', 'desktop-runtime', 'mastra'),
  path.join(root, 'frontend', 'node_modules', '@assistant-ui'),
  path.join(root, 'frontend', 'node_modules', '@ag-ui'),
  path.join(root, 'frontend', 'node_modules', '@copilotkit'),
];
const userDataTarget = path.join(
  process.env.APPDATA || '',
  'Jacky Image',
  'data',
  'records',
  'mastra',
);

function removeExact(target, allowedParent) {
  const resolvedTarget = path.resolve(target);
  const resolvedParent = `${path.resolve(allowedParent)}${path.sep}`;
  if (!resolvedTarget.startsWith(resolvedParent)) {
    throw new Error(`Refusing to remove path outside allowed directory: ${resolvedTarget}`);
  }
  if (fs.existsSync(resolvedTarget)) {
    try {
      fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      if (fs.existsSync(resolvedTarget)) {
        console.warn(`[cleanup] ${resolvedTarget} is still in use and will be removed the next time Jacky Image starts after it has been fully exited from the system tray.`);
        return;
      }
      console.log(`[cleanup] Removed ${resolvedTarget}`);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY')) {
        console.warn(`[cleanup] ${resolvedTarget} is in use and will be removed the next time Jacky Image starts after it has been fully exited from the system tray.`);
        return;
      }
      throw error;
    }
  }
}

for (const target of workspaceTargets) removeExact(target, root);
if (userDataTarget && process.env.APPDATA) {
  removeExact(userDataTarget, path.join(process.env.APPDATA, 'Jacky Image', 'data', 'records'));
}
