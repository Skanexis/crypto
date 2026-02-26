const express = require("express");
const config = require("../config");
const { requireAdminApiKey } = require("../middleware/auth");
const { botEnabled, handleTelegramUpdate, setWebhook } = require("../services/telegram.service");

const router = express.Router();

router.post("/webhook/:secret", async (req, res) => {
  if (!botEnabled()) {
    res.status(503).json({
      error: "Bot Disabled",
      message: "TELEGRAM_BOT_TOKEN non configurato",
    });
    return;
  }

  if (req.params.secret !== config.botWebhookSecret) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Secret non valido",
    });
    return;
  }

  res.sendStatus(200);
  await handleTelegramUpdate(req.body);
});

router.post("/set-webhook", requireAdminApiKey, async (_req, res, next) => {
  try {
    const result = await setWebhook();
    res.json({
      ok: true,
      result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
