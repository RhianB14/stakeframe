import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (name: string) => readFileSync(join(root, name), 'utf8');
const productionComposes = [
  'compose.production.yml',
  'compose.integrations.yml',
  'compose.ocr.yml',
  'compose.operations.yml',
  'compose.automatic-import.yml',
];

describe('deployment compose contract', () => {
  it('delivers the Telegram Mini App URL to the worker through required interpolation', () => {
    const integrations = read('compose.integrations.yml');
    expect(integrations).toContain('TELEGRAM_MINIAPP_URL: ${TELEGRAM_MINIAPP_URL:?');
    expect(integrations).not.toMatch(/TELEGRAM_MINIAPP_URL:\s*https?:\/\//);
  });

  it('keeps OCR activation behind the private overlay with Azure primary and Google fallback', () => {
    const integrations = read('compose.integrations.yml');
    expect(integrations).toMatch(/AZURE_VISION_ENABLED: 'false'/);
    const ocr = read('compose.ocr.yml');
    expect(ocr).toContain("AZURE_VISION_ENABLED: 'true'");
    expect(ocr).toContain("GOOGLE_VISION_ENABLED: 'true'");
    expect(ocr).toContain('OCR_MODE: failover');
    expect(ocr).toContain('OCR_PRIMARY_PROVIDER: azure');
    expect(ocr).toContain('OCR_FALLBACK_PROVIDER: google');
    expect(ocr).toContain('AZURE_VISION_ENDPOINT: ${AZURE_VISION_ENDPOINT:?');
    expect(ocr).toContain('GOOGLE_VISION_ENDPOINT: https://vision.googleapis.com');
    expect(ocr).toContain('azure_vision_api_key');
    expect(ocr).toContain('google_vision_api_key');
    expect(ocr).not.toMatch(/google\/gemini|openrouter/i);
  });

  it('keeps the desired OpenRouter policy and automatic import gate explicit', () => {
    const integrations = read('compose.integrations.yml');
    for (const line of [
      "AI_ENABLED: 'true'",
      'AI_PROVIDER: openrouter',
      'OPENROUTER_MODEL: google/gemini-3.8-flash',
      "OPENROUTER_ALLOW_FALLBACKS: 'true'",
      "OPENROUTER_MAX_OUTPUT_TOKENS: '4096'",
      'OPENROUTER_REASONING_EFFORT: disabled',
      "OPENROUTER_TIMEOUT_MS: '60000'",
      "TELEGRAM_ENABLED: 'true'",
      "AUTOMATIC_IMPORT_ENABLED: 'false'",
    ])
      expect(integrations).toContain(line);
    const automatic = read('compose.automatic-import.yml');
    expect(automatic).toContain("AUTOMATIC_IMPORT_ENABLED: 'true'");
    expect(automatic).toContain(
      'AUTOMATIC_IMPORT_POLICIES_FILE: /run/policies/automatic-import.json',
    );
  });

  it('never stores a literal provider or deployment secret value in the production composes', () => {
    for (const file of productionComposes) {
      const lines = read(file).split('\n');
      for (const [index, line] of lines.entries()) {
        const match = line.match(
          /^\s*([A-Z][A-Z0-9_]*(?:KEY|SECRET|PASSWORD|CREDENTIAL|TOKEN(?!S))[A-Z0-9_]*)\s*:\s*(.+?)\s*$/,
        );
        if (!match) continue;
        const name = match[1];
        const value = match[2];
        if (name === undefined || value === undefined) continue;
        expect
          .soft(
            value.startsWith('${') || value.startsWith('/run/secrets/'),
            `${file}:${index + 1}:${name}`,
          )
          .toBe(true);
      }
    }
  });
});
