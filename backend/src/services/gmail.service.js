'use strict';

/**
 * Gmail mailbox OAuth connection (§5.2).
 * - Separate from sign-in; bound to tenantId + connectedByUserId + Google sub.
 * - Refresh tokens are stored encrypted; never exposed via APIs.
 * - Disabled until GOOGLE_GMAIL_ENABLED with credentials — fails closed.
 * - Real authorization-code exchange, ID-token identity check, refresh, and
 *   revocation; no placeholder success states.
 */

let cachedOidc = null;

async function getOidcConfiguration({ config }) {
  const cacheKey = `${config.GOOGLE_GMAIL_CLIENT_ID}|${config.GOOGLE_GMAIL_REDIRECT_URI}|${config.GOOGLE_GMAIL_ISSUER || 'https://accounts.google.com'}`;
  if (cachedOidc && cachedOidc.key === cacheKey) return cachedOidc.value;
  const { discovery, ClientSecretPost } = await import('openid-client');
  const secret = config.getSecrets ? config.getSecrets().GOOGLE_GMAIL_CLIENT_SECRET : '';
  const value = await discovery(
    new URL(config.GOOGLE_GMAIL_ISSUER || 'https://accounts.google.com'),
    config.GOOGLE_GMAIL_CLIENT_ID,
    { client_secret: secret, redirect_uris: [config.GOOGLE_GMAIL_REDIRECT_URI], response_types: ['code'] },
    ClientSecretPost(secret)
  );
  cachedOidc = { key: cacheKey, value };
  return value;
}

