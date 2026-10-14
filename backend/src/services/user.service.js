'use strict';

const crypto = require('node:crypto');

/**
 * User identity keyed by Google `sub` (§4.3).
 * Email is mutable and never the stable identity key.
 */
function createUserService({ collection = null } = {}) {
  const memory = new Map(); // userId -> user
  const subIndex = new Map(); // googleSubject -> userId

  function clone(user) {
    return user ? JSON.parse(JSON.stringify(user)) : null;
  }

  async function findById(userId) {
    if (!userId) return null;
    if (collection) {
      const doc = await collection.findOne({ userId });
      return clone(doc && (({ _id, ...rest }) => rest)(doc));
    }
    return clone(memory.get(userId) || null);
  }

  async function findByGoogleSub(googleSubject) {
    if (!googleSubject) return null;
    if (collection) {
      const doc = await collection.findOne({ googleSubject });
      return clone(doc && (({ _id, ...rest }) => rest)(doc));
    }
    const userId = subIndex.get(googleSubject);
    return clone((userId && memory.get(userId)) || null);
  }

  async function createFromOidc({ googleSubject, email, emailVerified, displayName }) {
    if (!googleSubject || typeof googleSubject !== 'string') throw new Error('googleSubject is required.');
    const now = new Date().toISOString();
    const userId = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const user = {
      userId,
      googleSubject,
      email: email || '',
      emailVerified: Boolean(emailVerified),
      displayName: displayName || '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };
    if (collection) {
      await collection.insertOne({ ...user });
    } else {
      memory.set(userId, { ...user });
      subIndex.set(googleSubject, userId);
    }
    return clone(user);
  }

  async function updateLogin(user, { email, emailVerified, displayName }) {
    const now = new Date().toISOString();
    const updated = {
      ...user,
      email: email !== undefined ? email : user.email,
      emailVerified: emailVerified !== undefined ? Boolean(emailVerified) : user.emailVerified,
      displayName: displayName !== undefined ? displayName : user.displayName,
      updatedAt: now,
      lastLoginAt: now,
    };
    if (collection) {
      await collection.updateOne({ userId: user.userId }, { $set: { email: updated.email, emailVerified: updated.emailVerified, displayName: updated.displayName, updatedAt: now, lastLoginAt: now } });
    } else {
      memory.set(user.userId, { ...updated });
    }
    return clone(updated);
  }

  async function findOrCreateFromOidc(claims) {
    const existing = await findByGoogleSub(claims.googleSubject);
    if (existing) {
      if (existing.status !== 'active') {
        const err = new Error('User account is disabled.');
        err.statusCode = 403;
        err.code = 'USER_DISABLED';
        throw err;
      }
      return updateLogin(existing, claims);
    }
    return createFromOidc(claims);
  }

  async function disable(userId) {
    const user = await findById(userId);
    if (!user) return null;
    const updated = { ...user, status: 'disabled', updatedAt: new Date().toISOString() };
    if (collection) {
      await collection.updateOne({ userId }, { $set: { status: 'disabled', updatedAt: updated.updatedAt } });
    } else {
      memory.set(userId, { ...updated });
    }
    return clone(updated);
  }

  async function ensureIndexes() {
    if (!collection) return;
    try {
      await collection.createIndex({ userId: 1 }, { unique: true });
      await collection.createIndex({ googleSubject: 1 }, { unique: true });
    } catch { /* index creation best-effort; server.js owns canonical indexes */ }
  }

  // Test harness seeding
  async function __seed(user) {
    const entry = { ...user };
    if (!entry.userId) entry.userId = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (collection) {
      await collection.insertOne({ ...entry });
    } else {
      memory.set(entry.userId, { ...entry });
      if (entry.googleSubject) subIndex.set(entry.googleSubject, entry.userId);
    }
    return clone(entry);
  }

  return { findById, findByGoogleSub, createFromOidc, updateLogin, findOrCreateFromOidc, disable, ensureIndexes, __seed };
}

module.exports = { createUserService };
