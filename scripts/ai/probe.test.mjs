import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequest, expected, probe, verifyExtraction } from './probe.mjs';

const png = await readFile(
  new URL('../../tests/fixtures/ai/synthetic-ticket.png', import.meta.url),
);
const apiKey = 'fictitious-key-for-offline-tests-only';
const model = 'gemini-3.5-flash-lite';
const payload = (value = expected) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});

test('probe sends the fixed image and schema to Google, without expected values or key in URL', async () => {
  let calls = 0;
  const result = await probe({
    apiKey,
    model,
    png,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(
        url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      );
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-goog-api-key'], apiKey);
      const request = JSON.parse(options.body);
      assert.equal(request.contents[0].parts[0].inlineData.data, png.toString('base64'));
      assert.equal(request.generationConfig.responseMimeType, 'application/json');
      assert.equal(request.generationConfig.maxOutputTokens, 2048);
      assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
      assert.ok(!request.contents[0].parts[1].text.includes(expected.odds));
      assert.ok(!options.body.includes(apiKey));
      return Response.json(payload());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.passed, true);
  assert.equal(result.tokenCounts.totalTokenCount, null);
});

test('different image or unapproved model is refused before network', async () => {
  const fetchImpl = () => assert.fail('network must not run');
  await assert.rejects(probe({ apiKey, model: 'other', png, fetchImpl }), /AI_MODEL_REFUSED/);
  await assert.rejects(
    probe({ apiKey, model, png: Buffer.from('private image'), fetchImpl }),
    /AI_SYNTHETIC_FIXTURE_REQUIRED/,
  );
  assert.throws(() => createRequest(model, null), /AI_SYNTHETIC_FIXTURE_REQUIRED/);
});

test('schema and semantic errors cannot pass, including numeric money and invented date', () => {
  assert.throws(
    () => verifyExtraction(payload({ ...expected, extra: 'field' })),
    /AI_SCHEMA_MISMATCH/,
  );
  for (const changes of [
    { stake: 20 },
    { odds: '1.58' },
    { date: '2026-09-06' },
    { selection: null },
  ]) {
    assert.equal(verifyExtraction(payload({ ...expected, ...changes })).passed, false);
  }
  const incomplete = payload();
  incomplete.candidates[0].finishReason = 'MAX_TOKENS';
  assert.throws(() => verifyExtraction(incomplete), /AI_INCOMPLETE_OR_BLOCKED/);
  assert.throws(
    () => verifyExtraction({ promptFeedback: { blockReason: 'SAFETY' } }),
    /AI_INCOMPLETE_OR_BLOCKED/,
  );
});

test('429 stops after one call and neither follows redirects nor exposes error body', async () => {
  let calls = 0;
  await assert.rejects(
    probe({
      apiKey,
      model,
      png,
      fetchImpl: async () => {
        calls++;
        return new Response('private provider diagnostics', { status: 429 });
      },
    }),
    /^ProbeError: AI_RATE_LIMITED$/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    probe({
      apiKey,
      model,
      png,
      fetchImpl: async () => {
        throw new Error(`fetch failed with ${apiKey}`);
      },
    }),
    /^ProbeError: AI_TRANSPORT_FAILED$/,
  );
});

test('oversized and malformed responses are refused', async () => {
  await assert.rejects(
    probe({ apiKey, model, png, fetchImpl: async () => new Response('a'.repeat(131073)) }),
    /AI_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    probe({ apiKey, model, png, fetchImpl: async () => new Response('not JSON') }),
    /AI_RESPONSE_INVALID/,
  );
});

test('503 diagnostics expose only HTTP status and an allowlist, never provider messages', async () => {
  await assert.rejects(
    probe({
      apiKey,
      model,
      png,
      fetchImpl: async () =>
        Response.json(
          {
            error: {
              status: 'UNAVAILABLE',
              message: `Backend failed for ${apiKey}; unrelated private detail`,
            },
          },
          { status: 503 },
        ),
    }),
    (error) => {
      assert.equal(error.message, 'AI_HTTP_FAILED');
      assert.deepEqual(error.details, { httpStatus: 503, apiStatus: 'UNAVAILABLE', fields: [] });
      assert.ok(!JSON.stringify(error).includes(apiKey));
      return true;
    },
  );
});
