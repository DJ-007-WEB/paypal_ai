'use strict';

const express = require('express');
const { invoiceIdFor } = require('../services/paypal.service');

/**
 * PayPal Sandbox payment routes.
 *
 * Invariants:
 * - Amount/currency come from the stored recommendation, never the client.
 * - A PayPal order can only be created after a recorded human approval.
 * - Payment is marked COMPLETED only after PayPal confirms a COMPLETED capture
 *   whose amount, currency, purchase, and tenant all match.
 * - Every state transition is an atomic compare-and-set; duplicate callbacks
 *   and concurrent captures cannot double-apply.
 * - The webhook is mounted separately before JSON parsing and is not behind
 *   authentication/CSRF because PayPal cannot send either.
 */

function httpError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function requireTenant(req) {
  if (!req.auth || !req.auth.tenantId) throw httpError('TENANT_CONTEXT_REQUIRED', 'Tenant context is required.', 400);
  return req.auth.tenantId;
}

function approvalLink(order) {
  return order?.links?.find((link) => link.rel === 'approve')?.href || null;
}

function paymentView(purchase) {
  const paypal = purchase.payment?.paypal || {};
  return {
    paymentStatus: purchase.paymentStatus || 'NONE',
    paypal: {
      orderId: paypal.orderId || null,
      status: paypal.status || 'NONE',
      createdAt: paypal.createdAt || null,
      capturedAt: paypal.capturedAt || null,
      cancelledAt: paypal.cancelledAt || null,
      amountMinor: paypal.amountMinor ?? null,
      currency: paypal.currency || null,
      captureId: paypal.captureId || null,
    },
    authorization: purchase.authorization || null,
    decisionStatus: purchase.decision?.status || null,
    approvalStatus: purchase.approvalStatus || null,
  };
}

