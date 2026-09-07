import { createHash } from 'node:crypto';

export const models = Object.freeze([
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
]);
export const fixtureSha256 = '8d686b04a00cc53ea62bf5fd0ec55284ea9e9142a8955f7b5d9d1852c5bc1f70';
export const expected = Object.freeze({
  bookmaker: 'STAKEFRAME TESTE',
  event: 'TIME A X TIME B',
  market: 'TOTAL DE GOLS',
  selection: 'MAIS DE 2,5 GOLS',
  odds: '1.85',
  stake: '20.00',
  potentialReturn: '37.00',
  date: null,
});

export class ProbeError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'ProbeError';
    this.details = details;
  }
}

export function createRequest(model, png) {
  if (!models.includes(model)) throw new ProbeError('AI_MODEL_REFUSED');
  if (!Buffer.isBuffer(png) || createHash('sha256').update(png).digest('hex') !== fixtureSha256) {
    throw new ProbeError('AI_SYNTHETIC_FIXTURE_REQUIRED');
  }
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
          {
            text:
              'Extraia somente os dados visíveis neste bilhete fictício. Preserve o texto em maiúsculas. ' +
              'Não invente dados ausentes. Em odds, stake e potentialReturn, use strings decimais com ponto e duas casas, sem moeda. ' +
              'date deve ser null quando a data não estiver informada. Responda somente no JSON solicitado.',
          },
        ],
      },
    ],
    generationConfig: {
      candidateCount: 1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: 'LOW' },
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          bookmaker: { type: ['string', 'null'], description: 'Casa de aposta' },
          event: { type: ['string', 'null'], description: 'Evento' },
          market: { type: ['string', 'null'], description: 'Mercado' },
          selection: { type: ['string', 'null'], description: 'Seleção' },
          odds: { type: ['string', 'null'], description: 'Odd decimal' },
          stake: { type: ['string', 'null'], description: 'Valor apostado' },
          potentialReturn: { type: ['string', 'null'], description: 'Retorno potencial exibido' },
          date: { type: ['string', 'null'], description: 'Data informada; null quando ausente' },
        },
        required: Object.keys(expected),
        additionalProperties: false,
      },
    },
  };
}

export function verifyExtraction(payload) {
  const candidates = payload?.candidates;
  if (
    payload?.promptFeedback?.blockReason ||
    !Array.isArray(candidates) ||
    candidates.length !== 1 ||
    candidates[0]?.finishReason !== 'STOP'
  )
    throw new ProbeError('AI_INCOMPLETE_OR_BLOCKED');
  const parts = candidates[0]?.content?.parts;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some((part) => typeof part?.text !== 'string')
  )
    throw new ProbeError('AI_RESPONSE_INVALID');
  let result;
  try {
    result = JSON.parse(
      parts
        .filter((part) => part.thought !== true)
        .map((part) => part.text)
        .join(''),
    );
  } catch {
    throw new ProbeError('AI_JSON_INVALID');
  }
  if (
    !result ||
    Array.isArray(result) ||
    typeof result !== 'object' ||
    Object.keys(result).length !== Object.keys(expected).length ||
    Object.keys(result).some((key) => !Object.hasOwn(expected, key))
  )
    throw new ProbeError('AI_SCHEMA_MISMATCH');
  const fieldMatches = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [key, result[key] === value]),
  );
  const tokenCounts = {};
  for (const key of [
    'promptTokenCount',
    'candidatesTokenCount',
    'thoughtsTokenCount',
    'totalTokenCount',
  ]) {
    const value = payload.usageMetadata?.[key];
    tokenCounts[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return { passed: Object.values(fieldMatches).every(Boolean), fieldMatches, tokenCounts };
}

export async function probe({ apiKey, model, png, fetchImpl = fetch }) {
  const body = createRequest(model, png);
  if (!/^[A-Za-z0-9_-]{30,128}$/.test(apiKey ?? '')) throw new ProbeError('AI_KEY_INVALID');
  const started = performance.now();
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      },
    );
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 131_072) throw new ProbeError('AI_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      if (response.ok) throw new ProbeError('AI_RESPONSE_INVALID');
    }
    if (!response.ok) {
      const code =
        response.status === 429
          ? 'AI_RATE_LIMITED'
          : [401, 403].includes(response.status)
            ? 'AI_AUTH_REFUSED'
            : response.status === 404
              ? 'AI_MODEL_UNAVAILABLE'
              : 'AI_HTTP_FAILED';
      const apiStatus = payload?.error?.status;
      // Emit only a known status vocabulary and known field names, never Google's error message.
      const status = [
        'INVALID_ARGUMENT',
        'PERMISSION_DENIED',
        'UNAUTHENTICATED',
        'NOT_FOUND',
        'RESOURCE_EXHAUSTED',
        'UNAVAILABLE',
        'INTERNAL',
      ].includes(apiStatus)
        ? apiStatus
        : null;
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : '';
      const fields = [
        'thinkingLevel',
        'thinking_level',
        'responseJsonSchema',
        'response_json_schema',
        'responseSchema',
        'generationConfig',
      ].filter((field) => message.includes(field));
      throw new ProbeError(code, { httpStatus: response.status, apiStatus: status, fields });
    }
    return {
      ...verifyExtraction(payload),
      model,
      latencyMs: Math.round(performance.now() - started),
      fixtureSha256,
    };
  } catch (error) {
    // Never expose fetch/SDK errors, headers, response bodies, images or credentials.
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(error?.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_TRANSPORT_FAILED');
  }
}
