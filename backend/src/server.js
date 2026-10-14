'use strict';

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');
const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { createVendorService } = require('./services/vendor.service');
const { createPurchaseStore } = require('./services/purchaseStore.service');
const { createAuditService } = require('./services/audit.service');

async function start() {
  const config = loadConfig(process.env);

  if (!config.MONGODB_URI) {
    throw new Error('MONGODB_URI is required. Add it to backend/.env before starting Mandate.');
  }

  // TLS for database and external APIs: Atlas URIs negotiate TLS; enforce for production.
  const clientOptions = {};
  if (config.isProd && !config.MONGODB_URI.includes('tls=')) {
    clientOptions.tls = true;
  }
  const client = new MongoClient(config.MONGODB_URI, clientOptions);
  await client.connect();
  const db = client.db(config.MONGODB_DB_NAME);
  await db.command({ ping: 1 });

  // Tenant-aware indexes (§9.3). Do NOT drop the legacy global unique offerId index
  // blindly — run scripts/migrate-tenant-isolation.js dry-run first, reconcile
  // duplicates, back up, then build compound indexes. This startup ensures the
  // compound indexes exist without dropping legacy ones automatically.
  const vendorCollection = db.collection('vendorOffers');
  try { await vendorCollection.createIndex({ tenantId: 1, offerId: 1 }, { unique: true }); } catch (err) { console.warn('[DB] vendor compound index skipped (run migration):', err.message); }
  try { await vendorCollection.createIndex({ tenantId: 1, productId: 1, active: 1 }); } catch (err) { console.warn('[DB] vendor query index skipped:', err.message); }

  const purchaseCollection = db.collection('purchaseRecords');
  const auditCollection = db.collection('auditEvents');
  try { await purchaseCollection.createIndex({ tenantId: 1, purchaseId: 1 }, { unique: true }); } catch (err) { console.warn('[DB] purchase compound index skipped (run migration):', err.message); }
  try { await purchaseCollection.createIndex({ tenantId: 1, createdAt: -1 }); } catch (err) { console.warn('[DB] purchase history index skipped:', err.message); }
  try { await auditCollection.createIndex({ eventId: 1 }, { unique: true }); } catch { /* exists */ }
  try { await auditCollection.createIndex({ tenantId: 1, requestId: 1, timestamp: 1 }); } catch (err) { console.warn('[DB] audit request index skipped:', err.message); }
  try { await auditCollection.createIndex({ tenantId: 1, purchaseId: 1, timestamp: 1 }); } catch (err) { console.warn('[DB] audit purchase index skipped:', err.message); }

  // Identity / workspace collections (§7)
  const userCollection = db.collection('users');
  const tenantCollection = db.collection('tenants');
  const membershipCollection = db.collection('memberships');
  const sessionCollection = db.collection('sessions');
  const gmailCollection = db.collection('gmailConnections');
  try { await userCollection.createIndex({ userId: 1 }, { unique: true }); } catch { /* ignore */ }
  try { await userCollection.createIndex({ googleSubject: 1 }, { unique: true }); } catch { /* ignore */ }
  try { await tenantCollection.createIndex({ tenantId: 1 }, { unique: true }); } catch { /* ignore */ }
  try { await membershipCollection.createIndex({ tenantId: 1, userId: 1 }, { unique: true }); } catch { /* ignore */ }
  try { await membershipCollection.createIndex({ userId: 1, status: 1 }); } catch { /* ignore */ }
  try { await sessionCollection.createIndex({ sessionId: 1 }, { unique: true }); } catch { /* ignore */ }
  try { await sessionCollection.createIndex({ userId: 1 }); } catch { /* ignore */ }
  // TTL on sessions via absolute expiry (background cleanup; absolute enforced on read regardless)
  try { await sessionCollection.createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* TTL best-effort */ }
  try { await gmailCollection.createIndex({ tenantId: 1 }, { unique: true }); } catch { /* ignore */ }

  // Least-privilege note: deploy with a runtime Mongo user that can read/write only
  // the collections above. Use a separate migration credential for schema changes.

  const app = createApp({
    config,
    vendorCollection,
    purchaseCollection,
    auditCollection,
    userCollection,
    tenantCollection,
    membershipCollection,
    sessionCollection,
    gmailCollection,
    vendorService: createVendorService({ collection: vendorCollection }),
    purchaseStore: createPurchaseStore({ collection: purchaseCollection }),
    auditService: createAuditService({ collection: auditCollection }),
  });

  const server = app.listen(config.PORT, () => {
    console.log(`Mandate API listening on http://localhost:${config.PORT}`);
    // Never log the MongoDB URI.
    console.log(`MongoDB connected; database: ${config.MONGODB_DB_NAME}`);
    try {
      console.log(`[CONFIG] integrations=${JSON.stringify(config.getIntegrationStatus())}`);
    } catch { /* ignore */ }
  });

  const shutdown = async () => {
    server.close(async () => {
      await client.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start Mandate API:', error.message);
  process.exit(1);
});
