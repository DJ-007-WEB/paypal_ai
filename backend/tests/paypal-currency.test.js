'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPayPalService,
  isSupportedPayPalCurrency,
} = require('../src/services/paypal.service');

test('PayPal Checkout currency allowlist includes common supported currencies', () => {
  for (const currency of ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD']) {
    assert.equal(isSupportedPayPalCurrency(currency), true, currency);
  }
});

test('PayPal Checkout rejects INR before making a provider request', async () => {
  const service = createPayPalService({
    config: {
      PAYPAL_ENABLED: true,
      PAYPAL_CLIENT_ID: 'sandbox-client-id',
      PAYPAL_RETURN_URL: 'https://example.test/return',
      PAYPAL_CANCEL_URL: 'https://example.test/cancel',
      getSecrets: () => ({ PAYPAL_CLIENT_SECRET: 'sandbox-client-secret' }),
    },
  });

  await assert.rejects(
    service.createOrder({
      amountMinor: 1611800,
      currency: 'INR',
      purchaseId: 'purchase-test',
      tenantId: 'tenant-test',
    }),
    (error) => {
      assert.equal(error.code, 'PAYPAL_CURRENCY_NOT_SUPPORTED');
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /does not support INR/i);
      return true;
    },
  );
});
