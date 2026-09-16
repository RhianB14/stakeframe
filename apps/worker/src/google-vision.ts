import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { imageMime } from './openrouter.js';
import { IntegrationError, readJson } from './http.js';
import type { OcrItem, OcrPoint, OcrResult } from './ocr.js';

/**
 * Google Cloud Vision OCR adapter.
 *
 * This adapter uses DOCUMENT_TEXT_DETECTION and normalizes the response to the
 * same provider-neutral contract used by Azure Vision. The original image is
 * still authoritative; OCR is auxiliary evidence only.
 */
export type GoogleVisionConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs: number;
};

const DEFAULT_ENDPOINT = 'https://vision.googleapis.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_KEY_BYTES = 512;
const MAX_OCR_TEXT = 64 * 1024;
const MAX_OCR_ITEMS = 2_000;
const ENDPOINT_PATTERN = /^https:\/\/vision\.googleapis\.com$/;

function readGoogleKey(file: string): string {
  if (!isAbsolute(file)) throw new IntegrationError('GOOGLE_VISION_KEY_FILE_INVALID');
  try {
    const bytes = readFileSync(file);
    if (bytes.length === 0 || bytes.length > MAX_KEY_BYTES) throw new Error('size');
    const value = bytes.toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) throw new Error('shape');
    return value;
  } catch {
    throw new IntegrationError('GOOGLE_VISION_KEY_FILE_INVALID');
  }
}

