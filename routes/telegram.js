const express = require('express');
const router = express.Router();

// GET /api/telegram/status
router.get('/status', (req, res) => {
  res.json({ status: 'Telegram bot is running' });
});

module.exports = router;
