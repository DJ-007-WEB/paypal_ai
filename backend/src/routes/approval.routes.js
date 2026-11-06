'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');

function createApprovalRoutes({ tenantService, purchaseStore, auditService }) {
  const router = express.Router();

  // POST /api/approvals/purchase/:purchaseId/:action
  // Action is "approve" or "reject"
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
      const action = String(req.params.action).toLowerCase();
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

      // Check permission: only roles with 'purchases:approve' may approve/reject
      const hasApprovePerm = purchase.membership?.permissions?.includes('purchases:approve');
      if (!hasApprovePerm) {
        const err = new Error('You do not have permission to approve/reject purchases.');
        err.statusCode = 403;
        err.code = 'FORBIDDEN';
        throw err;
      }

      const now = new Date().toISOString();
      const approvalEvent = {
        eventId: `approval_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        tenantId,
        eventType: `PURCHASE_${action.toUpperCase()}`,
        requestId: purchase.requestId,
        purchaseId,
        actorId,
        timestamp: now,
        metadata: {
          action,
          purchaseStatus: purchase.decision?.status,
          rationale: req.body?.rationale || '',
        },
      };
      await auditService.recordEvent(approvalEvent);

      // Update purchase record to track approval
      const updater = (current) => ({
        ...current,
        approval: {
          ...current.approval,
          [action]: {
            approvedBy: actorId,
            approvedAt: now,
            rationale: req.body?.rationale || '',
          },
        },
        updatedAt: now,
      });
      const updated = await purchaseStore.upsert({ tenantId, purchaseId, updater });

      return res.status(200).json({
        success: true,
        data: {
          purchaseId: updated.purchaseId,
          action,
          approvedBy: actorId,
          approvedAt: now,
          rationale: req.body?.rationale || '',
          decisionStatus: updated.decision?.status,
          authorization: updated.authorization,
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
