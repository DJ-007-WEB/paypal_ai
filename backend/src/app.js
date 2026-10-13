'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');

const { createPurchaseRoutes } = require('./routes/purchase.routes');
const { createApprovalRoutes } = require('./routes/approval.routes');
const { createPaymentRoutes } = require('./routes/payment.routes');
const { createMandateRoutes } = require('./routes/mandate.routes');
const { createVendorService } = require('./services/vendor.service');
const { createAuditService } = require('./services/audit.service');
const { createPurchaseStore } = require('./services/purchaseStore.service');

function createApp({
  vendorService = createVendorService(),
  auditService = createAuditService(),
  purchaseStore = createPurchaseStore(),
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') || req.body?.requestId || randomUUID();
    req.id = requestId;
    req.requestId = requestId;
    res.set('X-Request-Id', requestId);
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        service: 'mandate-api',
      },
    });
  });

  const purchaseRouter = createPurchaseRoutes({ vendorService, auditService, purchaseStore });
  app.use('/api', purchaseRouter);
  app.use('/api', createApprovalRoutes());
  app.use('/api', createPaymentRoutes());
  app.use('/api', createMandateRoutes());

  app.use((req, res, next) => {
    const error = new Error('Route not found.');
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    next(error);
  });

  app.use((err, req, res, next) => {
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    const code = err.code || (statusCode === 404 ? 'NOT_FOUND' : statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED');
    const message = statusCode >= 500 ? 'An unexpected server error occurred.' : (err.message || 'Request failed.');

    const payload = {
      success: false,
      error: {
        code,
        message,
      },
    };

    if (statusCode === 400 && Array.isArray(err.details) && err.details.length > 0) {
      payload.error.details = err.details;
    }

    if (statusCode === 404) {
      payload.error.details = [{ field: req.path, message: 'The requested route does not exist.' }];
    }

    res.status(statusCode).json(payload);
  });

  return app;
}

module.exports = { createApp };