function createGmailService({ collection = null, cryptoService, config }) {
  const memory = new Map(); // tenantId -> connection

  function clone(conn) {
    if (!conn) return null;
    const copy = JSON.parse(JSON.stringify(conn));
    delete copy.encryptedRefreshToken;
    return copy;
  }

  function isEnabled() {
    return Boolean(config && config.GOOGLE_GMAIL_ENABLED);
  }

  function requireEnabled() {
    if (!isEnabled()) {
      const err = new Error('Gmail mailbox integration is not configured. Connect is disabled.');
      err.statusCode = 501;
      err.code = 'GMAIL_NOT_CONFIGURED';
      throw err;
    }
    if (!cryptoService || !cryptoService.isAvailable()) {
      const err = new Error('Token encryption is not configured. Gmail connect is disabled.');
      err.statusCode = 501;
      err.code = 'GMAIL_ENCRYPTION_NOT_CONFIGURED';
      throw err;
    }
  }

  async function getConnection(tenantId) {
    if (!tenantId) throw new Error('tenantId is required.');
    if (collection) {
      const doc = await collection.findOne({ tenantId });
      return clone(doc && (({ _id, ...rest }) => rest)(doc));
    }
    return clone(memory.get(tenantId) || null);
  }

  // Internal: fetch raw record including encrypted material (service/worker only)
  async function getConnectionInternal(tenantId) {
    if (collection) {
      const doc = await collection.findOne({ tenantId });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return JSON.parse(JSON.stringify(rest));
    }
    const rec = memory.get(tenantId);
    return rec ? JSON.parse(JSON.stringify(rec)) : null;
  }

  async function saveConnection({ tenantId, connectedByUserId, googleSubject, mailboxEmail, scopes, refreshToken, accessToken = null, accessTokenExpiresAt = null }) {
    requireEnabled();
    if (!tenantId) throw new Error('tenantId is required.');
    if (!connectedByUserId) throw new Error('connectedByUserId is required.');
    if (!mailboxEmail) throw new Error('mailboxEmail is required.');
    if (!refreshToken) {
      const err = new Error('Google did not return a refresh token. Revoke the app grant and reconnect.');
      err.statusCode = 502;
      err.code = 'GMAIL_REFRESH_TOKEN_MISSING';
      throw err;
    }
    const now = new Date().toISOString();
    const encryptedRefreshToken = cryptoService.encrypt(refreshToken);
    const record = {
      tenantId,
      connectedByUserId,
      googleSubject: googleSubject || null,
      mailboxEmail: String(mailboxEmail).trim().toLowerCase(),
      scopes: Array.isArray(scopes) ? [...scopes] : [],
      status: 'connected',
      encryptedRefreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt || null,
      connectedAt: now,
      updatedAt: now,
    };
    if (collection) {
      await collection.updateOne({ tenantId }, { $set: record, $setOnInsert: { createdAt: now } }, { upsert: true });
    } else {
      const existing = memory.get(tenantId);
      memory.set(tenantId, { ...record, createdAt: existing?.createdAt || now });
    }
    return clone(record);
  }

  async function getDecryptedRefreshToken(tenantId) {
    const record = await getConnectionInternal(tenantId);
    if (!record || !record.encryptedRefreshToken) return null;
    return cryptoService.decrypt(record.encryptedRefreshToken);
  }

  async function exchangeCode({ code, codeVerifier, state, redirectUri }) {
    requireEnabled();
    if (!code || !codeVerifier || !state) throw new Error('OAuth code, verifier, and state are required.');
    const oidc = await getOidcConfiguration({ config });
    const currentUrl = new URL(redirectUri || config.GOOGLE_GMAIL_REDIRECT_URI);
    currentUrl.searchParams.set('code', code);
    currentUrl.searchParams.set('state', state);
    const { authorizationCodeGrant } = await import('openid-client');
    let tokens;
    try {
      tokens = await authorizationCodeGrant(oidc, currentUrl, {
        expectedState: state,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true,
      });
    } catch {
      const err = new Error('Google rejected the mailbox authorization. Please reconnect.');
      err.statusCode = 400;
      err.code = 'GMAIL_OAUTH_FAILED';
      throw err;
    }
    let claims = null;
    try { claims = tokens.claims ? tokens.claims() : null; } catch { claims = null; }
    if (!claims || !claims.sub || !claims.email || claims.email_verified !== true) {
      const err = new Error('Google did not return a verified mailbox identity.');
      err.statusCode = 400;
      err.code = 'GMAIL_IDENTITY_INVALID';
      throw err;
    }
    return {
      refreshToken: tokens.refresh_token || null,
      accessToken: tokens.access_token || null,
      accessTokenExpiresAt: tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null,
      scopes: String(tokens.scope || config.GOOGLE_GMAIL_SCOPES || '').split(/\s+/).filter(Boolean),
      claims: { sub: claims.sub, email: claims.email, emailVerified: claims.email_verified },
    };
  }

  async function refreshAccessToken(refreshToken) {
    requireEnabled();
    if (!refreshToken) throw new Error('refreshToken is required.');
    const oidc = await getOidcConfiguration({ config });
    const { refreshTokenGrant } = await import('openid-client');
    const tokens = await refreshTokenGrant(oidc, refreshToken);
    return { accessToken: tokens.access_token || null, expiresIn: tokens.expires_in || null };
  }

  async function revokeToken(token) {
    if (!token) return false;
    try {
      const response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function setStatus(tenantId, status) {
    if (!['connected', 'revoked', 'disconnected', 'error'].includes(status)) throw new Error('Invalid Gmail status.');
    const now = new Date().toISOString();
    if (collection) {
      await collection.updateOne({ tenantId }, { $set: { status, updatedAt: now } });
    } else {
      const existing = memory.get(tenantId);
      if (!existing) return null;
      memory.set(tenantId, { ...existing, status, updatedAt: now });
    }
    return getConnection(tenantId);
  }

  async function disconnect(tenantId) {
    let revocation = 'no-token';
    let refreshToken = null;
    try { refreshToken = await getDecryptedRefreshToken(tenantId); } catch { refreshToken = null; }
    if (refreshToken) revocation = (await revokeToken(refreshToken)) ? 'revoked' : 'revocation-failed';
    const now = new Date().toISOString();
    if (collection) {
      // Per retention policy: revoke + delete credential material
      await collection.updateOne({ tenantId }, { $set: { status: 'disconnected', encryptedRefreshToken: null, accessTokenExpiresAt: null, updatedAt: now } });
    } else {
      const existing = memory.get(tenantId);
      if (!existing) return null;
      memory.set(tenantId, { ...existing, status: 'disconnected', encryptedRefreshToken: null, accessTokenExpiresAt: null, updatedAt: now });
    }
    const result = await getConnection(tenantId);
    return result ? { ...result, revocation } : null;
  }

  async function ensureIndexes() {
    if (!collection) return;
    try { await collection.createIndex({ tenantId: 1 }, { unique: true }); } catch { /* best-effort */ }
  }

  return {
    isEnabled,
    requireEnabled,
    getConnection,
    getConnectionInternal,
    getDecryptedRefreshToken,
    saveConnection,
    exchangeCode,
    refreshAccessToken,
    revokeToken,
    setStatus,
    disconnect,
    ensureIndexes,
  };
}

module.exports = { createGmailService };
