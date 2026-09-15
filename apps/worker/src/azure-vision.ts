import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { imageMime } from './openrouter.js';
import { IntegrationError, readJson } from './http.js';
import type { OcrItem, OcrPoint, OcrResult } from './ocr.js';

/**
 * Azure Vision OCR adapter (Read API).
 *
 * Optional auxiliary OCR layer: disabled unless AZURE_VISION_ENABLED=true and
 * explicitly configured. The original image remains the source of truth and
 * OCR never approves automatic imports — it only feeds the multimodal request
 * as auxiliary evidence. When enabled and failing, the caller must fail
 * closed before the paid multimodal call (no silent fallback).
 *
 * The Read API exposes lines and words; words carry the confidence values
 * that feed the per-line and global averages. The provider-neutral contract
 * (./ocr.ts) has `lines` and `blocks`; Azure does not segment blocks, so
 * `blocks` stays empty and `qualityScore` stays null (Azure Read has no
 * quality score).
 */

export type AzureVisionConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
};

const API_VERSION = '3.2';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_KEY_BYTES = 512;
const MAX_OCR_TEXT = 64 * 1024;
const MAX_OCR_ITEMS = 2_000;
const MAX_POLL_ATTEMPTS = 24;
const POLL_INTERVAL_MS = 750;
const ENDPOINT_PATTERN =
  /^https:\/\/[a-z0-9][a-z0-9-]{1,62}\.(?:cognitiveservices|api\.cognitive)\.(?:azure|microsoft)\.com$/;

function readAzureKey(file: string): string {
  if (!isAbsolute(file)) throw new IntegrationError('AZURE_VISION_KEY_FILE_INVALID');
  try {
    const bytes = readFileSync(file);
    if (bytes.length === 0 || bytes.length > MAX_KEY_BYTES) throw new Error('size');
    // Resource keys are URL-safe alphanumeric strings (base64url-like); trim only trailing whitespace.
    const value = bytes.toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new Error('shape');
    return value;
  } catch {
    throw new IntegrationError('AZURE_VISION_KEY_FILE_INVALID');
  }
}

