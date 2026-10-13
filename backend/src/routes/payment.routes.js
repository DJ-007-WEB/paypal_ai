'use strict';

const express = require('express');

function createPaymentRoutes() {
  const router = express.Router();

  router.all('/payments*', (req, res) => {
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Payment execution is not implemented in this milestone. No real PayPal or payment authorization flow is active.',
      },
    });
  });

  return router;
}

module.exports = { createPaymentRoutes };
