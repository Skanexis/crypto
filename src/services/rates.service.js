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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStaticRatesFromEnv() {
  const rawJson = process.env.STATIC_RATES_USD_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      const rates = {
        USDT: Number(parsed.USDT),
        BTC: Number(parsed.BTC),
        ETH: Number(parsed.ETH),
      };
      if (
        Number.isFinite(rates.USDT) &&
        rates.USDT > 0 &&
        Number.isFinite(rates.BTC) &&
        rates.BTC > 0 &&
        Number.isFinite(rates.ETH) &&
        rates.ETH > 0
      ) {
        return rates;
      }
    } catch (_error) {
      // Ignore malformed static JSON and fallback to external provider.
    }
  }

  const fromEnv = {
    USDT: Number(process.env.STATIC_RATE_USDT),
    BTC: Number(process.env.STATIC_RATE_BTC),
    ETH: Number(process.env.STATIC_RATE_ETH),
  };
  if (
    Number.isFinite(fromEnv.USDT) &&
    fromEnv.USDT > 0 &&
    Number.isFinite(fromEnv.BTC) &&
    fromEnv.BTC > 0 &&
    Number.isFinite(fromEnv.ETH) &&
    fromEnv.ETH > 0
  ) {
    return fromEnv;
  }

  return null;
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

async function fetchRatesUsd() {
  const staticRates = readStaticRatesFromEnv();
  if (staticRates) {
    rateCache = {
      loadedAt: Date.now(),
      ratesUsd: staticRates,
    };
    return staticRates;
  }

  const now = Date.now();
  if (rateCache.ratesUsd && now - rateCache.loadedAt < RATE_CACHE_MS) {
    return rateCache.ratesUsd;
  }

  const ids = Object.values(CURRENCY_META)
    .map((meta) => meta.coingeckoId)
    .join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;

  const attempts = 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
      },
    });
    lastStatus = response.status;
    if (response.ok) {
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

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      break;
    }

    const waitMs = 250 * 2 ** (attempt - 1);
    await sleep(waitMs);
  }

  if (rateCache.ratesUsd) {
    return rateCache.ratesUsd;
  }
  throw new Error(`Impossibile ottenere i tassi: ${lastStatus}`);
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
