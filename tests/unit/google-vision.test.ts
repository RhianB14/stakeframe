import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  extractGoogleVisionOcr,
  readGoogleVisionConfig,
} from '../../apps/worker/src/google-vision.js';

const API_KEY = 'AIzaSyFixtureGoogleVisionKey0123456789';
const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);

function keyFile(contents = `${API_KEY}\n`): string {
  const directory = mkdtempSync(join(tmpdir(), 'stakeframe-google-vision-'));
  const file = join(directory, 'api_key');
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function config() {
  return readGoogleVisionConfig({
    GOOGLE_VISION_ENABLED: 'true',
    GOOGLE_VISION_API_KEY_FILE: keyFile(),
  })!;
}

const point = (x: number, y: number) => ({
  vertices: [
    { x, y },
    { x: x + 10, y },
  ],
});
const visionResponse = {
  responses: [
    {
      fullTextAnnotation: {
        text: 'Retorno potencial R$ 20,00\nTime A x Time B',
        pages: [
          {
            width: 1000,
            height: 2000,
            blocks: [
              {
                boundingBox: point(10, 20),
                paragraphs: [
                  {
                    words: [
                      {
                        confidence: 0.96,
                        boundingBox: point(10, 20),
                        symbols: [
                          { text: 'Retorno' },
                          { text: ' ', property: { detectedBreak: { type: 'SPACE' } } },
                        ],
                      },
                      {
                        confidence: 0.94,
                        boundingBox: point(100, 20),
                        symbols: [
                          { text: 'potencial' },
                          { text: ' ', property: { detectedBreak: { type: 'SPACE' } } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ],
};

describe('Google Cloud Vision OCR boundary', () => {
  it('is disabled unless explicitly enabled and validates the private key file', () => {
    expect(readGoogleVisionConfig({})).toBeNull();
    expect(readGoogleVisionConfig({ GOOGLE_VISION_ENABLED: 'false' })).toBeNull();
    expect(() => readGoogleVisionConfig({ GOOGLE_VISION_ENABLED: 'yes' })).toThrow(
      'GOOGLE_VISION_CONFIGURATION_INVALID',
    );
    expect(() =>
      readGoogleVisionConfig({
        GOOGLE_VISION_ENABLED: 'true',
        GOOGLE_VISION_API_KEY_FILE: 'relative.key',
      }),
    ).toThrow('GOOGLE_VISION_KEY_FILE_INVALID');
    expect(() =>
      readGoogleVisionConfig({
        GOOGLE_VISION_ENABLED: 'true',
        GOOGLE_VISION_API_KEY_FILE: keyFile(''),
      }),
    ).toThrow('GOOGLE_VISION_KEY_FILE_INVALID');
  });

  it('submits DOCUMENT_TEXT_DETECTION in Portuguese and normalizes the response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(visionResponse));
    const result = await extractGoogleVisionOcr({ config: config(), image, fetchImpl });

    expect(result.text).toBe('Retorno potencial R$ 20,00\nTime A x Time B');
    expect(result.pages[0]?.width).toBe(1000);
    expect(result.pages[0]?.height).toBe(2000);
    expect(result.pages[0]?.unit).toBe('pixel');
    expect(result.pages[0]?.blocks[0]?.text).toBe('Retorno potencial');
    expect(result.pages[0]?.lines[0]?.confidence).toBeCloseTo(0.95);
    expect(result.averageConfidence).toBeCloseTo(0.95);
    expect(result.averageQualityScore).toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(API_KEY)}`,
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    const request = JSON.parse(String(init?.body)) as {
      requests: Array<{
        features: Array<{ type: string }>;
        imageContext: { languageHints: string[] };
      }>;
    };
    expect(request.requests[0]?.features[0]?.type).toBe('DOCUMENT_TEXT_DETECTION');
    expect(request.requests[0]?.imageContext.languageHints).toEqual(['pt', 'en']);
  });

  it('fails closed and sanitizes provider, auth, rate and transport failures', async () => {
    const failure = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(
      extractGoogleVisionOcr({ config: config(), image, fetchImpl: failure }),
    ).rejects.toThrow('GOOGLE_VISION_PROVIDER_UNAVAILABLE');

    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    await expect(
      extractGoogleVisionOcr({ config: config(), image, fetchImpl: forbidden }),
    ).rejects.toThrow('GOOGLE_VISION_AUTH_REFUSED');

    const rateLimited = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 429 }));
    await expect(
      extractGoogleVisionOcr({ config: config(), image, fetchImpl: rateLimited }),
    ).rejects.toThrow('GOOGLE_VISION_RATE_LIMITED');
    expect(rateLimited).toHaveBeenCalledTimes(1);

    const refused = vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport detail'));
    await expect(
      extractGoogleVisionOcr({ config: config(), image, fetchImpl: refused }),
    ).rejects.toThrow('GOOGLE_VISION_CONNECTION_FAILED');
    await expect(
      extractGoogleVisionOcr({ config: config(), image, fetchImpl: refused }),
    ).rejects.not.toThrow('private transport detail');
  });
});
