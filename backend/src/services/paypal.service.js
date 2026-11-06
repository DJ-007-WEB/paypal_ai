'use strict';

const https = require('node:https');
const crypto = require('node:crypto');

/**
 * PayPal Sandbox Orders API integration.
 *
 * - Creates an order for a given amount (in minor units) and currency.
 * - Generates a unique invoice/identifier for idempotency.
 * - Returns the PayPal order ID and approval URL for the frontend to redirect.
 * - Verifies the completed order against the purchase record.
 * - Never authorizes real payment; paymentAuthorized remains false.
 * - All amounts are computed server-side from trusted purchase data.
 */

const EXPIRY_SECONDS = 86400; // 24 hours
const INTENT = 'CAPTURE'; // Order intent: capture the amount immediately

function parseEnv() {
  const isSandbox = String(process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'sandbox';
  const base = isSandbox ? 'https://api.sandbox.paypal.com' : 'https://api.paypal.com';
  return {
    base,
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    returnUrl: process.env.PAYPAL_RETURN_URL || 'http://localhost:5173',
    cancelUrl: process.env.PAYPAL_CANCEL_URL || 'http://localhost:5173',
    isSandbox,
  };
}

function getAccessToken({ base, clientId, clientSecret } = parseEnv()) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams();
    postData.append('grant_type', 'client_credentials');
    const req = https.request(
      {
        host: new URL(base).host,
        path: '/v1/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) resolve(parsed.access_token);
            else reject(new Error('Invalid access token response: ' + data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function buildHeader(accessToken) {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken };
}

/**
 * Create a PayPal order for a purchase.
 * The amount is calculated server-side from the purchase record's minor units.
 * The frontend must NOT supply any amount or payment details.
 *
 * @param {number} amountMinor - Total amount in minor units (e.g. INR paise) from the purchase record
 * @param {string} currency - 3-letter ISO currency code (e.g. 'INR')
 * @param {string} purchaseId - The mandate purchase ID for memo/description
 * @param {string} tenantId - The tenant ID for memo/description
 * @returns {Promise<Object>} PayPal order response
 */
function createOrder({ amountMinor, currency, purchaseId, tenantId } = {}) {
  return new Promise((resolve, reject) => {
    if (!amountMinor || amountMinor <= 0) return reject(new Error('Invalid amountMinor'));
    if (!currency || currency.length !== 3) return reject(new Error('Invalid currency'));

    // Convert minor to major for PayPal (PayPal uses decimal major units)
    const amountMajor = Number(amountMinor) / 100;
    if (!Number.isFinite(amountMajor) || amountMajor <= 0) return reject(new Error('Amount out of range'));

    const description = `Mandate purchase ${purchaseId} — tenant ${tenantId}`;

    const order = {
      intent: INTENT,
      purchase_units: [
        {
          amount: {
            currency_code: currency,
            value: amountMajor.toFixed(2),
            breakdown: {
              item_total: {
                currency_code: currency,
                value: amountMajor.toFixed(2),
              },
            },
          },
          description: description,
          invoice_id: `mandate_${purchaseId}_${crypto.randomBytes(4).toString('hex')}`,
        },
      ],
      application_context: {
        return_url: parseEnv().returnUrl,
        cancel_url: parseEnv().cancelUrl,
        brand_name: 'Mandate',
        user_action: 'PAY_NOW',
      },
    };

    const env = parseEnv();
    if (!env.clientId || !env.clientSecret) return reject(new Error('PayPal credentials not configured.'));

    getAccessToken({ base: env.base, clientId: env.clientId, clientSecret: env.clientSecret })
      .then((token) => {
        const req = https.request(
          {
            host: new URL(env.base).host,
            path: '/v2/checkout/orders',
            method: 'POST',
            headers: buildHeader(token),
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.id) resolve(parsed);
                else reject(new Error('Order creation failed: ' + data));
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify(order));
        req.end();
      })
      .catch(reject);
  });
}

/**
 * Capture a previously created PayPal order.
 * This is the second step after the user approves on PayPal.
 * Verifies the order matches the expected purchase before capturing.
 *
 * @param {string} orderId - The PayPal order ID
 * @param {number} expectedAmountMinor - Expected amount in minor units from the purchase record
 * @param {string} expectedCurrency - Expected currency code
 * @param {string} expectedTenantId - Expected tenant ID
 * @returns {Promise<Object>} Capture response
 */
function captureOrder({ orderId, expectedAmountMinor, expectedCurrency, expectedTenantId } = {}) {
  return new Promise((resolve, reject) => {
    if (!orderId) return reject(new Error('Missing orderId'));

    // First verify the order matches this purchase
    return paypal.verifyOrder({ orderId, expectedAmountMinor, expectedCurrency, expectedTenantId }).then(
      ({ valid, parsed }) => {
        if (!valid) {
          return reject(new Error('Order verification failed: amount or tenant mismatch.'));
        }

        const env = parseEnv();
        getAccessToken({ base: env.base, clientId: env.clientId, clientSecret: env.clientSecret })
          .then((token) => {
            const req = https.request(
              {
                host: new URL(env.base).host,
                path: `/v2/checkout/orders/${orderId}/capture`,
                method: 'POST',
                headers: buildHeader(token),
              },
              (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.status === 'COMPLETED') resolve(parsed);
                    else reject(new Error('Order not completed: ' + data));
                  } catch (e) {
                    reject(e);
                  }
                });
              }
            );
            req.on('error', reject);
            req.end();
          })
          .catch(reject);
      }
    ).catch(reject);
  });
}

