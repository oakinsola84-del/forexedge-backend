const express = require('express');
const router = express.Router();

// GET /api/stats — public performance stats
router.get('/', (req, res) => {
  res.json({
    totalSignals: 0,
    winRate: 0,
    message: 'Stats endpoint coming soon',
  });
});

module.exports = router;
