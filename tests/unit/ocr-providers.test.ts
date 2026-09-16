import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  extractConfiguredOcr,
  readOcrProvidersConfig,
} from '../../apps/worker/src/ocr-providers.js';
import type { OcrProvidersConfig } from '../../apps/worker/src/ocr-providers.js';

const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);

function keyFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'stakeframe-ocr-providers-'));
  const file = join(directory, 'key');
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return file;
}

function configs(): OcrProvidersConfig {
  return readOcrProvidersConfig({
    AZURE_VISION_ENABLED: 'true',
    AZURE_VISION_ENDPOINT: 'https://fixture.cognitiveservices.azure.com',
    AZURE_VISION_API_KEY_FILE: keyFile('fixture-azure-key-0123456789abcdef'),
    GOOGLE_VISION_ENABLED: 'true',
    GOOGLE_VISION_API_KEY_FILE: keyFile('AIzaSyFixtureGoogleVisionKey0123456789'),
  })!;
}

const azureOperation =
  'https://fixture.cognitiveservices.azure.com/vision/v3.2/read/analyzeResults/op';
const azureSuccess = {
  status: 'succeeded',
  analyzeResult: {
    readResults: [
      { width: 100, height: 200, unit: 'pixel', lines: [{ text: 'ticket text', words: [] }] },
    ],
  },
};
const googleSuccess = { responses: [{ fullTextAnnotation: { text: 'ticket text', pages: [] } }] };

describe('OCR provider orchestration', () => {
  it('defaults to Azure primary with Google failover', () => {
    const config = configs();
    expect(config.primary).toBe('azure');
    expect(config.fallback).toBe('google');
    expect(config.mode).toBe('failover');
  });

  it('keeps a single enabled provider valid without a phantom fallback', () => {
    const config = readOcrProvidersConfig({
      AZURE_VISION_ENABLED: 'true',
      AZURE_VISION_ENDPOINT: 'https://fixture.cognitiveservices.azure.com',
      AZURE_VISION_API_KEY_FILE: keyFile('fixture-azure-key-0123456789abcdef'),
      OCR_FALLBACK_PROVIDER: '',
    })!;
    expect(config.primary).toBe('azure');
    expect(config.fallback).toBeNull();
  });

  it('uses Google once when Azure has a recoverable provider failure', async () => {
    const config = configs();
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json(googleSuccess));
    const result = await extractConfiguredOcr({ config, image, fetchImpl });
    expect(result.provider).toBe('google');
    expect(result.fallbackUsed).toBe(true);
    expect(result.result.text).toBe('ticket text');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not silently fall back for an Azure authentication failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    await expect(extractConfiguredOcr({ config: configs(), image, fetchImpl })).rejects.toThrow(
      'AZURE_VISION_AUTH_REFUSED',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('supports explicit consensus and rejects divergent OCR', async () => {
    const config = { ...configs(), mode: 'consensus' as const };
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(null, { status: 202, headers: { 'operation-location': azureOperation } }),
      )
      .mockResolvedValueOnce(Response.json(azureSuccess))
      .mockResolvedValueOnce(
        Response.json({
          responses: [{ fullTextAnnotation: { text: 'different text', pages: [] } }],
        }),
      );
    await expect(extractConfiguredOcr({ config, image, fetchImpl })).rejects.toThrow(
      'OCR_PROVIDER_DIVERGENCE',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
