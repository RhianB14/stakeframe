import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { imageMime } from './openrouter.js';
import { IntegrationError, readJson } from './http.js';

const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const MAX_CREDENTIAL_BYTES = 32 * 1024;
const MAX_OCR_TEXT = 64 * 1024;
const MAX_OCR_ITEMS = 2_000;

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type DocumentAiConfig = {
  projectId: string;
  location: string;
  processorId: string;
  serviceAccount: ServiceAccount;
  timeoutMs: number;
};

export type OcrPoint = { x: number; y: number };

export type OcrItem = {
  text: string;
  confidence: number | null;
  boundingPoly: OcrPoint[];
};

export type DocumentOcrResult = {
  text: string;
  pages: Array<{
    width: number | null;
    height: number | null;
    unit: string | null;
    qualityScore: number | null;
    blocks: OcrItem[];
    lines: OcrItem[];
  }>;
  averageConfidence: number | null;
  averageQualityScore: number | null;
};

function validIdentifier(value: string | undefined, pattern: RegExp): value is string {
  return value !== undefined && pattern.test(value);
}

function readServiceAccount(file: string): ServiceAccount {
  if (!isAbsolute(file)) throw new IntegrationError('DOCUMENT_AI_CREDENTIALS_INVALID');
  try {
    const bytes = readFileSync(file);
    if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) throw new Error('size');
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const clientEmail = value.client_email;
    const privateKey = value.private_key;
    const tokenUri = value.token_uri;
    if (
      typeof clientEmail !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(clientEmail) ||
      typeof privateKey !== 'string' ||
      !privateKey.includes('-----BEGIN PRIVATE KEY-----') ||
      !privateKey.includes('-----END PRIVATE KEY-----') ||
      (tokenUri !== undefined &&
        (typeof tokenUri !== 'string' || !/^https:\/\/[^\s]+$/.test(tokenUri)))
    )
      throw new Error('shape');
    return tokenUri === undefined
      ? { client_email: clientEmail, private_key: privateKey }
      : { client_email: clientEmail, private_key: privateKey, token_uri: tokenUri };
  } catch {
    throw new IntegrationError('DOCUMENT_AI_CREDENTIALS_INVALID');
  }
}

