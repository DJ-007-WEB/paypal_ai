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

  router.post('/purchases/evaluate', async (req, res, next) => {
    try {
      const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
      const requestId = req.get('x-request-id') || requestBody.requestId || req.id || randomUUID();
      res.set('X-Request-Id', requestId);

      const validation = validatePurchaseRequest(requestBody);
      if (!validation.valid) {
        throw createValidationError('The purchase request is invalid.', validation.errors);
      }

      const request = { ...requestBody, requestId };
      await auditService.recordEvent({
        eventType: 'PURCHASE_EVALUATION_REQUESTED',
        requestId,
        metadata: {
          productId: request.productId,
          quantity: request.quantity,
          currency: request.currency,
        },
      });

      const offers = await vendorService.getOffersForRequest(request);
      await auditService.recordEvent({
        eventType: 'VENDOR_OFFERS_RETRIEVED',
        requestId,
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
        eventType,
        requestId,
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
        purchaseId,
        requestId,
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

      const auditEvents = await auditService.getEventsByRequestId(requestId);
      const persistedPurchase = await purchaseStore.upsert(purchaseId, (current) => ({
        ...current,
        auditEvents,
      }));

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
      next(error);
    }
  });

  router.get('/purchases/:purchaseId', async (req, res, next) => {
    try {
      const purchase = await purchaseStore.getById(req.params.purchaseId);
      if (!purchase) {
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

  return router;
}

module.exports = { createPurchaseRoutes };
