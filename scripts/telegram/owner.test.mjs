import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizedMessage, matchEnrollment, validateIdentity } from './owner.mjs';

const identity = { userId: '12345', chatId: '12345' };
const now = 1_800_000_000_000;
const challenge = { nonce: 'ab'.repeat(32), createdAt: now, expiresAt: now + 600_000 };
const update = () => ({
  update_id: 7,
  message: {
    message_id: 12,
    date: now / 1000,
    from: { id: 12345, is_bot: false },
    chat: { id: 12345, type: 'private' },
    text: `/start ${challenge.nonce}`,
  },
});

test('accepts exact private owner and rejects another identity even with the same name', () => {
  assert.ok(authorizedMessage(update(), identity));
  const other = update();
  other.message.from = { id: 12346, is_bot: false, username: 'owner' };
  other.message.chat.id = 12346;
  assert.equal(authorizedMessage(other, identity), null);
});

test('rejects groups, channels, bots, proxy senders, forwarded and business messages', () => {
  for (const change of [
    (m) => (m.chat.type = 'group'),
    (m) => (m.chat.type = 'supergroup'),
    (m) => (m.chat.type = 'channel'),
    (m) => (m.from.is_bot = true),
    (m) => delete m.from.is_bot,
    (m) => (m.chat.id = 99999),
    (m) => (m.sender_chat = {}),
    (m) => (m.via_bot = {}),
    (m) => (m.forward_origin = {}),
    (m) => (m.business_connection_id = 'business'),
  ]) {
    const changed = update();
    change(changed.message);
    assert.equal(authorizedMessage(changed, identity), null);
  }
});

test('rejects callback, edit and channel updates instead of authorizing their nested sender', () => {
  for (const kind of ['edited_message', 'channel_post', 'callback_query', 'business_message']) {
    assert.equal(authorizedMessage({ update_id: 7, [kind]: update().message }, identity), null);
  }
});

test('rejects malformed IDs and incomplete saved identity', () => {
  for (const id of [null, '12345', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const changed = update();
    changed.message.from.id = id;
    assert.equal(authorizedMessage(changed, identity), null);
  }
  for (const id of ['', '012345', '1e4', '-1', '9007199254740992', 12345]) {
    assert.throws(() => validateIdentity({ userId: id, chatId: id }));
  }
  assert.throws(() => validateIdentity(null));
  assert.throws(() => validateIdentity({ userId: '12345', chatId: '12346' }));
});

test('enrollment requires the exact one-time challenge, never just the first message', () => {
  const generic = update();
  generic.message.text = '/start';
  const wrong = update();
  wrong.message.text = `/start ${'cd'.repeat(32)}`;
  assert.deepEqual(matchEnrollment([generic, wrong, update()], challenge, now), identity);
  assert.throws(() => matchEnrollment([generic, wrong], challenge, now));
  assert.throws(() => matchEnrollment([update(), update()], challenge, now));
});

test('enrollment refuses stale, future and expired challenges/messages', () => {
  assert.throws(() => matchEnrollment([update()], challenge, challenge.expiresAt + 1));
  assert.throws(() => matchEnrollment([update()], challenge, now - 1));
  const stale = update();
  stale.message.date -= 1;
  assert.throws(() => matchEnrollment([stale], challenge, now));
  const future = update();
  future.message.date += 31;
  assert.throws(() => matchEnrollment([future], challenge, now));
  const forwarded = update();
  forwarded.message.forward_origin = {};
  assert.throws(() => matchEnrollment([forwarded], challenge, now));
});
