'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Single authoritative request-ID middleware (§13).
 * - Generates a server-side request ID.
 * - Accepts an optional client correlation ID (X-Request-Id or requestId body field),
 *   validates/bounds it, and keeps it distinct from the authoritative internal ID.
 * - Removes the previous duplicate request-ID middleware behaviour.
 */
function isValidClientCorrelationId(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 1 || v.length > 128) return false;
  return /^[A-Za-z0-9._:-]+$/.test(v);
}

function requestIdMiddleware(req, res, next) {
  const clientSupplied = req.get('x-request-id') || (req.body && typeof req.body.requestId === 'string' ? req.body.requestId : null);
  const serverId = randomUUID();
  req.id = serverId;
  req.requestId = serverId;
  if (clientSupplied && isValidClientCorrelationId(clientSupplied)) {
    req.clientRequestId = clientSupplied.trim();
  } else {
    req.clientRequestId = null;
  }
  res.set('X-Request-Id', serverId);
  next();
}

module.exports = { requestIdMiddleware, isValidClientCorrelationId };
