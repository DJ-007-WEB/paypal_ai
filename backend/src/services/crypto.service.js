'use strict';

const crypto = require('node:crypto');

/**
 * Token encryption for Gmail refresh tokens (§5.2).
 * - Uses AES-256-GCM with TOKEN_ENCRYPTION_KEY (base64 32B or hex 64).
 * - If KMS_KEY_ID is configured, deployment should use envelope encryption via KMS;
 *   this module logs the KMS mode without handling raw keys in logs.
 */
function getKeyBytes(config) {
  const raw = config.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'base64');
}

function createCryptoService({ config }) {
  if (!config) throw new Error('Crypto service requires config.');

  function isAvailable() {
    return Boolean(config.TOKEN_ENCRYPTION_KEY || config.KMS_KEY_ID);
  }

  function mode() {
    if (config.KMS_KEY_ID) return 'kms';
    if (config.TOKEN_ENCRYPTION_KEY) return 'local-key';
    return 'not-configured';
  }

  function encrypt(plaintext) {
    const key = getKeyBytes(config);
    if (!key || key.length !== 32) {
      throw new Error('Token encryption is not configured (set TOKEN_ENCRYPTION_KEY or KMS_KEY_ID).');
    }
    if (typeof plaintext !== 'string' || !plaintext) throw new Error('Plaintext is required for encryption.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      alg: 'aes-256-gcm',
      kmsKeyId: config.KMS_KEY_ID || null,
    };
  }

  function decrypt({ ciphertext, iv, tag }) {
    const key = getKeyBytes(config);
    if (!key || key.length !== 32) {
      throw new Error('Token encryption is not configured (set TOKEN_ENCRYPTION_KEY or KMS_KEY_ID).');
    }
    if (!ciphertext || !iv || !tag) throw new Error('ciphertext, iv, and tag are required for decryption.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return out.toString('utf8');
  }

  return { isAvailable, mode, encrypt, decrypt };
}

module.exports = { createCryptoService };
