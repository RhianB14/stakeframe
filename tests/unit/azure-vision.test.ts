import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  extractAzureVisionOcr,
  readAzureVisionConfig,
} from '../../apps/worker/src/azure-vision.js';

// Synthetic fixtures only: no real Azure resource, endpoint, key or ticket.
const API_KEY = 'fixture-azure-key-0123456789abcdef';
const ENDPOINT = 'https://stakeframe-fixture.cognitiveservices.azure.com';
const OPERATION_URL = `${ENDPOINT}/vision/v3.2/read/analyzeResults/fixture-operation`;

function keyFile(contents = `${API_KEY}\n`): string {
  const directory = mkdtempSync(join(tmpdir(), 'stakeframe-azure-vision-'));
  const file = join(directory, 'api_key');
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function config() {
  return readAzureVisionConfig({
    AZURE_VISION_ENABLED: 'true',
    AZURE_VISION_ENDPOINT: ENDPOINT,
    AZURE_VISION_API_KEY_FILE: keyFile(),
  })!;
}

const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);

function line(text: string, top: number, words: Array<[string, number]>) {
  return {
    boundingBox: [10, top, 510, top, 510, top + 40, 10, top + 40],
    text,
    words: words.map(([word, confidence], index) => ({
      boundingBox: [
        10 + index * 50,
        top,
        60 + index * 50,
        top,
        60 + index * 50,
        top + 40,
        10 + index * 50,
        top + 40,
      ],
      text: word,
      confidence,
    })),
  };
}

const analysisFixture = {
  status: 'succeeded',
  analyzeResult: {
    version: '3.2.0',
    readResults: [
      {
        page: 1,
        angle: 0,
        width: 1000,
        height: 2000,
        unit: 'pixel',
        lines: [
          line('Retorno potencial R$ 20,00', 20, [
            ['Retorno', 0.99],
            ['potencial', 0.97],
            ['R$', 0.98],
          ]),
          line('Time A x Time B', 80, [
            ['Time', 0.95],
            ['A', 0.85],
          ]),
        ],
      },
    ],
  },
};

const accepted = () =>
  new Response(null, {
    status: 202,
    headers: { 'operation-location': OPERATION_URL },
  });

