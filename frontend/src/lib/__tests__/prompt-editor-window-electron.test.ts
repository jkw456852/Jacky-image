import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.resolve(testDir, '../../../../electron/main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(testDir, '../../../../electron/preload.cjs'), 'utf8');

describe('desktop prompt editor window', () => {
  it('opens the prompt editor in a dedicated BrowserWindow route', () => {
    expect(mainSource).toContain("jacky:prompt-editor-window:open");
    expect(mainSource).toContain('promptEditorWindows');
    expect(mainSource).toContain('/prompt-editor-window?sessionId=');
    expect(mainSource).toContain('width: 1380');
    expect(mainSource).toContain('minWidth: 900');
    expect(mainSource).toContain('promptEditorWindowSingleton');
    expect(mainSource).toContain("titleBarStyle: 'default'");
  });

  it('exposes only the prompt editor window IPC bridge through preload', () => {
    expect(preloadSource).toContain('promptEditorWindow: Object.freeze');
    expect(preloadSource).toContain("ipcRenderer.invoke('jacky:prompt-editor-window:open'");
    expect(preloadSource).toContain("ipcRenderer.invoke('jacky:prompt-editor-window:get-payload'");
    expect(preloadSource).toContain("ipcRenderer.invoke('jacky:prompt-editor-window:close'");
  });

  it('acknowledges close IPC and hides without destroying the editor renderer on Windows', () => {
    const closeHandler = mainSource.slice(
      mainSource.indexOf("ipcMain.handle('jacky:prompt-editor-window:close'"),
      mainSource.indexOf("ipcMain.handle('jacky:seat-cover-prompts:open-directory'"),
    );
    expect(closeHandler).toContain('setTimeout(() =>');
    expect(closeHandler).toContain('promptEditorWindowSessionIds.get(promptEditorWindow) === sessionId');
    expect(closeHandler).toContain('releasePromptEditorWindowSession(promptEditorWindow)');
    expect(closeHandler).toContain('promptEditorWindow.hide()');
    expect(closeHandler).not.toContain('promptEditorWindow.close()');
    expect(closeHandler).toContain('}, 100);');
    expect(closeHandler).toContain('return { ok: true };');
  });

  it('hides and reuses the editor instead of destroying its BrowserWindow', () => {
    expect(mainSource).toContain("promptEditorWindow.on('close', closeEvent =>");
    expect(mainSource).toContain('closeEvent.preventDefault()');
    expect(mainSource).toContain('releasePromptEditorWindowSession(promptEditorWindow)');
    expect(mainSource).toContain('promptEditorWindow.hide()');
  });
});
