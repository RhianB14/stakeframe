declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        close?: () => void;
        HapticFeedback?: {
          notificationOccurred?: (type: 'success' | 'warning' | 'error') => void;
        };
      };
    };
  }
}

export function telegramInitDataFromHash(hash: string): string {
  try {
    const queryStart = hash.indexOf('?');
    if (queryStart < 0) return '';
    return new URLSearchParams(hash.slice(queryStart)).get('tgWebAppData')?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Telegram injects WebApp.initData in the official client. The hash fallback
 * makes the Mini App resilient while the Telegram bridge script is still
 * loading and covers Web Telegram's tgWebAppData handoff without exposing it
 * in the URL sent to the API.
 */
export function readTelegramInitData(): string {
  const sdkValue = window.Telegram?.WebApp?.initData?.trim() ?? '';
  return sdkValue || telegramInitDataFromHash(window.location.hash);
}
