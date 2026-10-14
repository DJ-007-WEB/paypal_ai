'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');

const { evaluatePurchaseRequest } = require('../services/purchaseDecisionEngine');
const { validatePurchaseRequest } = require('../services/validation.service');
const { validatePurchasePolicy } = require('../services/policy.service');

function createValidationError(message, details = []) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  error.details = details;
  return error;
}

function createPurchaseRoutes({ vendorService, auditService, purchaseStore }) {
  const router = express.Router();

  // Purchase evaluation (§10): resolve + authorize tenant, validate request,
  // load only that tenant's offers + policy, evaluate with existing engine,
  // persist with server-resolved tenant. Decision engine untouched.
  router.post('/purchases/evaluate', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenantId = req.auth.tenantId;
      const actorId = req.auth.userId;
      const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
      // Server-authoritative request ID; client correlation kept distinct.
      const requestId = req.requestId || req.id || randomUUID();
      res.set('X-Request-Id', requestId);

      // Never trust payload tenant as ownership source
      if (requestBody.tenantId !== undefined && requestBody.tenantId !== null && String(requestBody.tenantId).trim() !== '' && String(requestBody.tenantId).trim() !== tenantId) {
        const err = new Error('Payload tenant identifiers are never trusted.');
        err.statusCode = 403;
        err.code = 'TENANT_MISMATCH';
        try {
          await auditService.recordEvent({ tenantId, eventType: 'CROSS_TENANT_ACCESS_DENIED', requestId, actorId, metadata: { action: 'purchases:evaluate' } });
        } catch { /* ignore */ }
        throw err;
      }

      const validation = validatePurchaseRequest(requestBody);
      if (!validation.valid) {
        throw createValidationError('The purchase request is invalid.', validation.errors);
      }

      const request = { ...requestBody, requestId, tenantId };
      delete request.tenantId; // engine input stays tenant-free; ownership enforced at persistence layer
      await auditService.recordEvent({
        tenantId,
        eventType: 'PURCHASE_EVALUATION_REQUESTED',
        requestId,
        actorId,
        metadata: {
          productId: request.productId,
          quantity: request.quantity,
          currency: request.currency,
        },
      });

      const offers = await vendorService.getOffersForRequest({ tenantId, request });
      await auditService.recordEvent({
        tenantId,
        eventType: 'VENDOR_OFFERS_RETRIEVED',
        requestId,
        actorId,
        metadata: {
          productId: request.productId,
          offerCount: offers.length,
          vendorIds: offers.map((offer) => offer.vendorId),
        },
      });

      const engineResult = evaluatePurchaseRequest(request, offers);
      const policyResult = validatePurchasePolicy({ request, offers, engineResult });

      let decision = { ...engineResult };
      if (engineResult.status === 'RECOMMENDED' && !policyResult.passed) {
        decision = {
          ...engineResult,
          status: 'POLICY_REJECTED',
          recommendation: null,
          ranking: [],
          explanation: 'The recommended offer failed policy validation and cannot be accepted.',
          uncertainties: engineResult.uncertainties || [],
        };
      }

      const eventType = decision.status === 'RECOMMENDED'
        ? 'RECOMMENDATION_GENERATED'
        : decision.status === 'NO_ELIGIBLE_OFFER'
          ? 'NO_ELIGIBLE_OFFER_FOUND'
          : 'POLICY_VALIDATION_FAILED';
      await auditService.recordEvent({
        tenantId,
        eventType,
        requestId,
        actorId,
        metadata: {
          status: decision.status,
          recommendedOfferId: decision.recommendation ? decision.recommendation.offerId : null,
          recommendedVendorId: decision.recommendation ? decision.recommendation.vendorId : null,
          policyPassed: policyResult.passed,
        },
      });

      const purchaseId = `purchase_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const finalDecision = {
        status: decision.status,
        recommendedOfferId: decision.recommendation ? decision.recommendation.offerId : null,
        recommendedVendorId: decision.recommendation ? decision.recommendation.vendorId : null,
      };

      const purchaseRecord = await purchaseStore.create({
        tenantId,
        purchaseId,
        requestId,
        actorId,
        request,
        decision: finalDecision,
        recommendation: decision.recommendation || null,
        ranking: decision.ranking || [],
        rejectedOffers: decision.rejected || [],
        policy: policyResult,
        explanation: decision.explanation || 'No recommendation generated.',
        uncertainties: decision.uncertainties || [],
        authorization: {
          paymentAuthorized: false,
          requiresHumanApproval: decision.status === 'RECOMMENDED' && policyResult.passed,
        },
        auditEvents: [],
      });

      const auditEvents = await auditService.getEventsByRequestId({ tenantId, requestId });
      const persistedPurchase = await purchaseStore.upsert({ tenantId, purchaseId, updater: (current) => ({
        ...current,
        auditEvents,
      }) });

      return res.status(200).json({
        success: true,
        data: {
          purchaseId: persistedPurchase.purchaseId,
          decision: persistedPurchase.decision,
          recommendation: persistedPurchase.recommendation,
          ranking: persistedPurchase.ranking,
          rejectedOffers: persistedPurchase.rejectedOffers,
          policy: persistedPurchase.policy,
          explanation: persistedPurchase.explanation,
          uncertainties: persistedPurchase.uncertainties,
          authorization: persistedPurchase.authorization,
          auditEvents: persistedPurchase.auditEvents,
        },
        meta: { requestId },
      });
    } catch (error) {
      // Redacted logging: no payloads, no stack in prod response (handled centrally).
      if (process.env.NODE_ENV !== 'test') {
        console.error('[PURCHASE EVALUATION FAILED] requestId=' + (req.requestId || 'unassigned'));
      }
      next(error);
    }
  });

  router.get('/purchases/:purchaseId', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenantId = req.auth.tenantId;
      const purchase = await purchaseStore.getById({ tenantId, purchaseId: req.params.purchaseId });
      if (!purchase) {
        // Generic 404 to avoid confirming existence of another tenant's resource.
        const notFound = new Error('Purchase record not found.');
        notFound.statusCode = 404;
        notFound.code = 'PURCHASE_NOT_FOUND';
        throw notFound;
      }

      return res.status(200).json({
        success: true,
        data: purchase,
        meta: { requestId: req.requestId || req.get('x-request-id') || null },
      });
    } catch (error) {
      next(error);
    }
  });

  // Tenant-scoped purchase history (same 404-safe semantics)
  router.get('/purchases', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const filters = {};
      if (req.query && typeof req.query.status === 'string' && req.query.status.trim()) {
        filters.status = req.query.status.trim();
      }
      const items = await purchaseStore.list({ tenantId: req.auth.tenantId, filters });
      return res.status(200).json({ success: true, data: items, meta: { count: items.length } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createPurchaseRoutes };
