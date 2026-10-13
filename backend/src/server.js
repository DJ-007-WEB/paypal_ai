'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');
const { createApp } = require('./app');
const { createVendorService } = require('./services/vendor.service');

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

  const app = createApp({
    vendorService: createVendorService({ collection: vendorCollection }),
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
