import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeImage } from '@/lib/agent-chat-client';

describe('renderer API key boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends only the model configuration id for image description requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: 'description' }] }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await describeImage(
      'text-config-1',
      'gpt-5.4-mini',
      'openai-responses',
      'data:image/png;base64,AA==',
    );

    const request = fetchMock.mock.calls[0];
    const body = JSON.parse(String((request[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.modelConfigId).toBe('text-config-1');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('baseUrl');
  });
});
