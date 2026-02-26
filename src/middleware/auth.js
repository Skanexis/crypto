const config = require("../config");
const crypto = require("crypto");

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function requireAdminApiKey(req, res, next) {
  const key = req.get("x-api-key");
  if (!key || !safeEqualText(key, config.adminApiKey)) {
    res.status(401).json({
      error: "Unauthorized",
      message: "x-api-key non valida",
    });
    return;
  }
  next();
}

module.exports = {
  requireAdminApiKey,
};
