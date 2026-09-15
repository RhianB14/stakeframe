import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  extractDocumentOcr,
  readDocumentAiConfig,
} from '../../apps/worker/src/google-document-ai.js';

function credentialsFile() {
  const directory = mkdtempSync(join(tmpdir(), 'stakeframe-document-ai-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = join(directory, 'credentials.json');
  writeFileSync(
    file,
    JSON.stringify({
      type: 'service_account',
      client_email: 'stakeframe-ocr@fixture-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
    { mode: 0o600 },
  );
  return file;
}

function config() {
  return readDocumentAiConfig({
    STAKEFRAME_RUNTIME: 'local',
    GOOGLE_DOCUMENT_AI_ENABLED: 'true',
    GOOGLE_DOCUMENT_AI_PROJECT_ID: 'fixture-project',
    GOOGLE_DOCUMENT_AI_LOCATION: 'us',
    GOOGLE_DOCUMENT_AI_PROCESSOR_ID: 'processor-1234',
    GOOGLE_DOCUMENT_AI_CREDENTIALS_FILE: credentialsFile(),
  })!;
}

describe('Google Document AI OCR boundary', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(readDocumentAiConfig({ GOOGLE_DOCUMENT_AI_ENABLED: 'false' })).toBeNull();
    expect(() => readDocumentAiConfig({ GOOGLE_DOCUMENT_AI_ENABLED: 'yes' })).toThrow(
      'DOCUMENT_AI_CONFIGURATION_INVALID',
    );
  });

  it('requires a valid processor and private credential file', () => {
    expect(() =>
      readDocumentAiConfig({
        GOOGLE_DOCUMENT_AI_ENABLED: 'true',
        GOOGLE_DOCUMENT_AI_PROJECT_ID: 'fixture-project',
        GOOGLE_DOCUMENT_AI_LOCATION: 'us',
        GOOGLE_DOCUMENT_AI_PROCESSOR_ID: 'processor-1234',
        GOOGLE_DOCUMENT_AI_CREDENTIALS_FILE: 'relative.json',
      }),
    ).toThrow('DOCUMENT_AI_CREDENTIALS_INVALID');
  });

  it('exchanges a service credential and returns text, blocks, lines and quality', async () => {
    const documentText = 'Bet365\nRetorno potencial R$ 20,00\n';
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        Response.json({ access_token: 'fixture-access-token-123456', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          document: {
            text: documentText,
            pages: [
              {
                dimension: { width: 1000, height: 2000, unit: 'pixels' },
                imageQualityScores: { qualityScore: 0.97 },
                blocks: [
                  {
                    layout: {
                      textAnchor: { textSegments: [{ startIndex: 0, endIndex: 7 }] },
                      confidence: 0.99,
                      boundingPoly: {
                        normalizedVertices: [
                          { x: 0, y: 0 },
                          { x: 1, y: 1 },
                        ],
                      },
                    },
                  },
                ],
                lines: [
                  {
                    layout: {
                      textAnchor: {
                        textSegments: [{ startIndex: 7, endIndex: documentText.length }],
                      },
                      confidence: 0.98,
                      boundingPoly: {
                        normalizedVertices: [
                          { x: 0.1, y: 0.2 },
                          { x: 0.9, y: 0.3 },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        }),
      );

    const result = await extractDocumentOcr({
      config: config(),
      image: Buffer.from([255, 216, 255, 217]),
      fetchImpl,
    });

    expect(result.text).toBe(documentText);
    expect(result.pages[0]?.blocks[0]?.text).toBe('Bet365\n');
    expect(result.pages[0]?.lines[0]?.text).toBe('Retorno potencial R$ 20,00\n');
    expect(result.pages[0]?.qualityScore).toBe(0.97);
    expect(result.averageConfidence).toBeCloseTo(0.985);
    expect(result.averageQualityScore).toBe(0.97);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const tokenRequest = fetchImpl.mock.calls[0]?.[1];
    expect(tokenRequest?.method).toBe('POST');
    expect(String(tokenRequest?.body)).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );
    const documentRequest = fetchImpl.mock.calls[1]?.[1];
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://us-documentai.googleapis.com/v1/projects/fixture-project/locations/us/processors/processor-1234:process',
    );
    expect(documentRequest?.headers).toMatchObject({
      authorization: 'Bearer fixture-access-token-123456',
    });
    expect(String(documentRequest?.body)).toContain('enableImageQualityScores');
  });

  it('sanitizes provider and authentication failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 403 }));
    await expect(
      extractDocumentOcr({ config: config(), image: Buffer.from([255, 216, 255, 217]), fetchImpl }),
    ).rejects.toThrow('DOCUMENT_AI_AUTH_FAILED');
  });
});
