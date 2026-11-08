'use strict';

const express = require('express');

/**
 * Human approval routes.
 * - Permission is taken from the server-resolved session membership
 *   (req.auth.permissions), never from a membership object embedded in a
 *   purchase record.
 * - Only a policy-passing RECOMMENDED purchase can be approved.
 * - Approval and rejection are single-use atomic transitions (PENDING ->
 *   APPROVED/REJECTED); a captured payment can never be approved or rejected.
 */
function createApprovalRoutes({ purchaseStore, auditService } = {}) {
  const router = express.Router();

  router.get('/approvals/pending', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const records = await purchaseStore.list({ tenantId: req.auth.tenantId, filters: {} });
      const pending = records.filter((r) => r.authorization?.requiresHumanApproval
        && (r.approvalStatus || 'PENDING') === 'PENDING'
        && r.paymentStatus !== 'COMPLETED');
      return res.json({ success: true, data: pending, meta: { count: pending.length } });
    } catch (err) { next(err); }
  });

  // POST /api/approvals/purchase/:purchaseId/:action  (approve|reject)
  router.post('/approvals/purchase/:purchaseId/:action', async (req, res, next) => {
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
      const action = String(req.params.action || '').toLowerCase();
      if (action !== 'approve' && action !== 'reject') {
        const err = new Error('Invalid action. Use "approve" or "reject".');
        err.statusCode = 400;
        err.code = 'INVALID_ACTION';
        throw err;
      }

      const purchase = await purchaseStore.getById({ tenantId, purchaseId });
      if (!purchase) {
        const notFound = new Error('Purchase record not found.');
        notFound.statusCode = 404;
        notFound.code = 'PURCHASE_NOT_FOUND';
        throw notFound;
      }

      if (purchase.paymentStatus === 'COMPLETED' || purchase.authorization?.paymentCaptured) {
        const err = new Error('This purchase has already been paid and cannot be changed.');
        err.statusCode = 409;
        err.code = 'PAYMENT_COMPLETED';
        throw err;
      }

      if (purchase.approvalStatus && purchase.approvalStatus !== 'PENDING') {
        const err = new Error('This purchase already has a decision.');
        err.statusCode = 409;
        err.code = 'ALREADY_DECIDED';
        throw err;
      }

      if (!purchase.authorization?.requiresHumanApproval) {
        const err = new Error('This purchase does not require human approval.');
        err.statusCode = 400;
        err.code = 'NOT_ELIGIBLE';
        throw err;
      }
      if (action === 'approve') {
        const eligible = purchase.decision?.status === 'RECOMMENDED'
          && purchase.policy?.passed === true
          && Boolean(purchase.recommendation);
        if (!eligible) {
          const err = new Error('Only a policy-passing recommendation can be approved.');
          err.statusCode = 400;
          err.code = 'NOT_ELIGIBLE';
          throw err;
        }
      }

      const now = new Date().toISOString();
      const rationale = typeof req.body?.rationale === 'string' ? req.body.rationale.trim().slice(0, 1000) : '';
      const approval = {
        ...(purchase.approval || {}),
        decision: action === 'approve' ? 'APPROVED' : 'REJECTED',
        decidedBy: actorId,
        decidedAt: now,
        rationale,
      };
      if (action === 'approve') {
        approval.approvedBy = actorId;
        approval.approvedAt = now;
      } else {
        approval.rejectedBy = actorId;
        approval.rejectedAt = now;
      }

      const result = await purchaseStore.compareAndSetApproval({
        tenantId,
        purchaseId,
        expectedStatuses: ['PENDING'],
        status: action === 'approve' ? 'APPROVED' : 'REJECTED',
        expectedPaymentStatuses: ['NONE', 'CREATED', 'APPROVED', 'FAILED', 'CANCELLED', 'DECLINED', 'CAPTURE_FAILED'],
        patch: {
          approval,
          authorization: {
            ...(purchase.authorization || {}),
            humanApproved: action === 'approve',
            requiresHumanApproval: false,
            paymentAuthorized: false,
            paymentCaptured: false,
          },
        },
      });

      if (!result.updated) {
        const latest = result.record;
        if (latest && latest.approvalStatus !== 'PENDING') {
          const err = new Error('This purchase already has a decision.');
          err.statusCode = 409;
          err.code = 'ALREADY_DECIDED';
          throw err;
        }
        const err = new Error('This purchase cannot be decided in its current state.');
        err.statusCode = 409;
        err.code = 'APPROVAL_CONFLICT';
        throw err;
      }

      try {
        await auditService.recordEvent({
          tenantId,
          eventType: action === 'approve' ? 'PURCHASE_APPROVED' : 'PURCHASE_REJECTED',
          requestId: purchase.requestId || null,
          purchaseId,
          actorId,
          metadata: {
            action,
            purchaseStatus: purchase.decision?.status || null,
            rationale,
          },
        });
      } catch { /* audit best-effort, never blocks the decision response */ }

      return res.status(200).json({
        success: true,
        data: {
          purchaseId,
          action,
          approvalStatus: result.record.approvalStatus,
          decidedBy: actorId,
          decidedAt: now,
          rationale,
          decisionStatus: result.record.decision?.status,
          authorization: result.record.authorization,
        },
        meta: { requestId: req.requestId || null },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createApprovalRoutes };
