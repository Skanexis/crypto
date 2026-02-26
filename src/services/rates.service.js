const RATE_CACHE_MS = 60 * 1000;

const CURRENCY_META = {
  USDT: { decimals: 6, coingeckoId: "tether" },
  BTC: { decimals: 8, coingeckoId: "bitcoin" },
  ETH: { decimals: 8, coingeckoId: "ethereum" },
};

let rateCache = {
  loadedAt: 0,
  ratesUsd: null,
};

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

async function fetchRatesUsd() {
  const now = Date.now();
  if (rateCache.ratesUsd && now - rateCache.loadedAt < RATE_CACHE_MS) {
    return rateCache.ratesUsd;
  }

  const ids = Object.values(CURRENCY_META)
    .map((meta) => meta.coingeckoId)
    .join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    if (rateCache.ratesUsd) {
      return rateCache.ratesUsd;
    }
    throw new Error(`Impossibile ottenere i tassi: ${response.status}`);
  }

  const payload = await response.json();
  const ratesUsd = {
    USDT: Number(payload.tether?.usd),
    BTC: Number(payload.bitcoin?.usd),
    ETH: Number(payload.ethereum?.usd),
  };

  for (const [currency, rate] of Object.entries(ratesUsd)) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Tasso non valido per ${currency}`);
    }
  }

  rateCache = {
    loadedAt: now,
    ratesUsd,
  };
  return ratesUsd;
}

async function convertUsdToCrypto(amountUsd, currency) {
  const normalized = String(currency || "").toUpperCase();
  const meta = CURRENCY_META[normalized];
  if (!meta) {
    throw new Error(`Valuta non supportata: ${currency}`);
  }

  const ratesUsd = await fetchRatesUsd();
  const rate = ratesUsd[normalized];
  const amountCrypto = roundTo(amountUsd / rate, meta.decimals);

  return {
    currency: normalized,
    rateUsd: rate,
    amountCrypto,
    decimals: meta.decimals,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  CURRENCY_META,
  fetchRatesUsd,
  convertUsdToCrypto,
};
