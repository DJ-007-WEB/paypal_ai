'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiService } = require('../src/services/ai.service');

const validJson = JSON.stringify({
  productId: 'BRG-6204',
  quantity: 3,
  budgetMajor: 1200,
  currency: 'INR',
  maxDeliveryDays: 5,
  minQualityScore: null,
  minReliabilityScore: null,
  requireApprovedVendor: true,
  warnings: [],
  interpretation: 'Three units within the stated budget.',
});

function config(overrides = {}) {
  return {
    AI_ENABLED: true,
    AI_API_KEY: 'test-api-key',
    AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    AI_MODEL: 'gemini-3.8-flash',
    AI_TIMEOUT_MS: 20000,
    AI_MAX_INPUT_CHARS: 4000,
    ...overrides,
  };
}

test('Gemini 3.8 requests omit unsupported sampling parameters', async () => {
  let sent;
  const service = createAiService({
    config: config(),
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: validJson } }] };
        },
      };
    },
  });

  const result = await service.parsePurchaseRequest({ text: 'Need 3 BRG-6204, budget INR 1200, delivery within 5 days.' });
  assert.equal(result.source, 'ai');
  assert.equal(sent.model, 'gemini-3.8-flash');
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(Object.hasOwn(sent, 'temperature'), false);
  assert.deepEqual(sent.response_format, { type: 'json_object' });
});

test('OpenAI-compatible non-Gemini providers retain deterministic temperature', async () => {
  let sent;
  const service = createAiService({
    config: config({
      AI_BASE_URL: 'https://api.openai.com/v1',
      AI_MODEL: 'gpt-test',
    }),
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: validJson } }] };
        },
      };
    },
  });

  await service.parsePurchaseRequest({ text: 'Need 3 BRG-6204, budget INR 1200, delivery within 5 days.' });
  assert.equal(sent.temperature, 0);
  assert.equal(Object.hasOwn(sent, 'reasoning_effort'), false);
});

test('AI provider failures retain safe HTTP diagnostics for server logs', async () => {
  const service = createAiService({
    config: config(),
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async clone() {
        return {
          async json() {
            return { error: { code: 400, status: 'INVALID_ARGUMENT' } };
          },
        };
      },
    }),
  });

  await assert.rejects(
    service.parsePurchaseRequest({ text: 'Need 3 BRG-6204.' }),
    (error) => {
      assert.equal(error.code, 'AI_PROVIDER_ERROR');
      assert.equal(error.statusCode, 502);
      assert.equal(error.providerStatus, 400);
      assert.equal(error.providerCode, '400');
      assert.equal(error.providerStatusText, 'INVALID_ARGUMENT');
      return true;
    },
  );
});
