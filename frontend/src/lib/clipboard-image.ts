export function getClipboardImageFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];
  const files: File[] = [];

  if (dataTransfer.items) {
    for (const item of Array.from(dataTransfer.items)) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  // Chromium normally exposes pasted images through `items`, while some
  // Electron/browser paths only populate `files`. Keep both paths so Ctrl+V
  // works consistently without returning the same File twice.
  if (files.length > 0 || !dataTransfer.files) return files;
  return Array.from(dataTransfer.files).filter(file => file.type.startsWith('image/'));
}
