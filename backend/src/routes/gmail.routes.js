'use strict';

const crypto = require('node:crypto');

/**
 * Gmail mailbox OAuth connection routes (§5.2) — scaffold, disabled until configured.
 * - Separate consent + dedicated callback, state + PKCE, exact redirect allowlist.
 * - Narrowest scopes; bound to tenantId + connectedByUserId + google sub.
 * - Encrypted refresh tokens at rest; never exposed to frontend.
 */
function createGmailRoutes({ config, gmailService, tenantService, auditService } = {}) {
  const express = require('express');
  const router = express.Router();
  const txns = new Map(); // transactionId -> { state, codeVerifier, tenantId, userId, createdAt }

  function requireEnabled() {
    gmailService.requireEnabled();
  }

  async function requireMembership(req, tenantId) {
    const membership = await tenantService.getMembership({ tenantId, userId: req.user.userId });
    if (!membership || membership.status !== 'active') {
      const err = new Error('Workspace not found.');
      err.statusCode = 404;
      err.code = 'WORKSPACE_NOT_FOUND';
      throw err;
    }
    return membership;
  }

  function need(membership, permission) {
    if (!membership || !(membership.permissions || []).includes(permission)) {
      const err = new Error('You do not have permission to perform this action.');
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }
  }

  // Status (no tokens)
  router.get('/integrations/google-gmail/status', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      if (!gmailService.isEnabled()) {
        return res.json({ success: true, data: { enabled: false, connected: false } });
      }
      const conn = await gmailService.getConnection(req.auth.tenantId);
      return res.json({
        success: true,
        data: {
          enabled: true,
          connected: Boolean(conn && conn.status === 'connected'),
          mailboxEmail: conn ? conn.mailboxEmail : null,
          scopes: conn ? conn.scopes : [],
          status: conn ? conn.status : 'not-connected',
        },
      });
    } catch (err) { next(err); }
  });

  // Connect start — separate consent
  router.get('/integrations/google-gmail/connect', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      requireEnabled();
      const membership = await requireMembership(req, req.auth.tenantId);
      need(membership, 'gmail:connect');
      const state = crypto.randomBytes(32).toString('base64url');
      const codeVerifier = crypto.randomBytes(64).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const transactionId = crypto.randomUUID();
      txns.set(transactionId, { state, codeVerifier, tenantId: req.auth.tenantId, userId: req.user.userId, createdAt: Date.now() });
      res.set('Set-Cookie', `mandate.gmail_tx=${encodeURIComponent(transactionId)}; Path=/api/integrations/google-gmail; HttpOnly; Max-Age=600; SameSite=Lax${config.SESSION_COOKIE_SECURE ? '; Secure' : ''}`);
      const clientId = config.GOOGLE_GMAIL_CLIENT_ID;
      const redirectUri = config.GOOGLE_GMAIL_REDIRECT_URI;
      const scopes = config.GOOGLE_GMAIL_SCOPES;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: `openid email ${scopes}`.trim(),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent select_account',
      });
      try {
        await auditService.recordEvent({ tenantId: req.auth.tenantId, eventType: 'GMAIL_CONNECT_STARTED', actorId: req.user.userId, metadata: {} });
      } catch { /* ignore */ }
      return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    } catch (err) { next(err); }
  });

  // Callback — dedicated, server-side exchange only (scaffold; real exchange requires credentials)
  router.get('/integrations/google-gmail/callback', async (req, res, next) => {
    try {
      requireEnabled();
      const header = req.get('Cookie') || '';
      let transactionId = null;
      for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx !== -1 && part.slice(0, idx).trim() === 'mandate.gmail_tx') transactionId = decodeURIComponent(part.slice(idx + 1).trim());
      }
      res.set('Set-Cookie', 'mandate.gmail_tx=; Path=/api/integrations/google-gmail; HttpOnly; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      const { code, state } = req.query || {};
      if (!transactionId || !code || !state) {
        const err = new Error('Invalid Gmail OAuth transaction.');
        err.statusCode = 400;
        err.code = 'OAUTH_TRANSACTION_INVALID';
        throw err;
      }
      const tx = txns.get(transactionId);
      txns.delete(transactionId);
      if (!tx || Date.now() - tx.createdAt > 10 * 60 * 1000 || tx.state !== state) {
        const err = new Error('Gmail OAuth transaction has expired or was already used.');
        err.statusCode = 400;
        err.code = 'OAUTH_TRANSACTION_INVALID';
        throw err;
      }
      // NOTE: Real token exchange + mailbox email lookup happens here once credentials,
      // scopes, token encryption, and provider tests are configured. Until then, record
      // a safe not-configured outcome without claiming success.
      try {
        await auditService.recordEvent({ tenantId: tx.tenantId, eventType: 'GMAIL_CONNECT_CALLBACK', actorId: tx.userId, metadata: {} });
      } catch { /* ignore */ }
      const base = String(config.FRONTEND_BASE_URL || '').replace(/\/$/, '');
      return res.redirect(302, `${base}/app/settings/business?gmail=pending`);
    } catch (err) { next(err); }
  });

  // Disconnect / revocation
  router.post('/integrations/google-gmail/disconnect', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      requireEnabled();
      const membership = await requireMembership(req, req.auth.tenantId);
      need(membership, 'gmail:disconnect');
      const result = await gmailService.disconnect(req.auth.tenantId);
      try {
        await auditService.recordEvent({ tenantId: req.auth.tenantId, eventType: 'GMAIL_DISCONNECTED', actorId: req.user.userId, metadata: {} });
      } catch { /* ignore */ }
      return res.json({ success: true, data: { disconnected: true, status: result ? result.status : 'disconnected' } });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createGmailRoutes };