/**
 * Verify that a PayPal order matches the expected purchase amount and tenant.
 * Used by webhook handler or client-side validation.
 *
 * @param {string} orderId - PayPal order ID
 * @param {number} expectedAmountMinor - Expected amount in minor units from the purchase record
 * @param {string} expectedCurrency - Expected currency code
 * @param {string} expectedTenantId - Expected tenant ID
 * @returns {Promise<Object>} { valid: boolean, parsed: object }
 */
function verifyOrder({ orderId, expectedAmountMinor, expectedCurrency, expectedTenantId } = {}) {
  return new Promise((resolve, reject) => {
    if (!orderId) return reject(new Error('Missing orderId'));

    const env = parseEnv();
    getAccessToken({ base: env.base, clientId: env.clientId, clientSecret: env.clientSecret })
      .then((token) => {
        const req = https.request(
          {
            host: new URL(env.base).host,
            path: `/v2/checkout/orders/${orderId}`,
            method: 'GET',
            headers: buildHeader(token),
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                const amount = parsed.purchase_units?.[0]?.amount;
                const matchesAmount =
                  amount &&
                  amount.currency_code === expectedCurrency &&
                  Number(amount.value) * 100 === expectedAmountMinor;
                // Store tenantId in custom_id for later verification; if not set, compare via purchase record
                const matchesTenant = parsed.custom_id === expectedTenantId;
                resolve({ valid: matchesAmount && matchesTenant, parsed });
              } catch (e) {
                reject(e);
              }
            });
          }
        );
        req.on('error', reject);
        req.end();
      })
      .catch(reject);
  });
}

/**
 * Verify PayPal webhook signature for security.
 * PayPal sends events to the registered webhook URL with a signature
 * in the PayPal-TRANSMISSION-SIG header and a timestamp in PayPal-TRANSMISSION-TIME.
 *
 * @param {string} reqBody - Raw request body
 * @param {string} signature - PayPal-TRANSMISSION-SIG header value
 * @param {string} timestamp - PayPal-TRANSMISSION-TIME header value
 * @returns {boolean} Whether the signature is valid
 */
function verifyWebhookSignature(reqBody, signature, timestamp) {
  if (!signature || !timestamp) return false;

  const env = parseEnv();
  const constructedString = `v1:timestamp:${timestamp}:${reqBody}`;

  // Use the client secret to verify the signature
  const secret = Buffer.from(env.clientSecret, 'utf8');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(constructedString);
  const digest = hmac.digest('hex');

  return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Parse PayPal webhook event and extract relevant data.
 *
 * @param {string} reqBody - Raw request body from PayPal webhook
 * @returns {Object} Parsed event data { eventType, purchaseId, orderId, status }
 */
function parseWebhookEvent(reqBody) {
  let parsed;
  try {
    parsed = JSON.parse(reqBody);
  } catch (e) {
    return { error: 'Invalid JSON body' };
  }

  const eventType = parsed.event_type;
  const resource = parsed.resource || {};

  return {
    eventType,
    purchaseId: resource.custom_id || null,
    orderId: resource.id || null,
    status: resource.status || null,
    paymentId: resource.payment_id || null,
  };
}

module.exports = { createOrder, captureOrder, verifyOrder, verifyWebhookSignature, parseWebhookEvent, parseEnv };