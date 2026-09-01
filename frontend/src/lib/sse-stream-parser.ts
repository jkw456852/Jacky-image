/**
 * 通用 SSE (Server-Sent Events) 流解析工具
 * 从 agent-chat-client、reverse-prompt-client、prompt-optimize-client 中提取的公共逻辑
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const consumed = consumeSseEvent(buffer);
        if (!consumed) break;
        buffer = consumed.rest;
        const parsed = parseSseEvent(consumed.raw);
        if (parsed) onEvent(parsed);
      }
    }
    // flush 残留 buffer（部分实现最后一帧后没有空行结尾）
    if (buffer.trim().length > 0) {
      const parsed = parseSseEvent(buffer);
      if (parsed) onEvent(parsed);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export function consumeSseEvent(buffer: string): { raw: string; rest: string } | null {
  const idxLF = buffer.indexOf('\n\n');
  const idxCRLF = buffer.indexOf('\r\n\r\n');
  if (idxLF === -1 && idxCRLF === -1) return null;

  if (idxCRLF !== -1 && (idxLF === -1 || idxCRLF < idxLF)) {
    return { raw: buffer.slice(0, idxCRLF), rest: buffer.slice(idxCRLF + 4) };
  }
  return { raw: buffer.slice(0, idxLF), rest: buffer.slice(idxLF + 2) };
}

export function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataParts.push(value);
    }
    // 忽略 id / retry
  }
  if (dataParts.length === 0) return null;
  return { event, data: dataParts.join('\n') };
}