export function readGoogleVisionConfig(env: NodeJS.ProcessEnv): GoogleVisionConfig | null {
  if (env.GOOGLE_VISION_ENABLED === undefined || env.GOOGLE_VISION_ENABLED === 'false') return null;
  if (env.GOOGLE_VISION_ENABLED !== 'true')
    throw new IntegrationError('GOOGLE_VISION_CONFIGURATION_INVALID');
  const endpoint = env.GOOGLE_VISION_ENDPOINT ?? DEFAULT_ENDPOINT;
  if (!ENDPOINT_PATTERN.test(endpoint))
    throw new IntegrationError('GOOGLE_VISION_CONFIGURATION_INVALID');
  const keyFile = env.GOOGLE_VISION_API_KEY_FILE;
  if (typeof keyFile !== 'string' || keyFile.length === 0)
    throw new IntegrationError('GOOGLE_VISION_CONFIGURATION_INVALID');
  const timeoutValue = env.GOOGLE_VISION_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  if (!/^\d{4,5}$/.test(timeoutValue))
    throw new IntegrationError('GOOGLE_VISION_CONFIGURATION_INVALID');
  const timeoutMs = Number(timeoutValue);
  if (timeoutMs < 5_000 || timeoutMs > 60_000)
    throw new IntegrationError('GOOGLE_VISION_CONFIGURATION_INVALID');
  return { endpoint, apiKey: readGoogleKey(keyFile), timeoutMs };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundingPoints(value: unknown): OcrPoint[] {
  if (!value || typeof value !== 'object') return [];
  const vertices = (value as { vertices?: unknown }).vertices;
  if (!Array.isArray(vertices)) return [];
  return vertices
    .slice(0, 4)
    .map((vertex) => {
      if (!vertex || typeof vertex !== 'object') return null;
      const point = vertex as { x?: unknown; y?: unknown };
      const x = numberOrNull(point.x) ?? 0;
      const y = numberOrNull(point.y) ?? 0;
      return { x, y };
    })
    .filter((point): point is OcrPoint => point !== null);
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

type GoogleWord = {
  text: string;
  confidence: number | null;
  boundingPoly: OcrPoint[];
  breakType?: string;
};

function wordsFromParagraph(paragraph: unknown): GoogleWord[] {
  if (!paragraph || typeof paragraph !== 'object') return [];
  const rawWords = (paragraph as { words?: unknown }).words;
  if (!Array.isArray(rawWords)) return [];
  return rawWords.flatMap((rawWord) => {
    if (!rawWord || typeof rawWord !== 'object') return [];
    const word = rawWord as {
      symbols?: unknown;
      confidence?: unknown;
      boundingBox?: unknown;
    };
    const symbols = Array.isArray(word.symbols) ? word.symbols : [];
    const text = symbols
      .map((symbol) =>
        symbol &&
        typeof symbol === 'object' &&
        typeof (symbol as { text?: unknown }).text === 'string'
          ? (symbol as { text: string }).text
          : '',
      )
      .join('')
      .replace(/\s+/g, '');
    if (!text) return [];
    const lastSymbol = symbols.at(-1);
    const breakType =
      lastSymbol && typeof lastSymbol === 'object'
        ? (((lastSymbol as { property?: { detectedBreak?: { type?: unknown } } }).property
            ?.detectedBreak?.type ?? null) as string | null)
        : undefined;
    const normalized: GoogleWord = {
      text,
      confidence: numberOrNull(word.confidence),
      boundingPoly: boundingPoints(word.boundingBox),
    };
    if (typeof breakType === 'string') normalized.breakType = breakType;
    return [normalized];
  });
}

function itemFromWords(words: GoogleWord[], fallbackBox?: unknown): OcrItem | null {
  if (!words.length) return null;
  const wordPoints = words.flatMap((word) => word.boundingPoly).slice(0, 4);
  return {
    text: words.map((word) => word.text).join(' '),
    confidence: average(words.map((word) => word.confidence)),
    boundingPoly: wordPoints.length ? wordPoints : boundingPoints(fallbackBox),
  };
}

function linesFromWords(words: GoogleWord[], maxItems: number): OcrItem[] {
  const lines: OcrItem[] = [];
  let current: GoogleWord[] = [];
  const flush = () => {
    const item = itemFromWords(current);
    if (item) lines.push(item);
    current = [];
  };
  for (const word of words) {
    if (lines.length >= maxItems) break;
    current.push(word);
    if (word.breakType === 'LINE_BREAK' || word.breakType === 'EOL_SURE_SPACE') flush();
  }
  if (current.length && lines.length < maxItems) flush();
  return lines;
}

function parseResponse(value: unknown): OcrResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IntegrationError('GOOGLE_VISION_RESPONSE_INVALID');
  const responses = (value as { responses?: unknown }).responses;
  if (!Array.isArray(responses) || !responses[0] || typeof responses[0] !== 'object')
    throw new IntegrationError('GOOGLE_VISION_RESPONSE_INVALID');
  const response = responses[0] as {
    error?: unknown;
    fullTextAnnotation?: unknown;
    textAnnotations?: unknown;
  };
  if (response.error) throw new IntegrationError('GOOGLE_VISION_PROVIDER_UNAVAILABLE');
  const annotation = response.fullTextAnnotation;
  if (!annotation || typeof annotation !== 'object') {
    const textAnnotations = Array.isArray(response.textAnnotations) ? response.textAnnotations : [];
    const first = textAnnotations[0];
    const text =
      first &&
      typeof first === 'object' &&
      typeof (first as { description?: unknown }).description === 'string'
        ? (first as { description: string }).description
        : '';
    if (!text.trim()) throw new IntegrationError('GOOGLE_VISION_EMPTY');
    return {
      text,
      pages: [
        { width: null, height: null, unit: 'pixel', qualityScore: null, blocks: [], lines: [] },
      ],
      averageConfidence: null,
      averageQualityScore: null,
    };
  }
  const full = annotation as { text?: unknown; pages?: unknown };
  const text = typeof full.text === 'string' ? full.text : '';
  if (!text.trim()) throw new IntegrationError('GOOGLE_VISION_EMPTY');
  if (text.length > MAX_OCR_TEXT) throw new IntegrationError('GOOGLE_VISION_RESPONSE_TOO_LARGE');
  const rawPages = Array.isArray(full.pages) ? full.pages : [];
  const confidences: Array<number | null> = [];
  let itemCount = 0;
  const pages = rawPages.slice(0, 20).map((rawPage) => {
    const page = (rawPage ?? {}) as { width?: unknown; height?: unknown; blocks?: unknown };
    const blocks: OcrItem[] = [];
    const lines: OcrItem[] = [];
    const rawBlocks = Array.isArray(page.blocks) ? page.blocks : [];
    for (const rawBlock of rawBlocks) {
      if (itemCount >= MAX_OCR_ITEMS || !rawBlock || typeof rawBlock !== 'object') break;
      const paragraphs = Array.isArray((rawBlock as { paragraphs?: unknown }).paragraphs)
        ? ((rawBlock as { paragraphs: unknown[] }).paragraphs ?? [])
        : [];
      const words = paragraphs.flatMap(wordsFromParagraph);
      for (const word of words) confidences.push(word.confidence);
      const blockItem = itemFromWords(words, (rawBlock as { boundingBox?: unknown }).boundingBox);
      if (blockItem) {
        blocks.push(blockItem);
        itemCount += 1;
      }
      lines.push(...linesFromWords(words, Math.max(0, MAX_OCR_ITEMS - itemCount)));
    }
    return {
      width: numberOrNull(page.width),
      height: numberOrNull(page.height),
      unit: 'pixel',
      qualityScore: null,
      blocks,
      lines: lines.slice(0, MAX_OCR_ITEMS),
    };
  });
  return {
    text,
    pages,
    averageConfidence: average(confidences),
    averageQualityScore: null,
  };
}

function statusError(status: number): string {
  if (status === 401 || status === 403) return 'GOOGLE_VISION_AUTH_REFUSED';
  if (status === 429) return 'GOOGLE_VISION_RATE_LIMITED';
  if (status === 400 || status === 422) return 'GOOGLE_VISION_REQUEST_INVALID';
  return 'GOOGLE_VISION_PROVIDER_UNAVAILABLE';
}

export async function extractGoogleVisionOcr(options: {
  config: GoogleVisionConfig;
  image: Buffer;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<OcrResult> {
  imageMime(options.image);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.config.timeoutMs)])
    : AbortSignal.timeout(options.config.timeoutMs);
  try {
    const response = await fetchImpl(
      `${options.config.endpoint}/v1/images:annotate?key=${encodeURIComponent(options.config.apiKey)}`,
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: [
            {
              image: { content: options.image.toString('base64') },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
              imageContext: { languageHints: ['pt', 'en'] },
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new IntegrationError(statusError(response.status));
    }
    return parseResponse(await readJson(response, 2 * 1024 * 1024));
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? 'GOOGLE_VISION_INTERRUPTED'
        : 'GOOGLE_VISION_CONNECTION_FAILED',
    );
  }
}
