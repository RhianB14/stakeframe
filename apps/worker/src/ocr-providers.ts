import {
  extractAzureVisionOcr,
  readAzureVisionConfig,
  type AzureVisionConfig,
} from './azure-vision.js';
import { IntegrationError } from './http.js';
import {
  extractGoogleVisionOcr,
  readGoogleVisionConfig,
  type GoogleVisionConfig,
} from './google-vision.js';
import type { OcrResult } from './ocr.js';

export type OcrProviderName = 'azure' | 'google';
export type OcrMode = 'failover' | 'consensus';

export type OcrProvidersConfig = {
  azure: AzureVisionConfig | null;
  google: GoogleVisionConfig | null;
  primary: OcrProviderName;
  fallback: OcrProviderName | null;
  mode: OcrMode;
};

function readProvider(value: string | undefined, fallback: OcrProviderName): OcrProviderName {
  const provider = value ?? fallback;
  if (provider !== 'azure' && provider !== 'google')
    throw new IntegrationError('OCR_CONFIGURATION_INVALID');
  return provider;
}

export function readOcrProvidersConfig(env: NodeJS.ProcessEnv): OcrProvidersConfig | null {
  const azure = readAzureVisionConfig(env);
  const google = readGoogleVisionConfig(env);
  if (!azure && !google) return null;
  const defaultPrimary: OcrProviderName = azure ? 'azure' : 'google';
  const primary = readProvider(env.OCR_PRIMARY_PROVIDER, defaultPrimary);
  if (!{ azure, google }[primary]) throw new IntegrationError('OCR_CONFIGURATION_INVALID');
  const configuredFallback = env.OCR_FALLBACK_PROVIDER;
  const fallback =
    configuredFallback === undefined || configuredFallback === '' || configuredFallback === 'none'
      ? azure && google
        ? primary === 'azure'
          ? 'google'
          : 'azure'
        : null
      : readProvider(configuredFallback, 'azure');
  if (fallback === primary || (fallback && !{ azure, google }[fallback]))
    throw new IntegrationError('OCR_CONFIGURATION_INVALID');
  const mode = env.OCR_MODE ?? 'failover';
  if (mode !== 'failover' && mode !== 'consensus')
    throw new IntegrationError('OCR_CONFIGURATION_INVALID');
  if (mode === 'consensus' && !fallback) throw new IntegrationError('OCR_CONFIGURATION_INVALID');
  return { azure, google, primary, fallback, mode };
}

function providerConfig(config: OcrProvidersConfig, provider: OcrProviderName) {
  const selected = provider === 'azure' ? config.azure : config.google;
  if (!selected) throw new IntegrationError('OCR_CONFIGURATION_INVALID');
  return selected;
}

async function extractOne(options: {
  config: OcrProvidersConfig;
  provider: OcrProviderName;
  image: Buffer;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<OcrResult> {
  const providerConfigValue = providerConfig(options.config, options.provider);
  const common = {
    config: providerConfigValue,
    image: options.image,
    fetchImpl: options.fetchImpl,
  };
  return options.provider === 'azure'
    ? options.signal
      ? extractAzureVisionOcr({ ...common, signal: options.signal })
      : extractAzureVisionOcr(common)
    : options.signal
      ? extractGoogleVisionOcr({ ...common, signal: options.signal })
      : extractGoogleVisionOcr(common);
}

function normalizedText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isRecoverable(error: unknown): boolean {
  if (!(error instanceof IntegrationError)) return false;
  return /_(RATE_LIMITED|PROVIDER_UNAVAILABLE|CONNECTION_FAILED|INTERRUPTED)$/.test(error.code);
}

export async function extractConfiguredOcr(options: {
  config: OcrProvidersConfig;
  image: Buffer;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ result: OcrResult; provider: OcrProviderName; fallbackUsed: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let result: OcrResult;
  let provider = options.config.primary;
  let fallbackUsed = false;
  try {
    result = await extractOne({ ...options, provider, fetchImpl });
  } catch (error) {
    if (!options.config.fallback || !isRecoverable(error)) throw error;
    provider = options.config.fallback;
    fallbackUsed = true;
    result = await extractOne({ ...options, provider, fetchImpl });
  }
  if (options.config.mode === 'consensus' && options.config.fallback && !fallbackUsed) {
    const secondary = await extractOne({
      ...options,
      provider: options.config.fallback,
      fetchImpl,
    });
    if (normalizedText(result.text) !== normalizedText(secondary.text))
      throw new IntegrationError('OCR_PROVIDER_DIVERGENCE');
  }
  return { result, provider, fallbackUsed };
}