function createPaymentRoutes({ purchaseStore, auditService, paypalService } = {}) {
  const router = express.Router();
  if (!paypalService) throw new Error('Payment routes require paypalService.');

  async function loadPurchase(req) {
    const tenantId = requireTenant(req);
    const purchaseId = req.params.purchaseId;
    const purchase = await purchaseStore.getById({ tenantId, purchaseId });
    if (!purchase) throw httpError('PURCHASE_NOT_FOUND', 'Purchase record not found.', 404);
    return { tenantId, purchaseId, purchase };
  }

  // POST /api/payments/create/:purchaseId
  router.post('/payments/create/:purchaseId', async (req, res, next) => {
    try {
      if (!paypalService.isEnabled()) throw httpError('PAYPAL_NOT_CONFIGURED', 'PayPal Sandbox is not configured.', 503);
      const { tenantId, purchaseId, purchase } = await loadPurchase(req);

      if (purchase.paymentStatus === 'COMPLETED' || purchase.authorization?.paymentCaptured) {
        throw httpError('PAYMENT_COMPLETED', 'This purchase has already been paid.', 409);
      }
      if (purchase.approvalStatus !== 'APPROVED' || !purchase.approval?.approvedAt) {
        throw httpError('APPROVAL_REQUIRED', 'A recorded human approval is required before payment.', 409);
      }
      if (purchase.decision?.status !== 'RECOMMENDED' || purchase.policy?.passed !== true || !purchase.recommendation) {
        throw httpError('NOT_ELIGIBLE', 'Only a policy-passing recommendation can be paid.', 400);
      }

      const amountMinor = Number(purchase.recommendation.totalMinor);
      const currency = String(purchase.recommendation.currency || purchase.request?.currency || '').toUpperCase();
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        throw httpError('INVALID_AMOUNT', 'The stored recommendation has no valid amount.', 400);
      }
      if (purchase.request?.maxTotalMinor && amountMinor > Number(purchase.request.maxTotalMinor)) {
        throw httpError('AMOUNT_EXCEEDS_BUDGET', 'The recommendation exceeds the approved budget.', 400);
      }
      if (!/^[A-Z]{3}$/.test(currency)) throw httpError('INVALID_CURRENCY', 'The stored recommendation has no valid currency.', 400);

      // Return the existing approval link instead of creating a second order.
      const existing = purchase.payment?.paypal || {};
      if (existing.orderId && ['CREATED', 'APPROVED', 'CAPTURING'].includes(purchase.paymentStatus)) {
        try {
          const order = await paypalService.getOrder(existing.orderId);
          return res.status(200).json({
            success: true,
            data: {
              purchaseId,
              paypalOrderId: existing.orderId,
              approvalUrl: approvalLink(order),
              amountMinor: existing.amountMinor,
              currency: existing.currency,
              status: existing.status,
              reused: true,
            },
            meta: { requestId: req.requestId || null },
          });
        } catch {
          throw httpError('ORDER_EXISTS', 'A PayPal order already exists for this purchase.', 409);
        }
      }

      const claim = await purchaseStore.compareAndSetPayment({
        tenantId,
        purchaseId,
        expectedStatuses: ['NONE', 'CANCELLED', 'DECLINED', 'CAPTURE_FAILED', 'FAILED'],
        status: 'CREATING',
        patch: { payment: { ...(purchase.payment || {}), paypal: { status: 'CREATING' } } },
      });
      if (!claim.updated) {
        const latest = claim.record;
        if (latest?.paymentStatus === 'COMPLETED') throw httpError('PAYMENT_COMPLETED', 'This purchase has already been paid.', 409);
        throw httpError('PAYMENT_IN_PROGRESS', 'Another payment action is already in progress.', 409);
      }

      let paypalOrder;
      try {
        paypalOrder = await paypalService.createOrder({ amountMinor, currency, purchaseId, tenantId });
      } catch (err) {
        await purchaseStore.compareAndSetPayment({
          tenantId,
          purchaseId,
          expectedStatuses: ['CREATING'],
          status: 'FAILED',
          patch: { payment: { ...(purchase.payment || {}), paypal: { status: 'FAILED', errorCode: err.code || 'PAYPAL_ERROR' } } },
        }).catch(() => {});
        throw err;
      }

      const createdAt = new Date().toISOString();
      const paypalRecord = {
        orderId: paypalOrder.id,
        status: 'CREATED',
        createdAt,
        amountMinor,
        currency,
        invoiceId: invoiceIdFor(tenantId, purchaseId),
      };
      const finalized = await purchaseStore.compareAndSetPayment({
        tenantId,
        purchaseId,
        expectedStatuses: ['CREATING'],
        status: 'CREATED',
        patch: {
          paypalOrderId: paypalOrder.id,
          payment: { ...(purchase.payment || {}), paypal: paypalRecord },
        },
      });
      if (!finalized.updated) throw httpError('PAYMENT_CONFLICT', 'Payment state changed while creating the order.', 409);

      try {
        await auditService.recordEvent({
          tenantId,
          eventType: 'PAYMENT_ORDER_CREATED',
          requestId: req.requestId || null,
          actorId: req.auth.userId,
          metadata: { purchaseId, paypalOrderId: paypalOrder.id, amountMinor, currency },
        });
      } catch { /* best-effort */ }

      return res.status(200).json({
        success: true,
        data: {
          purchaseId,
          paypalOrderId: paypalOrder.id,
          approvalUrl: approvalLink(paypalOrder),
          amountMinor,
          currency,
          status: 'CREATED',
          reused: false,
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/payments/capture/:purchaseId
  router.post('/payments/capture/:purchaseId', async (req, res, next) => {
    try {
      if (!paypalService.isEnabled()) throw httpError('PAYPAL_NOT_CONFIGURED', 'PayPal Sandbox is not configured.', 503);
      const { tenantId, purchaseId, purchase } = await loadPurchase(req);

      if (purchase.paymentStatus === 'COMPLETED') {
        return res.status(200).json({ success: true, data: { ...paymentView(purchase), alreadyCaptured: true }, meta: { requestId: req.requestId || null } });
      }
      if (purchase.approvalStatus !== 'APPROVED' || !purchase.authorization?.humanApproved) {
        throw httpError('APPROVAL_REQUIRED', 'A recorded human approval is required before capture.', 409);
      }

      const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
      const storedOrderId = purchase.payment?.paypal?.orderId;
      if (!orderId) throw httpError('MISSING_ORDER_ID', 'PayPal order ID is required.', 400);
      if (!storedOrderId || storedOrderId !== orderId) throw httpError('ORDER_MISMATCH', 'PayPal order does not belong to this purchase.', 400);

      const paypalInfo = purchase.payment?.paypal || {};
      const expectedAmountMinor = Number(paypalInfo.amountMinor);
      const expectedCurrency = String(paypalInfo.currency || '').toUpperCase();
      if (!Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0) {
        throw httpError('ORDER_MISMATCH', 'No stored order amount to verify against.', 400);
      }

      const claim = await purchaseStore.compareAndSetPayment({
        tenantId,
        purchaseId,
        expectedStatuses: ['CREATED', 'APPROVED', 'CAPTURE_FAILED'],
        expectedOrderId: orderId,
        status: 'CAPTURING',
        patch: { payment: { ...(purchase.payment || {}), paypal: { ...paypalInfo, status: 'CAPTURING' } } },
      });
      if (!claim.updated) {
        const latest = claim.record;
        if (latest?.paymentStatus === 'COMPLETED') {
          return res.status(200).json({ success: true, data: { ...paymentView(latest), alreadyCaptured: true }, meta: { requestId: req.requestId || null } });
        }
        throw httpError('PAYMENT_IN_PROGRESS', 'This payment cannot be captured in its current state.', 409);
      }

      let capture;
      try {
        capture = await paypalService.captureOrder({
          orderId,
          expectedAmountMinor,
          expectedCurrency,
          expectedPurchaseId: purchaseId,
          expectedTenantId: tenantId,
        });
      } catch (err) {
        await purchaseStore.compareAndSetPayment({
          tenantId,
          purchaseId,
          expectedStatuses: ['CAPTURING'],
          expectedOrderId: orderId,
          status: 'CAPTURE_FAILED',
          patch: { payment: { ...(purchase.payment || {}), paypal: { ...paypalInfo, status: 'CAPTURE_FAILED', errorCode: err.code || 'CAPTURE_ERROR' } } },
        }).catch(() => {});
        try {
          await auditService.recordEvent({
            tenantId,
            eventType: 'PAYMENT_CAPTURE_FAILED',
            requestId: req.requestId || null,
            actorId: req.auth.userId,
            metadata: { purchaseId, paypalOrderId: orderId, code: err.code || 'CAPTURE_ERROR' },
          });
        } catch { /* best-effort */ }
        throw err;
      }

      if (capture.status !== 'COMPLETED') {
        await purchaseStore.compareAndSetPayment({
          tenantId,
          purchaseId,
          expectedStatuses: ['CAPTURING'],
          expectedOrderId: orderId,
          status: 'CAPTURE_FAILED',
          patch: { payment: { ...(purchase.payment || {}), paypal: { ...paypalInfo, status: 'CAPTURE_FAILED', errorCode: 'PAYMENT_NOT_COMPLETED' } } },
        }).catch(() => {});
        throw httpError('PAYMENT_NOT_COMPLETED', 'PayPal did not complete the capture.', 502);
      }

      const capturedAt = new Date().toISOString();
      const finalized = await purchaseStore.compareAndSetPayment({
        tenantId,
        purchaseId,
        expectedStatuses: ['CAPTURING'],
        expectedOrderId: orderId,
        status: 'COMPLETED',
        patch: {
          payment: {
            ...(purchase.payment || {}),
            paypal: {
              ...paypalInfo,
              status: 'COMPLETED',
              capturedAt,
              captureId: capture.captureId || null,
              verifiedAmountMinor: capture.amountMinor,
            },
          },
          authorization: {
            ...(purchase.authorization || {}),
            paymentAuthorized: false,
            paymentCaptured: true,
            capturedAt,
          },
        },
      });

      try {
        await auditService.recordEvent({
          tenantId,
          eventType: 'PAYMENT_CAPTURED',
          requestId: req.requestId || null,
          actorId: req.auth.userId,
          metadata: {
            purchaseId,
            paypalOrderId: orderId,
            captureId: capture.captureId || null,
            amountMinor: capture.amountMinor,
            currency: capture.currency,
          },
        });
      } catch { /* best-effort */ }

      return res.status(200).json({
        success: true,
        data: {
          purchaseId,
          paypalOrderId: orderId,
          captureStatus: 'COMPLETED',
          captureId: capture.captureId || null,
          amountMinor: capture.amountMinor,
          currency: capture.currency,
          authorization: finalized.record?.authorization || null,
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/payments/cancel/:purchaseId
  router.post('/payments/cancel/:purchaseId', async (req, res, next) => {
    try {
      const { tenantId, purchaseId, purchase } = await loadPurchase(req);
      if (purchase.paymentStatus === 'COMPLETED') throw httpError('PAYMENT_COMPLETED', 'A captured payment cannot be cancelled.', 409);
      if (purchase.paymentStatus === 'CANCELLED') {
        return res.status(200).json({ success: true, data: { purchaseId, status: 'CANCELLED', alreadyCancelled: true }, meta: { requestId: req.requestId || null } });
      }
      const cancelledAt = new Date().toISOString();
      const result = await purchaseStore.compareAndSetPayment({
        tenantId,
        purchaseId,
        expectedStatuses: ['NONE', 'CREATED', 'APPROVED', 'CAPTURE_FAILED', 'FAILED'],
        status: 'CANCELLED',
        patch: {
          payment: {
            ...(purchase.payment || {}),
            paypal: { ...(purchase.payment?.paypal || {}), status: 'CANCELLED', cancelledAt },
          },
        },
      });
      if (!result.updated) throw httpError('PAYMENT_CONFLICT', 'This payment cannot be cancelled in its current state.', 409);
      try {
        await auditService.recordEvent({
          tenantId,
          eventType: 'PAYMENT_ORDER_CANCELLED',
          requestId: req.requestId || null,
          actorId: req.auth.userId,
          metadata: { purchaseId },
        });
      } catch { /* best-effort */ }
      return res.status(200).json({ success: true, data: { purchaseId, status: 'CANCELLED' }, meta: { requestId: req.requestId || null } });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/payments/status/:purchaseId
  router.get('/payments/status/:purchaseId', async (req, res, next) => {
    try {
      const { purchaseId, purchase } = await loadPurchase(req);
      return res.status(200).json({
        success: true,
        data: { purchaseId, ...paymentView(purchase) },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * PayPal webhook handler. Mounted before express.json so the exact raw bytes
 * PayPal signed are preserved. No auth/CSRF middleware.
 */
function createPaymentWebhookHandler({ purchaseStore, auditService, paypalService, webhookEventStore } = {}) {
  if (!paypalService || !purchaseStore || !webhookEventStore) throw new Error('Webhook handler requires services.');

  return async function paymentWebhookHandler(req, res, next) {
    try {
      if (!paypalService.isEnabled()) {
        return res.status(503).json({ success: false, error: { code: 'PAYPAL_NOT_CONFIGURED', message: 'PayPal is not configured.' } });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_BODY', message: 'Raw webhook body is required.' } });
      }
      const rawBody = req.body.toString('utf8');
      const verified = await paypalService.verifyWebhookSignature({ headers: req.headers, rawBody });
      if (!verified) {
        return res.status(400).json({ success: false, error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Webhook signature verification failed.' } });
      }

      const event = paypalService.parseWebhookEvent(rawBody);
      if (event.error || !event.eventType) {
        return res.status(400).json({ success: false, error: { code: 'WEBHOOK_INVALID', message: 'Invalid webhook event.' } });
      }
      if (event.eventId && await webhookEventStore.hasProcessed(event.eventId)) {
        return res.status(200).json({ success: true, data: { duplicate: true } });
      }
      if (!event.orderId) {
        await webhookEventStore.markProcessed({ eventId: event.eventId, eventType: event.eventType });
        return res.status(200).json({ success: true, data: { ignored: true } });
      }

      const purchase = await purchaseStore.findByPayPalOrderId({ orderId: event.orderId });
      if (!purchase) {
        await webhookEventStore.markProcessed({ eventId: event.eventId, eventType: event.eventType, orderId: event.orderId });
        return res.status(200).json({ success: true, data: { ignored: true } });
      }

      // Correlation must match server-side records; never trust the event alone.
      if (event.purchaseId && event.purchaseId !== purchase.purchaseId) {
        await webhookEventStore.markProcessed({ eventId: event.eventId, eventType: event.eventType, orderId: event.orderId });
        return res.status(200).json({ success: true, data: { ignored: true, reason: 'purchase_mismatch' } });
      }
      if (event.invoiceId && event.invoiceId !== invoiceIdFor(purchase.tenantId, purchase.purchaseId)) {
        await webhookEventStore.markProcessed({ eventId: event.eventId, eventType: event.eventType, orderId: event.orderId });
        return res.status(200).json({ success: true, data: { ignored: true, reason: 'tenant_mismatch' } });
      }

      const paypalInfo = purchase.payment?.paypal || {};
      const now = new Date().toISOString();
      let transition = null;
      let auditType = null;

      if (event.eventType === 'CHECKOUT.ORDER.APPROVED') {
        transition = { from: ['CREATED'], to: 'APPROVED', paypalStatus: 'APPROVED' };
        auditType = 'PAYMENT_ORDER_APPROVED';
      } else if (['CHECKOUT.ORDER.DECLINED', 'CHECKOUT.ORDER.VOIDED', 'CHECKOUT.ORDER.CANCELLED'].includes(event.eventType)) {
        transition = { from: ['NONE', 'CREATED', 'APPROVED', 'CAPTURE_FAILED', 'FAILED'], to: 'CANCELLED', paypalStatus: 'CANCELLED', cancelledAt: now };
        auditType = 'PAYMENT_ORDER_CANCELLED';
      } else if (['CHECKOUT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.COMPLETED'].includes(event.eventType)) {
        const expectedAmountMinor = Number(paypalInfo.amountMinor);
        const expectedCurrency = String(paypalInfo.currency || '').toUpperCase();
        if (!Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0) {
          await webhookEventStore.markProcessed({ eventId: event.eventId, eventType: event.eventType, orderId: event.orderId });
          return res.status(200).json({ success: true, data: { ignored: true, reason: 'no_stored_amount' } });
        }
        let verification;
        try {
          verification = await paypalService.verifyOrder({
            orderId: event.orderId,
            expectedAmountMinor,
            expectedCurrency,
            expectedPurchaseId: purchase.purchaseId,
            expectedTenantId: purchase.tenantId,
          });
        } catch {
          // Transient provider failure: do not mutate; let PayPal retry.
          return res.status(500).json({ success: false, error: { code: 'PAYMENT_VERIFICATION_UNAVAILABLE', message: 'Could not verify the PayPal order yet.' } });
        }
        if (!verification.valid) {
          transition = { from: ['CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_FAILED'], to: 'VERIFICATION_FAILED', paypalStatus: 'VERIFICATION_FAILED', verificationReasons: verification.reasons };
          auditType = 'PAYMENT_VERIFICATION_FAILED';
        } else {
          transition = { from: ['CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_FAILED'], to: 'COMPLETED', paypalStatus: 'COMPLETED', capturedAt: now, captureId: event.captureId || null };
          auditType = 'PAYMENT_CAPTURED';
        }
      } else if (['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED'].includes(event.eventType)) {
        transition = { from: ['CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_FAILED'], to: 'DECLINED', paypalStatus: 'DECLINED' };
        auditType = 'PAYMENT_CAPTURE_DECLINED';
      } else if (['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'].includes(event.eventType)) {
        transition = { from: ['COMPLETED'], to: event.eventType === 'PAYMENT.CAPTURE.REFUNDED' ? 'REFUNDED' : 'REVERSED', paypalStatus: event.eventType === 'PAYMENT.CAPTURE.REFUNDED' ? 'REFUNDED' : 'REVERSED', refundedAt: now };
        auditType = 'PAYMENT_REFUNDED';
      }

      if (transition) {
        const patchPayment = {
          ...(purchase.payment || {}),
          paypal: {
            ...paypalInfo,
            status: transition.paypalStatus,
            ...(transition.capturedAt ? { capturedAt: transition.capturedAt } : {}),
            ...(transition.cancelledAt ? { cancelledAt: transition.cancelledAt } : {}),
            ...(transition.refundedAt ? { refundedAt: transition.refundedAt } : {}),
            ...(transition.captureId ? { captureId: transition.captureId } : {}),
            ...(transition.verificationReasons ? { verificationReasons: transition.verificationReasons } : {}),
            updatedAt: now,
          },
        };
        const patch = { payment: patchPayment };
        if (transition.to === 'COMPLETED') {
          patch.authorization = { ...(purchase.authorization || {}), paymentCaptured: true, paymentAuthorized: false, capturedAt: now };
        } else if (['REFUNDED', 'REVERSED', 'CANCELLED', 'DECLINED'].includes(transition.to)) {
          patch.authorization = { ...(purchase.authorization || {}), paymentCaptured: false };
        }
        const result = await purchaseStore.compareAndSetPayment({
          tenantId: purchase.tenantId,
          purchaseId: purchase.purchaseId,
          expectedStatuses: transition.from,
          expectedOrderId: event.orderId,
          status: transition.to,
          patch,
        });
        if (result.updated && auditType) {
          try {
            await auditService.recordEvent({
              tenantId: purchase.tenantId,
              eventType: auditType,
              requestId: null,
              actorId: null,
              metadata: {
                purchaseId: purchase.purchaseId,
                orderId: event.orderId,
                eventId: event.eventId,
                eventType: event.eventType,
                source: 'paypal-webhook',
              },
            });
          } catch { /* best-effort */ }
        }
      }

      await webhookEventStore.markProcessed({
        eventId: event.eventId,
        eventType: event.eventType,
        orderId: event.orderId,
        purchaseId: purchase.purchaseId,
        tenantId: purchase.tenantId,
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      // Non-2xx makes PayPal retry; event is not marked processed on failure.
      return next(error);
    }
  };
}

module.exports = { createPaymentRoutes, createPaymentWebhookHandler };
