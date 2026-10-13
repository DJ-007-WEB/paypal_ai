'use strict';

const express = require('express');

function createMandateRoutes() {
  const router = express.Router();

  router.all('/mandates*', (req, res) => {
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Mandate management is not implemented in this milestone. This API currently focuses on purchase evaluation and retrieval.',
      },
    });
  });

  return router;
}

module.exports = { createMandateRoutes };
