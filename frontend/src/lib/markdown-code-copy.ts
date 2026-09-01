const CODE_COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CODE_COPIED_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function handleMarkdownCodeCopyButtonClick(target: EventTarget | null): boolean {
  const targetElement = target instanceof Element ? target : null;
  const btn = targetElement?.closest('.md-code-copy');
  if (!btn || !(btn instanceof HTMLElement)) return false;

  const encoded = btn.getAttribute('data-code');
  if (!encoded) return true;

  try {
    const code = decodeBase64Utf8(encoded);
    navigator.clipboard.writeText(code).catch(() => {});
    btn.innerHTML = CODE_COPIED_ICON;
    btn.classList.add('md-code-copied');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = CODE_COPY_ICON;
      btn.classList.remove('md-code-copied');
    }, 2000);
  } catch {}

  return true;
}
