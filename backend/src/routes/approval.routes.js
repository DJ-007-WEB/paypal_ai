'use strict';

const express = require('express');

function createApprovalRoutes() {
  const router = express.Router();

  router.all('/approvals*', (req, res) => {
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Approval execution is not implemented in this milestone. Approval requires explicit human action, existing purchase validation, and a separate authorization decision.',
      },
    });
  });

  return router;
}

module.exports = { createApprovalRoutes };