export function readDocumentAiConfig(env: NodeJS.ProcessEnv): DocumentAiConfig | null {
  if (env.GOOGLE_DOCUMENT_AI_ENABLED === undefined || env.GOOGLE_DOCUMENT_AI_ENABLED === 'false')
    return null;
  if (env.GOOGLE_DOCUMENT_AI_ENABLED !== 'true')
    throw new IntegrationError('DOCUMENT_AI_CONFIGURATION_INVALID');
  if (
    !validIdentifier(env.GOOGLE_DOCUMENT_AI_PROJECT_ID, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/) ||
    !validIdentifier(env.GOOGLE_DOCUMENT_AI_LOCATION, /^(global|us|eu|[a-z]+-[a-z]+\d)$/) ||
    !validIdentifier(env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID, /^[a-z0-9-]{4,128}$/) ||
    !env.GOOGLE_DOCUMENT_AI_CREDENTIALS_FILE
  )
    throw new IntegrationError('DOCUMENT_AI_CONFIGURATION_INVALID');
  const timeoutValue = env.GOOGLE_DOCUMENT_AI_TIMEOUT_MS ?? '30000';
  if (!/^\d{4,5}$/.test(timeoutValue))
    throw new IntegrationError('DOCUMENT_AI_CONFIGURATION_INVALID');
  const timeoutMs = Number(timeoutValue);
  if (timeoutMs < 5_000 || timeoutMs > 60_000)
    throw new IntegrationError('DOCUMENT_AI_CONFIGURATION_INVALID');
  return {
    projectId: env.GOOGLE_DOCUMENT_AI_PROJECT_ID,
    location: env.GOOGLE_DOCUMENT_AI_LOCATION,
    processorId: env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID,
    serviceAccount: readServiceAccount(env.GOOGLE_DOCUMENT_AI_CREDENTIALS_FILE),
    timeoutMs,
  };
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

async function accessToken(
  account: ServiceAccount,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: GOOGLE_CLOUD_SCOPE,
      aud: account.token_uri ?? DEFAULT_TOKEN_URI,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${signer.sign(account.private_key, 'base64url')}`;
  const response = await fetchImpl(account.token_uri ?? DEFAULT_TOKEN_URI, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new IntegrationError('DOCUMENT_AI_AUTH_FAILED');
  }
  const body = await readJson(response, 16_384);
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { access_token?: unknown }).access_token !== 'string' ||
    !/^[\w.-]{20,4096}$/.test((body as { access_token: string }).access_token)
  )
    throw new IntegrationError('DOCUMENT_AI_AUTH_FAILED');
  return (body as { access_token: string }).access_token;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function points(value: unknown): OcrPoint[] {
  if (!value || typeof value !== 'object') return [];
  const source = (value as { normalizedVertices?: unknown; vertices?: unknown }).normalizedVertices;
  const vertices = Array.isArray(source) ? source : (value as { vertices?: unknown }).vertices;
  if (!Array.isArray(vertices)) return [];
  return vertices.slice(0, 8).flatMap((point) => {
    if (!point || typeof point !== 'object') return [];
    const x = numberOrNull((point as { x?: unknown }).x) ?? 0;
    const y = numberOrNull((point as { y?: unknown }).y) ?? 0;
    return [{ x, y }];
  });
}

function anchoredText(documentText: string, value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const anchor = value as { textAnchor?: { textSegments?: unknown; content?: unknown } };
  if (typeof anchor.textAnchor?.content === 'string') return anchor.textAnchor.content;
  const segments = anchor.textAnchor?.textSegments;
  if (!Array.isArray(segments)) return '';
  return segments
    .slice(0, 16)
    .map((segment) => {
      if (!segment || typeof segment !== 'object') return '';
      const start = Number((segment as { startIndex?: unknown }).startIndex ?? 0);
      const end = Number((segment as { endIndex?: unknown }).endIndex ?? 0);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
        return '';
      return documentText.slice(start, Math.min(end, documentText.length));
    })
    .join('');
}

function items(documentText: string, value: unknown): OcrItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_OCR_ITEMS).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const layout = (entry as { layout?: unknown }).layout;
    if (!layout || typeof layout !== 'object') return [];
    const text = anchoredText(documentText, layout);
    if (!text) return [];
    return [
      {
        text,
        confidence: numberOrNull((layout as { confidence?: unknown }).confidence),
        boundingPoly: points((layout as { boundingPoly?: unknown }).boundingPoly),
      },
    ];
  });
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function parseDocument(value: unknown): DocumentOcrResult {
  if (!value || typeof value !== 'object')
    throw new IntegrationError('DOCUMENT_AI_RESPONSE_INVALID');
  const document = (value as { document?: unknown }).document;
  if (!document || typeof document !== 'object')
    throw new IntegrationError('DOCUMENT_AI_RESPONSE_INVALID');
  const textValue = (document as { text?: unknown }).text;
  if (typeof textValue !== 'string' || !textValue.trim())
    throw new IntegrationError('DOCUMENT_AI_EMPTY');
  if (textValue.length > MAX_OCR_TEXT) throw new IntegrationError('DOCUMENT_AI_RESPONSE_TOO_LARGE');
  const text = textValue;
  const rawPages = (document as { pages?: unknown }).pages;
  if (!Array.isArray(rawPages) || rawPages.length === 0)
    throw new IntegrationError('DOCUMENT_AI_RESPONSE_INVALID');
  const pages = rawPages.slice(0, 20).map((page) => {
    if (!page || typeof page !== 'object')
      return { width: null, height: null, unit: null, qualityScore: null, blocks: [], lines: [] };
    const dimension = (
      page as { dimension?: { width?: unknown; height?: unknown; unit?: unknown } }
    ).dimension;
    const quality = (page as { imageQualityScores?: { qualityScore?: unknown } })
      .imageQualityScores;
    return {
      width: numberOrNull(dimension?.width),
      height: numberOrNull(dimension?.height),
      unit: typeof dimension?.unit === 'string' ? dimension.unit.slice(0, 32) : null,
      qualityScore: numberOrNull(quality?.qualityScore),
      blocks: items(text, (page as { blocks?: unknown }).blocks),
      lines: items(text, (page as { lines?: unknown }).lines),
    };
  });
  const confidence = pages.flatMap((page) =>
    [...page.blocks, ...page.lines].map((item) => item.confidence),
  );
  return {
    text,
    pages,
    averageConfidence: average(confidence),
    averageQualityScore: average(pages.map((page) => page.qualityScore)),
  };
}

export async function extractDocumentOcr(options: {
  config: DocumentAiConfig;
  image: Buffer;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DocumentOcrResult> {
  const mimeType = imageMime(options.image);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.config.timeoutMs)])
    : AbortSignal.timeout(options.config.timeoutMs);
  try {
    const token = await accessToken(options.config.serviceAccount, fetchImpl, signal);
    const host =
      options.config.location === 'global'
        ? 'documentai.googleapis.com'
        : `${options.config.location}-documentai.googleapis.com`;
    const name = `projects/${options.config.projectId}/locations/${options.config.location}/processors/${options.config.processorId}`;
    const response = await fetchImpl(`https://${host}/v1/${name}:process`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        rawDocument: { content: options.image.toString('base64'), mimeType },
        processOptions: { ocrConfig: { enableImageQualityScores: true } },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new IntegrationError(
        response.status === 401 || response.status === 403
          ? 'DOCUMENT_AI_AUTH_FAILED'
          : response.status === 429
            ? 'DOCUMENT_AI_RATE_LIMITED'
            : 'DOCUMENT_AI_PROVIDER_UNAVAILABLE',
      );
    }
    return parseDocument(await readJson(response, 2 * 1024 * 1024));
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(
      signal.aborted ? 'DOCUMENT_AI_INTERRUPTED' : 'DOCUMENT_AI_CONNECTION_FAILED',
    );
  }
}