describe('Azure Vision OCR boundary', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(readAzureVisionConfig({})).toBeNull();
    expect(readAzureVisionConfig({ AZURE_VISION_ENABLED: 'false' })).toBeNull();
    expect(() => readAzureVisionConfig({ AZURE_VISION_ENABLED: 'yes' })).toThrow(
      'AZURE_VISION_CONFIGURATION_INVALID',
    );
  });

  it('rejects incomplete, relative or invalid configuration before any network access', () => {
    expect(() =>
      readAzureVisionConfig({ AZURE_VISION_ENABLED: 'true', AZURE_VISION_API_KEY_FILE: keyFile() }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: 'cognitiveservices.azure.com',
        AZURE_VISION_API_KEY_FILE: keyFile(),
      }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: 'http://stakeframe-fixture.cognitiveservices.azure.com',
        AZURE_VISION_API_KEY_FILE: keyFile(),
      }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: 'https://example.com',
        AZURE_VISION_API_KEY_FILE: keyFile(),
      }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: ENDPOINT,
        AZURE_VISION_API_KEY_FILE: 'relative.key',
      }),
    ).toThrow('AZURE_VISION_KEY_FILE_INVALID');
    expect(() =>
      readAzureVisionConfig({ AZURE_VISION_ENABLED: 'true', AZURE_VISION_ENDPOINT: ENDPOINT }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: ENDPOINT,
        AZURE_VISION_API_KEY_FILE: keyFile(''),
      }),
    ).toThrow('AZURE_VISION_KEY_FILE_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: ENDPOINT,
        AZURE_VISION_API_KEY_FILE: keyFile(),
        AZURE_VISION_TIMEOUT_MS: '100',
      }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
    expect(() =>
      readAzureVisionConfig({
        AZURE_VISION_ENABLED: 'true',
        AZURE_VISION_ENDPOINT: ENDPOINT,
        AZURE_VISION_API_KEY_FILE: keyFile(),
        AZURE_VISION_TIMEOUT_MS: '120000',
      }),
    ).toThrow('AZURE_VISION_CONFIGURATION_INVALID');
  });

  it('submits the Read request in portuguese and normalizes lines, words, coordinates and confidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(analysisFixture));
    const result = await extractAzureVisionOcr({ config: config(), image, fetchImpl });

    expect(result.text).toBe('Retorno potencial R$ 20,00\nTime A x Time B');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.width).toBe(1000);
    expect(result.pages[0]?.height).toBe(2000);
    expect(result.pages[0]?.unit).toBe('pixel');
    // Azure Read does not provide a quality score: the contract stays null.
    expect(result.pages[0]?.qualityScore).toBeNull();
    expect(result.pages[0]?.blocks).toEqual([]);
    const first = result.pages[0]?.lines[0];
    expect(first?.text).toBe('Retorno potencial R$ 20,00');
    expect(first?.confidence).toBeCloseTo((0.99 + 0.97 + 0.98) / 3);
    expect(first?.boundingPoly).toEqual([
      { x: 10, y: 20 },
      { x: 510, y: 20 },
      { x: 510, y: 60 },
      { x: 10, y: 60 },
    ]);
    expect(result.averageConfidence).toBeCloseTo((0.99 + 0.97 + 0.98 + 0.95 + 0.85) / 5);
    expect(result.averageQualityScore).toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [submitUrl, submitInit] = fetchImpl.mock.calls[0]!;
    expect(String(submitUrl)).toBe(`${ENDPOINT}/vision/v3.2/read/analyze?language=pt`);
    expect(submitInit?.method).toBe('POST');
    expect(submitInit?.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'Ocp-Apim-Subscription-Key': API_KEY,
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(OPERATION_URL);
  });

  it('polls while the analysis is running and fails sanitized when the provider reports failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({ status: 'running' }))
      .mockResolvedValueOnce(Response.json(analysisFixture));
    const result = await extractAzureVisionOcr({ config: config(), image, fetchImpl });
    expect(result.text).toContain('Retorno potencial');
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const failing = vi.fn<typeof fetch>();
    failing
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({ status: 'failed' }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: failing }),
    ).rejects.toThrow('AZURE_VISION_PROVIDER_UNAVAILABLE');
  });

  it('keeps polling until the analysis completes within the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({ status: 'notStarted' }))
      .mockResolvedValueOnce(Response.json({ status: 'running' }))
      .mockResolvedValueOnce(Response.json(analysisFixture));
    const result = await extractAzureVisionOcr({
      config: { endpoint: ENDPOINT, apiKey: API_KEY, timeoutMs: 5_000 },
      image,
      fetchImpl,
    });
    expect(result.text).toContain('Retorno potencial');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // The submission POST happens exactly once: no application-level retry.
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('stops polling at the deadline when the analysis never completes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        init?.method === 'POST' ? accepted() : Response.json({ status: 'running' }),
      );
    const started = Date.now();
    await expect(
      extractAzureVisionOcr({
        config: { endpoint: ENDPOINT, apiKey: API_KEY, timeoutMs: 800 },
        image,
        fetchImpl,
      }),
    ).rejects.toThrow('AZURE_VISION_INTERRUPTED');
    const elapsed = Date.now() - started;
    // The loop honored the effective deadline instead of ending ~18 s early.
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(5_000);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    // Only the polls that fit inside the deadline happened (never the old cap of 24).
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === 'GET').length,
    ).toBeLessThanOrEqual(3);
  });

  it('makes no additional calls after the deadline', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        init?.method === 'POST' ? accepted() : Response.json({ status: 'running' }),
      );
    await expect(
      extractAzureVisionOcr({
        config: { endpoint: ENDPOINT, apiKey: API_KEY, timeoutMs: 800 },
        image,
        fetchImpl,
      }),
    ).rejects.toThrow('AZURE_VISION_INTERRUPTED');
    const callsAfterDeadline = fetchImpl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(fetchImpl.mock.calls.length).toBe(callsAfterDeadline);
  });

  it('cancels the polling on external interruption without further calls', async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        init?.method === 'POST' ? accepted() : Response.json({ status: 'running' }),
      );
    const pending = extractAzureVisionOcr({
      config: { endpoint: ENDPOINT, apiKey: API_KEY, timeoutMs: 30_000 },
      image,
      fetchImpl,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow('AZURE_VISION_INTERRUPTED');
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    const callsAfterAbort = fetchImpl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fetchImpl.mock.calls.length).toBe(callsAfterAbort);
  });

  it('treats an empty analysis as sanitized empty evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(
        Response.json({ status: 'succeeded', analyzeResult: { readResults: [] } }),
      );
    await expect(extractAzureVisionOcr({ config: config(), image, fetchImpl })).rejects.toThrow(
      'AZURE_VISION_EMPTY',
    );
  });

  it('rejects invalid responses, including a missing operation location', async () => {
    const noAnalyze = vi.fn<typeof fetch>();
    noAnalyze
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({ status: 'succeeded' }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: noAnalyze }),
    ).rejects.toThrow('AZURE_VISION_RESPONSE_INVALID');

    const notAnObject = vi.fn<typeof fetch>();
    notAnObject
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(['unexpected']));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: notAnObject }),
    ).rejects.toThrow('AZURE_VISION_RESPONSE_INVALID');

    const noLocation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: noLocation }),
    ).rejects.toThrow('AZURE_VISION_RESPONSE_INVALID');
  });

  it('sanitizes authentication failures on submit and on poll', async () => {
    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: forbidden }),
    ).rejects.toThrow('AZURE_VISION_AUTH_REFUSED');

    const unauthorized = vi.fn<typeof fetch>();
    unauthorized
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: unauthorized }),
    ).rejects.toThrow('AZURE_VISION_AUTH_REFUSED');
  });

  it('sanitizes rate limiting without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 429 }));
    await expect(extractAzureVisionOcr({ config: config(), image, fetchImpl })).rejects.toThrow(
      'AZURE_VISION_RATE_LIMITED',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sanitizes timeouts and transport failures', async () => {
    const timedOut = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: timedOut }),
    ).rejects.toThrow('AZURE_VISION_INTERRUPTED');

    const aborted = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: aborted }),
    ).rejects.toThrow('AZURE_VISION_INTERRUPTED');

    const refused = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed'));
    await expect(
      extractAzureVisionOcr({ config: config(), image, fetchImpl: refused }),
    ).rejects.toThrow('AZURE_VISION_CONNECTION_FAILED');
  });

  it('never exposes the api key outside the request header', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(Response.json(analysisFixture));
    await extractAzureVisionOcr({ config: config(), image, fetchImpl });
    const header = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(header['Ocp-Apim-Subscription-Key']).toBe(API_KEY);

    const failing = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    let message = '';
    try {
      await extractAzureVisionOcr({ config: config(), image, fetchImpl: failing });
    } catch (error) {
      message = `${String(error)} ${error instanceof Error ? error.message : ''}`;
    }
    expect(message).toContain('AZURE_VISION_AUTH_REFUSED');
    expect(message).not.toContain(API_KEY);
  });
});
