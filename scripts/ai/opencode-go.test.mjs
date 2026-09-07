import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { expected } from './probe.mjs';
import { goModel, probeGo } from './opencode-go.mjs';

const png = await readFile(
  new URL('../../tests/fixtures/ai/synthetic-ticket.png', import.meta.url),
);
const apiKey = 'sk-fictitious-opencode-test-key-only';
const payload = (finish = 'stop') => ({
  choices: [
    { finish_reason: finish, message: { content: JSON.stringify(expected), tool_calls: [] } },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
});

test('Go probe uses the subscription endpoint, truthful identity and exact synthetic fixture', async () => {
  let calls = 0;
  const result = await probeGo({
    apiKey,
    png,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://opencode.ai/zen/go/v1/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
      assert.match(options.headers['user-agent'], /^Stakeframe-M0-ModelProbe\//);
      assert.match(options.headers['x-opencode-session'], /^[a-f0-9-]{36}$/);
      const body = JSON.parse(options.body);
      assert.equal(body.model, goModel);
      assert.equal(body.max_tokens, 2048);
      assert.equal(
        body.messages[0].content[0].image_url.url,
        `data:image/png;base64,${png.toString('base64')}`,
      );
      assert.equal(body.response_format.type, 'json_object');
      assert.ok(!body.messages[0].content[1].text.includes(expected.odds));
      assert.ok(!options.body.includes(apiKey));
      return Response.json(payload());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.passed, true);
  assert.equal(result.tokenCounts.totalTokenCount, 180);
});

test('Go refuses real or substituted images before sending anything', async () => {
  await assert.rejects(
    probeGo({
      apiKey,
      png: Buffer.from('different image'),
      fetchImpl: () => assert.fail('no network'),
    }),
    { message: 'AI_SYNTHETIC_FIXTURE_REQUIRED' },
  );
});

test('Go refuses truncated responses even if their JSON happens to be valid', async () => {
  await assert.rejects(
    probeGo({ apiKey, png, fetchImpl: async () => Response.json(payload('length')) }),
    { message: 'AI_INCOMPLETE_OR_BLOCKED' },
  );
});

test('Go never retries a quota refusal or leaks the provider error', async () => {
  let calls = 0;
  await assert.rejects(
    probeGo({
      apiKey,
      png,
      fetchImpl: async () => {
        calls++;
        return Response.json({ error: { message: apiKey } }, { status: 429 });
      },
    }),
    (error) => {
      assert.equal(error.message, 'AI_RATE_LIMITED');
      assert.deepEqual(error.details, { httpStatus: 429 });
      assert.ok(!JSON.stringify(error).includes(apiKey));
      return true;
    },
  );
  assert.equal(calls, 1);
});
