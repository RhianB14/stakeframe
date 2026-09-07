import { randomUUID } from 'node:crypto';
import { createRequest, fixtureSha256, ProbeError, verifyExtraction } from './probe.mjs';

export const goModel = 'deepseek-v4-flash-vision-exp';

export function createGoRequest(png) {
  // Reuse the exact synthetic image guard, field schema and extraction instructions.
  const reference = createRequest('gemini-3.1-flash-lite', png);
  return {
    model: goModel,
    stream: false,
    max_tokens: 2048,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
          },
          {
            type: 'text',
            text: `${reference.contents[0].parts[1].text} Schema dos campos JSON: ${JSON.stringify(reference.generationConfig.responseJsonSchema)}`,
          },
        ],
      },
    ],
  };
}

export async function probeGo({ apiKey, png, fetchImpl = fetch }) {
  const body = createGoRequest(png);
  if (!/^sk-[A-Za-z0-9_-]{20,200}$/.test(apiKey ?? '')) throw new ProbeError('AI_KEY_INVALID');
  const started = performance.now();
  try {
    const response = await fetchImpl('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'Stakeframe-M0-ModelProbe/0.1 (Codex; synthetic-image-evaluation)',
        'x-opencode-session': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 131_072) throw new ProbeError('AI_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
    // Do not print provider errors, which can contain credentials or submitted content.
    if (!response.ok)
      throw new ProbeError(response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_GO_HTTP_FAILED', {
        httpStatus: response.status,
      });
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ProbeError('AI_RESPONSE_INVALID');
    }
    if (
      !Array.isArray(payload?.choices) ||
      payload.choices.length !== 1 ||
      payload.choices[0]?.finish_reason !== 'stop' ||
      payload.choices[0]?.message?.refusal ||
      (payload.choices[0]?.message?.tool_calls != null &&
        (!Array.isArray(payload.choices[0].message.tool_calls) ||
          payload.choices[0].message.tool_calls.length > 0)) ||
      typeof payload.choices[0]?.message?.content !== 'string'
    )
      throw new ProbeError('AI_INCOMPLETE_OR_BLOCKED');
    const result = verifyExtraction({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: payload.choices[0].message.content }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: payload.usage?.prompt_tokens,
        candidatesTokenCount: payload.usage?.completion_tokens,
        thoughtsTokenCount: payload.usage?.completion_tokens_details?.reasoning_tokens,
        totalTokenCount: payload.usage?.total_tokens,
      },
    });
    return {
      ...result,
      provider: 'opencode-go',
      model: goModel,
      latencyMs: Math.round(performance.now() - started),
      fixtureSha256,
    };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(error?.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_TRANSPORT_FAILED');
  }
}
