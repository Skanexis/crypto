const buckets = new Map();

function createRateLimit({ windowMs, max }) {
  return function rateLimit(req, res, next) {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();

    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > max) {
      res.status(429).json({
        error: "Too Many Requests",
        message: "Limite richieste superato, riprova tra poco.",
      });
      return;
    }
    next();
  };
}

module.exports = {
  createRateLimit,
};
