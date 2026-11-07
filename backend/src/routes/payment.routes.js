'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');
const { createPurchaseStore } = require('../services/purchaseStore.service');
const { recordApprovalEvent } = require('../services/audit.service');
const paypal = require('../services/paypal.service');

function createPaymentRoutes({ purchaseStore, auditService } = {}) {
  const router = express.Router();

  // POST /api/payments/create/:purchaseId
  // Creates a PayPal order for an eligible purchase.
  // The amount is calculated server-side from the purchase record.
  // The frontend must NOT supply any amount or payment details.
  router.post('/payments/create/:purchaseId', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenantId = req.auth.tenantId;
      const actorId = req.auth.userId;
      const purchaseId = req.params.purchaseId;

      const purchase = await purchaseStore.getById({ tenantId, purchaseId });
      if (!purchase) {
        const notFound = new Error('Purchase record not found.');
        notFound.statusCode = 404;
        notFound.code = 'PURCHASE_NOT_FOUND';
        throw notFound;
      }

      // Check that the purchase requires approval and is in a state where payment
      // may be attempted. The deterministic engine must have recommended and policy passed.
      if (!purchase.authorization?.requiresHumanApproval) {
        return res.status(400).json({
          success: false,
          error: { code: 'NOT_ELIGIBLE', message: 'This purchase is not eligible for PayPal payment.' },
        });
      }

      // Check that the user has the purchaser/owner role with approval permission
      const hasApprovePerm = purchase.membership?.permissions?.includes('purchases:approve');
      if (!hasApprovePerm) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You do not have permission to initiate PayPal payment.' },
        });
      }

      if (purchase.payment?.paypal?.orderId) {
        return res.status(409).json({
          success: false,
          error: { code: 'ORDER_EXISTS', message: 'A PayPal order already exists for this purchase.' },
        });
      }

      // Calculate amount from the purchase record's trusted data
      const amountMinor = purchase.request?.maxTotalMinor;
      const currency = purchase.request?.currency || 'INR';

      if (!amountMinor || amountMinor <= 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_AMOUNT', message: 'Purchase record has no valid budget amount.' },
        });
      }

      // Create PayPal order
      const paypalOrder = await paypal.createOrder({
        amountMinor,
        currency,
        purchaseId,
        tenantId,
      });

      // Store the PayPal order reference against the purchase record
      const updater = (current) => ({
        ...current,
        payment: {
          ...current.payment,
          paypal: {
            orderId: paypalOrder.id,
            status: 'CREATED',
            createdAt: new Date().toISOString(),
            amountMinor,
            currency,
            // Do NOT set paymentAuthorized = true yet
          },
        },
        updatedAt: new Date().toISOString(),
      });
      const updated = await purchaseStore.upsert({ tenantId, purchaseId, updater });

      // Record audit event
      try {
        await auditService.recordEvent({
          tenantId,
          eventType: 'PAYMENT_ORDER_CREATED',
          requestId: req.requestId || req.get('x-request-id') || null,
          actorId,
          metadata: {
            purchaseId,
            paypalOrderId: paypalOrder.id,
            amountMinor,
            currency,
          },
        });
      } catch { /* audit best-effort */ }

      return res.status(200).json({
        success: true,
        data: {
          purchaseId: updated.payment.paypal.orderId,
          paypalOrderId: paypalOrder.id,
          approvalUrl: paypalOrder.links?.find((l) => l.rel === 'approve')?.href,
          amountMinor,
          currency,
          status: updated.payment.paypal.status,
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/payments/capture/:purchaseId
  // Captures a PayPal order after the user has approved on PayPal.
  // Verifies order matches purchase before capturing. Idempotent: duplicate captures are rejected.
  router.post('/payments/capture/:purchaseId', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenantId = req.auth.tenantId;
      const actorId = req.auth.userId;
      const purchaseId = req.params.purchaseId;

      const purchase = await purchaseStore.getById({ tenantId, purchaseId });
      if (!purchase) {
        const notFound = new Error('Purchase record not found.');
        notFound.statusCode = 404;
        notFound.code = 'PURCHASE_NOT_FOUND';
        throw notFound;
      }

      // Check that the purchase has been approved and user has permission
      const hasApprovePerm = purchase.membership?.permissions?.includes('purchases:approve');
      if (!hasApprovePerm) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You do not have permission to capture PayPal payment.' },
        });
      }

      const { orderId } = req.body || {};
      if (!orderId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_ORDER_ID', message: 'PayPal order ID is required.' },
        });
      }

      // Verify the order matches this purchase (amount + tenant check)
      const verification = await paypal.verifyOrder({
        orderId,
        expectedAmountMinor: purchase.request?.maxTotalMinor,
        expectedCurrency: purchase.request?.currency || 'INR',
        expectedTenantId: tenantId,
      });
      if (!verification.valid) {
        return res.status(400).json({
          success: false,
          error: { code: 'ORDER_MISMATCH', message: 'PayPal order does not match this purchase.' },
        });
      }

      // Idempotency check: if this orderId already has a capture recorded for this purchase, reject
      if (purchase.payment?.paypal?.orderId === orderId && purchase.payment?.paypal?.capturedAt) {
        return res.status(409).json({
          success: false,
          error: { code: 'ALREADY_CAPTURED', message: 'This PayPal order has already been captured for this purchase.' },
        });
      }

      // Capture the order
      const capture = await paypal.captureOrder({ orderId, purchaseId, tenantId });

      // Update the purchase record with capture result
      const status = capture.status;
      const updater = (current) => ({
        ...current,
        payment: {
          ...current.payment,
          paypal: {
            ...current.payment.paypal,
            orderId,
            status,
            capturedAt: new Date().toISOString(),
            // paymentAuthorized remains false - human approval still required; only record captured
          },
        },
        updatedAt: new Date().toISOString(),
      });
      const updated = await purchaseStore.upsert({ tenantId, purchaseId, updater });

      // Record audit event
      try {
        await auditService.recordEvent({
          tenantId,
          eventType: 'PAYMENT_ORDER_CAPTURED',
          requestId: req.requestId || req.get('x-request-id') || null,
          actorId,
          metadata: {
            purchaseId,
            paypalOrderId: orderId,
            captureStatus: status,
          },
        });
      } catch { /* audit best-effort */ }

      return res.status(200).json({
        success: true,
        data: {
          purchaseId: updated.purchaseId,
          paypalOrderId: orderId,
          captureStatus: status,
          authorization: updated.authorization,
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/payments/cancel/:purchaseId
  // Called when the user cancels on PayPal.
  router.post('/payments/cancel/:purchaseId', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenantId = req.auth.tenantId;
      const actorId = req.auth.userId;
      const purchaseId = req.params.purchaseId;

      const purchase = await purchaseStore.getById({ tenantId, purchaseId });
      if (!purchase) {
        const notFound = new Error('Purchase record not found.');
        notFound.statusCode = 404;
        notFound.code = 'PURCHASE_NOT_FOUND';
        throw notFound;
      }

      // Update the purchase record to reflect cancellation
      const updater = (current) => ({
        ...current,
        payment: {
          ...current.payment,
          paypal: {
            ...current.payment.paypal,
            status: 'CANCELLED',
            cancelledAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      });
      await purchaseStore.upsert({ tenantId, purchaseId, updater });

      // Record audit event
      try {
        await auditService.recordEvent({
          tenantId,
          eventType: 'PAYMENT_ORDER_CANCELLED',
          requestId: req.requestId || req.get('x-request-id') || null,
          actorId,
          metadata: { purchaseId },
        });
      } catch { /* audit best-effort */ }

      return res.status(200).json({
        success: true,
        data: {
          purchaseId,
          status: 'CANCELLED',
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/payments/status/:purchaseId
  // Returns the current payment status for a purchase.
  router.get('/payments/status/:purchaseId', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenantId = req.auth.tenantId;
      const purchaseId = req.params.purchaseId;

      const purchase = await purchaseStore.getById({ tenantId, purchaseId });
      if (!purchase) {
        const notFound = new Error('Purchase record not found.');
        notFound.statusCode = 404;
        notFound.code = 'PURCHASE_NOT_FOUND';
        throw notFound;
      }

      const paypalInfo = purchase.payment?.paypal || {};
      return res.status(200).json({
        success: true,
        data: {
          purchaseId,
          paypal: {
            orderId: paypalInfo.orderId,
            status: paypalInfo.status,
            createdAt: paypalInfo.createdAt,
            capturedAt: paypalInfo.capturedAt,
            cancelledAt: paypalInfo.cancelledAt,
            amountMinor: paypalInfo.amountMinor,
            currency: paypalInfo.currency,
          },
          authorization: purchase.authorization,
          decisionStatus: purchase.decision?.status,
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/payments/webhook
  // PayPal webhook endpoint for order events.
  // Verifies signature and processes events idempotently.
  router.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const signature = req.get('PayPal-TRANSMISSION-SIG');
      const timestamp = req.get('PayPal-TRANSMISSION-TIME');
      const rawBody = req.body.toString('utf8') || '';

      if (!paypal.verifyWebhookSignature(rawBody, signature, timestamp)) {
        return res.status(400).json({ success: false, error: 'Invalid webhook signature.' });
      }

      const event = paypal.parseWebhookEvent(rawBody);
      if (event.error) {
        return res.status(400).json({ success: false, error: event.error });
      }

      // If the event is not about a purchase we track, respond ok but don't process
      if (!event.purchaseId || !event.orderId) {
        return res.status(200).json({ success: true });
      }

      // Idempotency: check if we've already processed this order
      const purchase = await purchaseStore.getById({ tenantId: req.auth?.tenantId, purchaseId: event.purchaseId });
      if (!purchase) {
        // Purchase not in our system; still acknowledge webhook
        return res.status(200).json({ success: true });
      }

      // Check if already captured/cancelled
      const existingStatus = purchase.payment?.paypal?.status;
      if (existingStatus === 'COMPLETED' || existingStatus === 'CANCELLED') {
        // Already processed; acknowledge to avoid PayPal retry fatigue
        return res.status(200).json({ success: true });
      }

      // Process based on event type
      let updater;
      let auditEventType;

      if (event.event_type === 'CHECKOUT.ORDER.APPROVED' || event.event_type === 'ORDER.VOIDED') {
        // Order approved or voided - update status but don't capture automatically
        // (capture is explicit via /api/payments/capture)
        updater = (current) => ({
          ...current,
          payment: {
            ...current.payment,
            paypal: {
              ...current.payment.paypal,
              status: event.event_type === 'ORDER.VOIDED' ? 'CANCELLED' : 'APPROVED',
              updatedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date().toISOString(),
        });
        auditEventType = 'PAYMENT_ORDER_APPROVED';
      } else if (event.event_type === 'CHECKOUT.CAPTURE.COMPLETED') {
        // Capture completed - this is the successful flow
        // Verify amount matches before marking
        const verification = await paypal.verifyOrder({
          orderId: event.orderId,
          expectedAmountMinor: purchase.request?.maxTotalMinor,
          expectedCurrency: purchase.request?.currency || 'INR',
          expectedTenantId: req.auth?.tenantId,
        });
        if (verification.valid) {
          updater = (current) => ({
            ...current,
            payment: {
              ...current.payment,
              paypal: {
                ...current.payment.paypal,
                status: 'COMPLETED',
                capturedAt: new Date().toISOString(),
              },
            },
            updatedAt: new Date().toISOString(),
          });
          auditEventType = 'PAYMENT_ORDER_CAPTURED';
        } else {
          // Amount mismatch - mark as failed verification
          updater = (current) => ({
            ...current,
            payment: {
              ...current.payment,
              paypal: {
                ...current.payment.paypal,
                status: 'VERIFICATION_FAILED',
                updatedAt: new Date().toISOString(),
              },
            },
            updatedAt: new Date().toISOString(),
          });
          auditEventType = 'PAYMENT_ORDER_VERIFICATION_FAILED';
        }
      } else if (event.event_type === 'PAYMENT.CAPTURE.DECLINED' || event.event_type === 'PAYMENT.CAPTURE.DENIED') {
        // Capture declined
        updater = (current) => ({
          ...current,
          payment: {
            ...current.payment,
            paypal: {
              ...current.payment.paypal,
              status: 'DECLINED',
              updatedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date().toISOString(),
        });
        auditEventType = 'PAYMENT_ORDER_DECLINED';
      } else if (event.event_type === 'PAYMENT.MONEY_TRANSFER.DECLINED') {
        // Payment declined
        updater = (current) => ({
          ...current,
          payment: {
            ...current.payment,
            paypal: {
              ...current.payment.paypal,
              status: 'DECLINED',
              updatedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date().toISOString(),
        });
        auditEventType = 'PAYMENT_ORDER_DECLINED';
      } else {
        // Unknown event type - acknowledge but don't change status
        return res.status(200).json({ success: true });
      }

      if (updater) {
        await purchaseStore.upsert({ tenantId: req.auth.tenantId, purchaseId: event.purchaseId, updater });
        try {
          await auditService.recordEvent({
            tenantId: req.auth.tenantId,
            eventType: auditEventType,
            requestId: req.requestId || req.get('x-request-id') || null,
            actorId: null,
            metadata: {
              purchaseId: event.purchaseId,
              orderId: event.orderId,
              eventType: event.eventType,
            },
          });
        } catch { /* audit best-effort */ }
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('PayPal webhook error:', error);
      // Respond 200 to PayPal to stop retries, but log internally
      return res.status(200).json({ success: true });
    }
  });

  return router;
}

module.exports = { createPaymentRoutes };