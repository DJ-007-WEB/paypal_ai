'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');
const { createApp } = require('./app');
const { createVendorService } = require('./services/vendor.service');
const { createPurchaseStore } = require('./services/purchaseStore.service');
const { createAuditService } = require('./services/audit.service');

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'mandate';

async function start() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is required. Add it to backend/.env before starting Mandate.');
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  await db.command({ ping: 1 });

  const vendorCollection = db.collection('vendorOffers');
  await vendorCollection.createIndex({ offerId: 1 }, { unique: true });
  await vendorCollection.createIndex({ productId: 1, active: 1 });

  const purchaseCollection = db.collection('purchaseRecords');
  const auditCollection = db.collection('auditEvents');
  await purchaseCollection.createIndex({ purchaseId: 1 }, { unique: true });
  await purchaseCollection.createIndex({ createdAt: -1 });
  await auditCollection.createIndex({ eventId: 1 }, { unique: true });
  await auditCollection.createIndex({ requestId: 1, timestamp: 1 });
  await auditCollection.createIndex({ purchaseId: 1, timestamp: 1 });

  const app = createApp({
    vendorService: createVendorService({ collection: vendorCollection }),
    purchaseStore: createPurchaseStore({ collection: purchaseCollection }),
    auditService: createAuditService({ collection: auditCollection }),
  });

  const server = app.listen(PORT, () => {
    console.log(`Mandate API listening on http://localhost:${PORT}`);
    console.log(`MongoDB connected; database: ${DB_NAME}`);
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
