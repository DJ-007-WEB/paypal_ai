'use strict';

const crypto = require('node:crypto');

/**
 * Gmail mailbox OAuth connection routes (§5.2).
 * - Separate consent + dedicated callback, state + PKCE, exact redirect allowlist.
 * - Durable Mongo-backed transaction store when available.
 * - Narrowest scopes; bound to tenantId + connectedByUserId + Google sub.
 * - Encrypted refresh tokens at rest; never exposed to frontend.
 * - Real exchange + identity match; failures are explicit, never fake success.
 */
function createGmailRoutes({ config, gmailService, tenantService, userService, auditService, oauthTransactionStore } = {}) {
  const express = require('express');
  const router = express.Router();
  if (!oauthTransactionStore) throw new Error('Gmail routes require oauthTransactionStore.');
  const transactions = oauthTransactionStore;

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
    if (!membership || membership.status !== 'active' || !(membership.permissions || []).includes(permission)) {
      const err = new Error('You do not have permission to perform this action.');
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }
  }

  function frontendSettingsUrl(config, query) {
    const base = String(config.FRONTEND_BASE_URL || '').replace(/\/$/, '');
    return `${base}/app/settings/business?${new URLSearchParams(query).toString()}`;
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
        return res.json({ success: true, data: { enabled: false, connected: false, encryptionConfigured: false } });
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
          connectedAt: conn ? conn.connectedAt || null : null,
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
      const transactionId = await transactions.create({
        kind: 'gmail',
        state,
        codeVerifier,
        tenantId: req.auth.tenantId,
        userId: req.user.userId,
      });
      res.set('Set-Cookie', `mandate.gmail_tx=${encodeURIComponent(transactionId)}; Path=/api/integrations/google-gmail; HttpOnly; Max-Age=600; SameSite=Lax${config.SESSION_COOKIE_SECURE ? '; Secure' : ''}`);
      const params = new URLSearchParams({
        client_id: config.GOOGLE_GMAIL_CLIENT_ID,
        redirect_uri: config.GOOGLE_GMAIL_REDIRECT_URI,
        response_type: 'code',
        scope: `openid email ${config.GOOGLE_GMAIL_SCOPES}`.trim(),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent select_account',
        include_granted_scopes: 'true',
      });
      try {
        await auditService.recordEvent({ tenantId: req.auth.tenantId, eventType: 'GMAIL_CONNECT_STARTED', actorId: req.user.userId, metadata: {} });
      } catch { /* ignore */ }
      return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    } catch (err) { next(err); }
  });

  // Callback — dedicated, server-side exchange only.
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
      const { code, state, error: providerError } = req.query || {};
      if (providerError) return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'cancelled' }));
      if (!transactionId || !code || typeof code !== 'string' || !state || typeof state !== 'string') {
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'invalid_transaction' }));
      }
      const tx = await transactions.consume({ transactionId, state, kind: 'gmail' });
      if (!tx || !tx.tenantId || !tx.userId) {
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'expired_transaction' }));
      }

      const user = await userService.findById(tx.userId);
      if (!user || user.status !== 'active' || !user.googleSubject) {
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'user_unavailable' }));
      }

      let result;
      try {
        result = await gmailService.exchangeCode({
          code,
          codeVerifier: tx.codeVerifier,
          state,
          redirectUri: config.GOOGLE_GMAIL_REDIRECT_URI,
        });
      } catch (err) {
        try {
          await auditService.recordEvent({ tenantId: tx.tenantId, eventType: 'GMAIL_CONNECT_FAILED', actorId: tx.userId, metadata: { code: err.code || 'GMAIL_OAUTH_FAILED' } });
        } catch { /* ignore */ }
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'oauth_failed' }));
      }

      // Identity check: the mailbox must belong to the signed-in Google account,
      // and Google must assert a verified email.
      if (result.claims.sub !== user.googleSubject || result.claims.emailVerified !== true) {
        try {
          await auditService.recordEvent({ tenantId: tx.tenantId, eventType: 'GMAIL_IDENTITY_MISMATCH', actorId: tx.userId, metadata: {} });
        } catch { /* ignore */ }
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'identity_mismatch' }));
      }

      try {
        await gmailService.saveConnection({
          tenantId: tx.tenantId,
          connectedByUserId: tx.userId,
          googleSubject: result.claims.sub,
          mailboxEmail: result.claims.email,
          scopes: result.scopes,
          refreshToken: result.refreshToken,
          accessToken: result.accessToken,
          accessTokenExpiresAt: result.accessTokenExpiresAt,
        });
      } catch (err) {
        try {
          await auditService.recordEvent({ tenantId: tx.tenantId, eventType: 'GMAIL_CONNECT_FAILED', actorId: tx.userId, metadata: { code: err.code || 'GMAIL_SAVE_FAILED' } });
        } catch { /* ignore */ }
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: err.code === 'GMAIL_REFRESH_TOKEN_MISSING' ? 'refresh_token_missing' : 'save_failed' }));
      }

      try {
        await auditService.recordEvent({ tenantId: tx.tenantId, eventType: 'GMAIL_CONNECTED', actorId: tx.userId, metadata: {} });
      } catch { /* ignore */ }
      return res.redirect(302, frontendSettingsUrl(config, { gmail: 'connected' }));
    } catch (err) {
      // Callback is a browser navigation; never leak provider details.
      try {
        return res.redirect(302, frontendSettingsUrl(config, { gmail: 'error', reason: 'unexpected' }));
      } catch {
        return next(err);
      }
    }
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
        await auditService.recordEvent({
          tenantId: req.auth.tenantId,
          eventType: 'GMAIL_DISCONNECTED',
          actorId: req.user.userId,
          metadata: { revocation: result ? result.revocation : 'no-token' },
        });
      } catch { /* ignore */ }
      return res.json({
        success: true,
        data: {
          disconnected: true,
          status: result ? result.status : 'disconnected',
          revocation: result ? result.revocation : 'no-token',
        },
      });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createGmailRoutes };