export function readAzureVisionConfig(env: NodeJS.ProcessEnv): AzureVisionConfig | null {
  if (env.AZURE_VISION_ENABLED === undefined || env.AZURE_VISION_ENABLED === 'false') return null;
  if (env.AZURE_VISION_ENABLED !== 'true')
    throw new IntegrationError('AZURE_VISION_CONFIGURATION_INVALID');
  const endpoint = env.AZURE_VISION_ENDPOINT;
  if (typeof endpoint !== 'string' || !ENDPOINT_PATTERN.test(endpoint))
    throw new IntegrationError('AZURE_VISION_CONFIGURATION_INVALID');
  const keyFile = env.AZURE_VISION_API_KEY_FILE;
  if (typeof keyFile !== 'string' || keyFile.length === 0)
    throw new IntegrationError('AZURE_VISION_CONFIGURATION_INVALID');
  const timeoutValue = env.AZURE_VISION_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  if (!/^\d{4,5}$/.test(timeoutValue))
    throw new IntegrationError('AZURE_VISION_CONFIGURATION_INVALID');
  const timeoutMs = Number(timeoutValue);
  if (timeoutMs < 5_000 || timeoutMs > 60_000)
    throw new IntegrationError('AZURE_VISION_CONFIGURATION_INVALID');
  return { endpoint, apiKey: readAzureKey(keyFile), timeoutMs };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundingPoints(value: unknown): OcrPoint[] {
  if (!Array.isArray(value)) return [];
  const numbers = value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );
  if (numbers.length < 8) return [];
  return [
    { x: numbers[0]!, y: numbers[1]! },
    { x: numbers[2]!, y: numbers[3]! },
    { x: numbers[4]!, y: numbers[5]! },
    { x: numbers[6]!, y: numbers[7]! },
  ];
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function lineItem(value: unknown): OcrItem | null {
  if (!value || typeof value !== 'object') return null;
  const line = value as { text?: unknown; words?: unknown; boundingBox?: unknown };
  const text = typeof line.text === 'string' ? line.text : '';
  if (!text) return null;
  const words = Array.isArray(line.words) ? line.words : [];
  const confidence = average(
    words.map((word) =>
      word && typeof word === 'object'
        ? numberOrNull((word as { confidence?: unknown }).confidence)
        : null,
    ),
  );
  return { text, confidence, boundingPoly: boundingPoints(line.boundingBox) };
}

function parseAnalyzeResult(value: unknown): OcrResult {
  if (!value || typeof value !== 'object')
    throw new IntegrationError('AZURE_VISION_RESPONSE_INVALID');
  const analyze = (value as { analyzeResult?: unknown }).analyzeResult;
  if (!analyze || typeof analyze !== 'object')
    throw new IntegrationError('AZURE_VISION_RESPONSE_INVALID');
  const rawPages = (analyze as { readResults?: unknown }).readResults;
  if (!Array.isArray(rawPages)) throw new IntegrationError('AZURE_VISION_RESPONSE_INVALID');
  const lineTexts: string[] = [];
  const wordConfidences: Array<number | null> = [];
  let itemCount = 0;
  const pages = rawPages.slice(0, 20).map((page) => {
    const entry = (page ?? {}) as {
      width?: unknown;
      height?: unknown;
      unit?: unknown;
      lines?: unknown;
    };
    const rawLines = Array.isArray(entry.lines) ? entry.lines : [];
    const lines: OcrItem[] = [];
    for (const rawLine of rawLines) {
      if (itemCount >= MAX_OCR_ITEMS) break;
      const item = lineItem(rawLine);
      if (!item) continue;
      itemCount += 1;
      lines.push(item);
      lineTexts.push(item.text);
      if (rawLine && typeof rawLine === 'object') {
        const words = (rawLine as { words?: unknown }).words;
        if (Array.isArray(words)) {
          for (const word of words) {
            const confidence =
              word && typeof word === 'object'
                ? numberOrNull((word as { confidence?: unknown }).confidence)
                : null;
            if (confidence !== null) wordConfidences.push(confidence);
          }
        }
      }
    }
    return {
      width: numberOrNull(entry.width),
      height: numberOrNull(entry.height),
      unit: typeof entry.unit === 'string' ? entry.unit.slice(0, 32) : null,
      qualityScore: null,
      blocks: [] as OcrItem[],
      lines,
    };
  });
  const text = lineTexts.join('\n');
  if (!text.trim()) throw new IntegrationError('AZURE_VISION_EMPTY');
  if (text.length > MAX_OCR_TEXT) throw new IntegrationError('AZURE_VISION_RESPONSE_TOO_LARGE');
  return {
    text,
    pages,
    averageConfidence: average(wordConfidences),
    averageQualityScore: null,
  };
}

function statusError(status: number): string {
  if (status === 401 || status === 403) return 'AZURE_VISION_AUTH_REFUSED';
  if (status === 429) return 'AZURE_VISION_RATE_LIMITED';
  return 'AZURE_VISION_PROVIDER_UNAVAILABLE';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function extractAzureVisionOcr(options: {
  config: AzureVisionConfig;
  image: Buffer;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<OcrResult> {
  imageMime(options.image); // Rejects unsupported attachments before any network access.
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.config.timeoutMs)])
    : AbortSignal.timeout(options.config.timeoutMs);
  const keyHeader = { 'Ocp-Apim-Subscription-Key': options.config.apiKey };
  try {
    const submit = await fetchImpl(
      `${options.config.endpoint}/vision/v${API_VERSION}/read/analyze?language=pt`,
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/octet-stream', ...keyHeader },
        body: new Uint8Array(options.image),
      },
    );
    if (!submit.ok) {
      await submit.body?.cancel();
      throw new IntegrationError(statusError(submit.status));
    }
    const location = submit.headers.get('operation-location');
    if (!location || !location.startsWith(`${options.config.endpoint}/`))
      throw new IntegrationError('AZURE_VISION_RESPONSE_INVALID');
    await submit.body?.cancel();
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await wait(POLL_INTERVAL_MS);
      const poll = await fetchImpl(location, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: keyHeader,
      });
      if (!poll.ok) {
        await poll.body?.cancel();
        throw new IntegrationError(statusError(poll.status));
      }
      const body = await readJson(poll, 2 * 1024 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new IntegrationError('AZURE_VISION_RESPONSE_INVALID');
      const status = (body as { status?: unknown }).status;
      if (status === 'succeeded') return parseAnalyzeResult(body);
      if (status === 'failed') throw new IntegrationError('AZURE_VISION_PROVIDER_UNAVAILABLE');
    }
    throw new IntegrationError('AZURE_VISION_INTERRUPTED');
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? 'AZURE_VISION_INTERRUPTED'
        : 'AZURE_VISION_CONNECTION_FAILED',
    );
  }
}
