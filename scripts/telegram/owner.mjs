// Authorization boundary for the isolated M0 probe; no continuous consumer is enabled.
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const savedId = (value) =>
  typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && positiveId(Number(value));

export function validateIdentity(identity) {
  if (
    !identity ||
    !savedId(identity.userId) ||
    !savedId(identity.chatId) ||
    identity.userId !== identity.chatId
  ) {
    throw new Error('TELEGRAM_IDENTITY_INVALID');
  }
  return { userId: identity.userId, chatId: identity.chatId };
}

export function privateMessage(update) {
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return null;
  const message = update.message;
  if (
    !message ||
    !positiveId(message.message_id) ||
    !positiveId(message.date) ||
    message.chat?.type !== 'private' ||
    !positiveId(message.chat.id) ||
    !positiveId(message.from?.id) ||
    message.from.is_bot !== false ||
    message.chat.id !== message.from.id ||
    message.sender_chat ||
    message.business_connection_id ||
    message.via_bot ||
    message.forward_origin
  ) {
    return null;
  }
  return message;
}

export function authorizedMessage(update, identity) {
  const owner = validateIdentity(identity);
  const message = privateMessage(update);
  return message &&
    String(message.chat.id) === owner.chatId &&
    String(message.from.id) === owner.userId
    ? message
    : null;
}

export function matchEnrollment(updates, challenge, now = Date.now()) {
  if (
    !Array.isArray(updates) ||
    !challenge ||
    !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
    !Number.isSafeInteger(challenge.createdAt) ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt - challenge.createdAt !== 600_000 ||
    now < challenge.createdAt ||
    now > challenge.expiresAt
  ) {
    throw new Error('TELEGRAM_CHALLENGE_INVALID');
  }
  const matches = updates.filter((update) => {
    const message = privateMessage(update);
    return (
      message &&
      message.text === `/start ${challenge.nonce}` &&
      message.date >= Math.floor(challenge.createdAt / 1000) &&
      message.date <= Math.floor(now / 1000) + 30
    );
  });
  if (matches.length !== 1) throw new Error('TELEGRAM_CHALLENGE_MATCH_REQUIRED');
  const message = matches[0].message;
  return validateIdentity({ userId: String(message.from.id), chatId: String(message.chat.id) });
}
