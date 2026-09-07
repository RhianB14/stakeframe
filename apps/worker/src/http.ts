export class IntegrationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IntegrationError';
  }
}

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new IntegrationError('EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new IntegrationError('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readJson(response: Response, limit = 262_144): Promise<unknown> {
  const bytes = await readBounded(response, limit);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new IntegrationError('INVALID_JSON_RESPONSE');
  }
}
