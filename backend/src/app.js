'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');

const { createPurchaseRoutes } = require('./routes/purchase.routes');
const { createVendorRoutes } = require('./routes/vendor.routes');
const { createApprovalRoutes } = require('./routes/approval.routes');
const { createPaymentRoutes } = require('./routes/payment.routes');
const { createMandateRoutes } = require('./routes/mandate.routes');
const { createVendorService } = require('./services/vendor.service');
const { createAuditService } = require('./services/audit.service');
const { createPurchaseStore } = require('./services/purchaseStore.service');

function createApp({
  vendorService,
  auditService = createAuditService(),
  purchaseStore = createPurchaseStore(),
} = {}) {
  const app = express();

  app.disable('x-powered-by');

  // Restrict browser access to explicitly configured frontend origins.
  // Defaults cover local Vite development; deployments should set FRONTEND_ORIGIN.
  const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type,X-Request-Id');
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(origin && !allowedOrigins.includes(origin) ? 403 : 204);
    }
    return next();
  });


  app.use(express.json({ limit: '1mb' }));

  // Log every API request with status, duration, and a correlation ID.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const requestId = req.get('x-request-id') || randomUUID();
    req.id = requestId;
    req.requestId = requestId;
    res.set('X-Request-Id', requestId);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.log('[' + new Date().toISOString() + '] ' + req.method + ' ' + req.originalUrl + ' ' + res.statusCode + ' ' + durationMs.toFixed(1) + 'ms requestId=' + requestId);
    });
    next();
  });

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
  app.use('/api', createVendorRoutes({ vendorService }));
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

    const requestId = req.requestId || req.id || null;
    if (statusCode >= 500) {
      console.error('[API ERROR] requestId=' + requestId + ' ' + req.method + ' ' + req.originalUrl);
      console.error(err && err.stack ? err.stack : err);
    }
    const message = statusCode >= 500
      ? (process.env.NODE_ENV === 'development' ? (err.message || 'Internal server error.') : 'An unexpected server error occurred.')
      : (err.message || 'Request failed.');

    const payload = {
      success: false,
      error: {
        code,
        message,
        requestId,
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
