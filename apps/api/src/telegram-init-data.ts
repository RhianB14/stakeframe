import { createHmac, timingSafeEqual } from 'node:crypto';

// STK-G0-19-R5 — validação server-side do Telegram.WebApp.initData.
// Especificação: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret_key = HMAC_SHA256(<bot_token>, "WebAppData")
//   hash = HMAC_SHA256(data_check_string, secret_key)
// O initData nunca é registrado em log; apenas o resultado da validação.

export type TelegramInitDataUser = { id: number; first_name?: string; username?: string };

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
  maxAgeSeconds = 24 * 60 * 60,
): { user: TelegramInitDataUser; authDate: number } | null {
  if (!initData || initData.length > 8_192 || !botToken) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const pairs: string[] = [];
  for (const [key, value] of [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  try {
    if (!timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'))) return null;
  } catch {
    return null;
  }
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0 || now / 1_000 - authDate > maxAgeSeconds)
    return null;
  const userRaw = params.get('user');
  if (!userRaw || userRaw.length > 2_048) return null;
  try {
    const parsed: unknown = JSON.parse(userRaw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { id?: unknown }).id !== 'number' ||
      !Number.isSafeInteger((parsed as { id: number }).id)
    )
      return null;
    const user = parsed as TelegramInitDataUser;
    return {
      user: {
        id: user.id,
        ...(user.first_name ? { first_name: user.first_name } : {}),
        ...(user.username ? { username: user.username } : {}),
      },
      authDate,
    };
  } catch {
    return null;
  }
}
