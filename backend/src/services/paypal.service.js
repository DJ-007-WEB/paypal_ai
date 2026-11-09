'use strict';

/**
 * PayPal Orders v2 / Payments API client (Sandbox only).
 *
 * Security properties:
 * - Live PayPal is rejected by configuration; this module never falls back live.
 * - Amounts are computed server-side in minor units and converted using the
 *   currency's ISO exponent (no unconditional /100).
 * - `custom_id` carries the purchaseId; `invoice_id` carries tenant+purchase
 *   correlation. Webhook events are correlated only through these fields plus
 *   a server-side order lookup, never through client-supplied values.
 * - Webhook signatures are verified with PayPal's official
 *   /v1/notifications/verify-webhook-signature endpoint, not a home-grown HMAC.
 * - No credentials or provider payloads are logged.
 */

const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_SAFETY_WINDOW_MS = 60 * 1000;

// ISO 4217 exponents used by PayPal. Default is 2.
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD', 'KRW']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

function currencyExponent(currency) {
  const code = String(currency || '').toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

function toPayPalAmount(amountMinor, currency) {
  const n = Number(amountMinor);
  if (!Number.isSafeInteger(n) || n <= 0) throw paypalError('INVALID_AMOUNT', 'Amount must be a positive integer in minor units.', 400);
  const exponent = currencyExponent(currency);
  const value = exponent === 0 ? String(n) : (n / (10 ** exponent)).toFixed(exponent);
  return { currency_code: String(currency || '').toUpperCase(), value };
}

function fromPayPalAmount(value, currency) {
  const exponent = currencyExponent(currency);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return NaN;
  return Math.round(numeric * (10 ** exponent));
}

function paypalError(code, message, statusCode = 502, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function invoiceIdFor(tenantId, purchaseId) {
  return `mandate_${tenantId}_${purchaseId}`.slice(0, 127);
}

function createPayPalService({ config } = {}) {
  if (!config) throw new Error('PayPal service requires config.');

  const secrets = config.getSecrets ? config.getSecrets() : {};
  const clientId = config.PAYPAL_CLIENT_ID || '';
  const clientSecret = secrets.PAYPAL_CLIENT_SECRET || '';
  const enabled = Boolean(config.PAYPAL_ENABLED && clientId && clientSecret);
  const base = PAYPAL_SANDBOX_BASE;

  let tokenCache = { token: null, expiresAt: 0 };

  function isEnabled() { return enabled; }

  function requireEnabled() {
    if (!enabled) {
      throw paypalError('PAYPAL_NOT_CONFIGURED', 'PayPal Sandbox is not configured for this deployment.', 503);
    }
  }

  async function fetchJson(path, { method = 'GET', body, headers = {}, requestId } = {}) {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw paypalError('PAYPAL_UNAVAILABLE', 'Could not reach PayPal Sandbox. Please retry.', 502);
    }

    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!response.ok) {
      const issue = parsed?.details?.[0]?.issue || parsed?.name || 'PAYPAL_REQUEST_FAILED';
      const debugId = parsed?.debug_id || parsed?.debugId || null;
      // Log only safe provider diagnostics; never log credentials, tokens, or full payloads.
      console.error(`[PAYPAL] request failed requestId=${requestId || 'none'} method=${method} path=${path} status=${response.status} issue=${String(issue).slice(0, 100)} debugId=${debugId || 'none'}`);
      throw paypalError('PAYPAL_REQUEST_FAILED', 'PayPal rejected the request.', 502, {
        providerStatus: response.status,
        providerIssue: issue,
        providerDebugId: debugId,
        requestId: requestId || null,
      });
    }
    return parsed || {};
  }

  async function getAccessToken() {
    requireEnabled();
    if (tokenCache.token && tokenCache.expiresAt > Date.now() + TOKEN_SAFETY_WINDOW_MS) return tokenCache.token;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    let response;
    try {
      response = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw paypalError('PAYPAL_UNAVAILABLE', 'Could not reach PayPal Sandbox. Please retry.', 502);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok || !data?.access_token) {
      throw paypalError('PAYPAL_AUTH_FAILED', 'PayPal Sandbox authentication failed.', 502);
    }
    const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 300;
    tokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return tokenCache.token;
  }

  async function authHeaders(extra = {}) {
    const token = await getAccessToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
  }

  async function createOrder({ amountMinor, currency, purchaseId, tenantId, requestId } = {}) {
    requireEnabled();
    if (!purchaseId || !tenantId) throw paypalError('INVALID_ORDER', 'purchaseId and tenantId are required.', 400);
    const amount = toPayPalAmount(amountMinor, currency);
    const order = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          // This is a single approved grand total (including shipping/tax/fees),
          // not an itemized cart. Do not send an item_total breakdown without items.
          amount: {
            currency_code: amount.currency_code,
            value: amount.value,
          },
          description: `Mandate purchase ${purchaseId}`.slice(0, 127),
          custom_id: String(purchaseId).slice(0, 127),
          invoice_id: invoiceIdFor(tenantId, purchaseId),
        },
      ],
      application_context: {
        return_url: config.PAYPAL_RETURN_URL,
        cancel_url: config.PAYPAL_CANCEL_URL,
        brand_name: 'Mandate',
        user_action: 'PAY_NOW',
      },
    };
    const data = await fetchJson('/v2/checkout/orders', {
      method: 'POST',
      headers: await authHeaders({ 'PayPal-Request-Id': `create-${invoiceIdFor(tenantId, purchaseId)}`.slice(0, 100) }),
      body: order,
      requestId,
    });
    if (!data.id) throw paypalError('PAYPAL_ORDER_INVALID', 'PayPal did not return an order ID.', 502);
    return data;
  }

  async function getOrder(orderId) {
    requireEnabled();
    if (!orderId) throw paypalError('INVALID_ORDER', 'orderId is required.', 400);
    return fetchJson(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: await authHeaders(),
    });
  }

  function verifyOrderShape({ order, expectedAmountMinor, expectedCurrency, expectedPurchaseId, expectedTenantId }) {
    const unit = order?.purchase_units?.[0];
    const amount = unit?.amount;
    const reasons = [];

    if (!unit || !amount) reasons.push('missing_purchase_unit');
    if (expectedPurchaseId && String(unit?.custom_id || '') !== String(expectedPurchaseId)) reasons.push('purchase_mismatch');
    if (expectedTenantId && String(unit?.invoice_id || '') !== invoiceIdFor(expectedTenantId, expectedPurchaseId)) reasons.push('tenant_mismatch');
    if (expectedCurrency && String(amount?.currency_code || '').toUpperCase() !== String(expectedCurrency).toUpperCase()) reasons.push('currency_mismatch');
    if (expectedAmountMinor !== undefined && fromPayPalAmount(amount?.value, expectedCurrency || amount?.currency_code) !== Number(expectedAmountMinor)) {
      reasons.push('amount_mismatch');
    }

    return {
      valid: reasons.length === 0,
      reasons,
      amountMinor: fromPayPalAmount(amount?.value, amount?.currency_code),
      currency: amount?.currency_code || null,
      orderId: order?.id || null,
      status: order?.status || null,
    };
  }

  async function verifyOrder({ orderId, expectedAmountMinor, expectedCurrency, expectedPurchaseId, expectedTenantId } = {}) {
    requireEnabled();
    const order = await getOrder(orderId);
    const result = verifyOrderShape({ order, expectedAmountMinor, expectedCurrency, expectedPurchaseId, expectedTenantId });
    return { ...result, order };
  }

  async function captureOrder({ orderId, expectedAmountMinor, expectedCurrency, expectedPurchaseId, expectedTenantId } = {}) {
    requireEnabled();
    if (!orderId) throw paypalError('INVALID_ORDER', 'orderId is required.', 400);

    const verification = await verifyOrder({ orderId, expectedAmountMinor, expectedCurrency, expectedPurchaseId, expectedTenantId });
    if (!verification.valid) {
      throw paypalError('ORDER_MISMATCH', 'PayPal order does not match this purchase.', 400, { details: verification.reasons });
    }
    if (verification.status === 'COMPLETED') {
      return {
        status: 'COMPLETED',
        order: verification.order,
        amountMinor: verification.amountMinor,
        currency: verification.currency,
        captureId: null,
        alreadyCaptured: true,
      };
    }

    let data;
    try {
      data = await fetchJson(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: await authHeaders({ 'PayPal-Request-Id': `capture-${orderId}`.slice(0, 100) }),
        body: {},
      });
    } catch (err) {
      // A retry after a lost response can surface ORDER_ALREADY_CAPTURED.
      if (err.providerIssue === 'ORDER_ALREADY_CAPTURED') {
        const latest = await getOrder(orderId);
        const recheck = verifyOrderShape({
          order: latest,
          expectedAmountMinor,
          expectedCurrency,
          expectedPurchaseId,
          expectedTenantId,
        });
        if (recheck.valid && latest?.status === 'COMPLETED') {
          const capture = latest?.purchase_units?.[0]?.payments?.captures?.[0];
          return {
            status: 'COMPLETED',
            order: latest,
            amountMinor: recheck.amountMinor,
            currency: recheck.currency,
            captureId: capture?.id || null,
            alreadyCaptured: true,
          };
        }
      }
      throw err;
    }

    if (data?.status !== 'COMPLETED') {
      throw paypalError('PAYMENT_NOT_COMPLETED', 'PayPal did not complete the capture.', 502, { providerStatus: data?.status || null });
    }
    const unit = data?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (!capture || capture.status !== 'COMPLETED') {
      throw paypalError('PAYMENT_NOT_COMPLETED', 'PayPal did not complete the capture.', 502);
    }
    const capturedMinor = fromPayPalAmount(capture?.amount?.value, capture?.amount?.currency_code);
    if (capturedMinor !== Number(expectedAmountMinor) || String(capture?.amount?.currency_code || '').toUpperCase() !== String(expectedCurrency).toUpperCase()) {
      throw paypalError('CAPTURE_MISMATCH', 'Captured amount did not match the approved purchase.', 502);
    }
    return {
      status: 'COMPLETED',
      order: data,
      amountMinor: capturedMinor,
      currency: capture.amount.currency_code,
      captureId: capture.id || null,
      alreadyCaptured: false,
    };
  }

  async function verifyWebhookSignature({ headers = {}, rawBody } = {}) {
    if (!enabled || !config.PAYPAL_WEBHOOK_ID) return false;
    if (!rawBody || typeof rawBody !== 'string') return false;
    let event;
    try { event = JSON.parse(rawBody); } catch { return false; }
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionTime = headers['paypal-transmission-time'];
    const certUrl = headers['paypal-cert-url'];
    const authAlgo = headers['paypal-auth-algo'];
    const transmissionSig = headers['paypal-transmission-sig'];
    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) return false;

    try {
      const data = await fetchJson('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        headers: await authHeaders(),
        body: {
          transmission_id: transmissionId,
          transmission_time: transmissionTime,
          cert_url: certUrl,
          auth_algo: authAlgo,
          transmission_sig: transmissionSig,
          webhook_id: config.PAYPAL_WEBHOOK_ID,
          webhook_event: event,
        },
      });
      return data?.verification_status === 'SUCCESS';
    } catch {
      return false;
    }
  }

  function parseWebhookEvent(rawBody) {
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { return { error: 'invalid_json' }; }
    const resource = parsed?.resource || {};
    const related = resource?.supplementary_data?.related_ids || {};
    const unit = Array.isArray(resource?.purchase_units) ? resource.purchase_units[0] : null;
    const capture = resource?.amount && resource?.id
      ? resource
      : (resource?.payments?.captures?.[0] || unit?.payments?.captures?.[0] || null);

    const orderId = related.order_id
      || (String(parsed?.event_type || '').startsWith('CHECKOUT.ORDER') ? resource?.id : null)
      || (String(parsed?.event_type || '').includes('ORDER') ? resource?.id : null)
      || null;
    const purchaseId = resource?.custom_id || unit?.custom_id || capture?.custom_id || null;
    const invoiceId = resource?.invoice_id || unit?.invoice_id || capture?.invoice_id || null;
    const amount = capture?.amount || resource?.amount || unit?.amount || null;

    return {
      eventId: parsed?.id || null,
      eventType: parsed?.event_type || null,
      resourceType: parsed?.resource_type || null,
      orderId,
      purchaseId,
      invoiceId,
      status: resource?.status || capture?.status || null,
      captureId: capture?.id || null,
      amountMinor: amount ? fromPayPalAmount(amount.value, amount.currency_code) : null,
      currency: amount?.currency_code || null,
      resource,
    };
  }

  return {
    isEnabled,
    requireEnabled,
    createOrder,
    getOrder,
    verifyOrder,
    captureOrder,
    verifyWebhookSignature,
    parseWebhookEvent,
    currencyExponent,
    invoiceIdFor,
  };
}

module.exports = {
  createPayPalService,
  currencyExponent,
  toPayPalAmount,
  fromPayPalAmount,
  invoiceIdFor,
};
