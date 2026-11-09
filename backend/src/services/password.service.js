'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// scrypt parameters are stored implicitly in the hash prefix. Keep them stable
// so existing password hashes remain verifiable.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password is required.');
  }
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM,
  });
  return `scrypt$${salt}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const [scheme, salt, encoded] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !encoded) return false;
  let expected;
  try {
    expected = Buffer.from(encoded, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  try {
    const derived = Buffer.from(await scrypt(password, salt, expected.length, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM,
    }));
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Used when no local account exists so login timing does not reveal account
// existence. The value is never accepted because it is not stored on a user.
const DUMMY_SALT = 'mandate-login-timing-salt';
const DUMMY_HASH = `scrypt$${DUMMY_SALT}$${crypto.scryptSync(
  'not-a-real-password',
  DUMMY_SALT,
  KEY_LENGTH,
  { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM }
).toString('base64url')}`;

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };
