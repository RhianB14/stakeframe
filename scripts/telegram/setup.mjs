import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizedMessage, matchEnrollment, validateIdentity } from './owner.mjs';

const expectedUsername = 'stakeframe_rhian_bot';
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const [mode, privatePath, ...extra] = process.argv.slice(2);

async function main() {
  if (
    !['check', 'prepare', 'bind', 'probe'].includes(mode) ||
    extra.length ||
    !isAbsolute(privatePath ?? '')
  ) {
    throw new Error('TELEGRAM_SETUP_USAGE');
  }
  const directoryInfo = await lstat(privatePath);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('TELEGRAM_PRIVATE_DIRECTORY_REQUIRED');
  }
  const directory = await realpath(privatePath);
  const relativePath = relative(await realpath(workspace), directory);
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) {
    throw new Error('TELEGRAM_DIRECTORY_MUST_BE_OUTSIDE_WORKSPACE');
  }
  // Reject symlinked ancestors too. Windows comparison tolerates case only.
  const canonical = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  if (canonical(resolve(privatePath)) !== canonical(directory)) {
    throw new Error('TELEGRAM_DIRECTORY_ALIAS_REFUSED');
  }
  if (process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0) {
    throw new Error('TELEGRAM_PRIVATE_PERMISSIONS_REQUIRED');
  }
  async function readPrivate(name) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 4096 ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    ) {
      throw new Error('TELEGRAM_PRIVATE_FILE_INVALID');
    }
    return readFile(path, 'utf8');
  }
  async function createPrivate(name, value) {
    await writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const token = (await readPrivate('bot_token')).replace(/\r?\n$/, '');
  if (!/^\d{6,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) throw new Error('TELEGRAM_TOKEN_INVALID');
  const metadata = JSON.parse(await readPrivate('metadata.json'));
  if (metadata.botUsername !== expectedUsername || metadata.continuousConsumerEnabled !== false) {
    throw new Error('TELEGRAM_SETUP_METADATA_INVALID');
  }
  async function api(method, body = {}) {
    // No arbitrary URL or method is accepted from arguments or files. Never log token-bearing errors.
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('TELEGRAM_API_REQUEST_FAILED');
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_048_576) throw new Error('TELEGRAM_RESPONSE_TOO_LARGE');
    const payload = JSON.parse(text);
    if (payload.ok !== true) throw new Error('TELEGRAM_API_RESULT_FAILED');
    return payload.result;
  }
  const bot = await api('getMe');
  if (
    bot.is_bot !== true ||
    bot.username !== expectedUsername ||
    String(bot.id) !== token.split(':')[0] ||
    bot.can_join_groups !== false ||
    bot.can_read_all_group_messages === true ||
    bot.supports_inline_queries === true
  ) {
    throw new Error('TELEGRAM_BOT_SETTINGS_REFUSED');
  }
  const webhook = await api('getWebhookInfo');
  if (webhook.url !== '') throw new Error('TELEGRAM_EXISTING_WEBHOOK_REFUSED');
  if (mode === 'check') {
    console.log('TELEGRAM_BOT_SETTINGS_VERIFIED');
    return;
  }
  if (mode === 'prepare') {
    try {
      await lstat(join(directory, 'owner.json'));
      throw new Error('TELEGRAM_ALREADY_BOUND');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const createdAt = Date.now();
    await createPrivate('challenge.json', {
      nonce: randomBytes(32).toString('hex'),
      createdAt,
      expiresAt: createdAt + 600_000,
    });
    console.log('TELEGRAM_CHALLENGE_READY');
    return;
  }
  if (mode === 'bind') {
    const challenge = JSON.parse(await readPrivate('challenge.json'));
    const updates = await api('getUpdates', {
      timeout: 0,
      limit: 100,
      allowed_updates: ['message'],
    });
    const identity = matchEnrollment(updates, challenge);
    await createPrivate('owner.json', {
      ...identity,
      verifiedAt: new Date().toISOString(),
      proof: 'owner-session-one-time-start',
    });
    await unlink(join(directory, 'challenge.json'));
    console.log('TELEGRAM_PRIVATE_OWNER_BOUND');
    return;
  }
  const identity = validateIdentity(JSON.parse(await readPrivate('owner.json')));
  // Reserve the single test before sending. An ambiguous network outcome requires manual inspection.
  await createPrivate('probe-intent.json', { startedAt: new Date().toISOString() });
  const message = await api('sendMessage', {
    chat_id: identity.chatId,
    text: 'Conexão confirmada. Este bot está em preparação; o registro de apostas ainda não está disponível.',
    disable_notification: true,
  });
  if (
    String(message.chat?.id) !== identity.chatId ||
    message.chat?.type !== 'private' ||
    !Number.isSafeInteger(message.message_id)
  ) {
    throw new Error('TELEGRAM_PROBE_RESULT_INVALID');
  }
  // Exercise the exact gate used by this preparatory probe, without publishing identity values.
  const accepted = {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(identity.chatId), type: 'private' },
      from: { id: Number(identity.userId), is_bot: false },
    },
  };
  const refused = structuredClone(accepted);
  refused.message.chat.id += 1;
  refused.message.from.id += 1;
  if (!authorizedMessage(accepted, identity) || authorizedMessage(refused, identity)) {
    throw new Error('TELEGRAM_IDENTITY_GATE_FAILED');
  }
  await createPrivate('result.json', {
    completedAt: new Date().toISOString(),
    botSettingsVerified: true,
    privateOwnerBound: true,
    ownerResponseSent: true,
    identityGateVerified: true,
    continuousConsumerEnabled: false,
  });
  console.log('TELEGRAM_PRIVATE_PROBE_PASS');
}

main().catch((error) => {
  // Fetch errors can include the credential-bearing URL; never emit the original error.
  const reason = /^TELEGRAM_[A-Z_]+$/.test(error?.message ?? '')
    ? error.message
    : 'TELEGRAM_SETUP_FAILED';
  console.error(reason);
  process.exitCode = 1;
});
