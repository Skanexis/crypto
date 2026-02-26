const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

function parseList(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const INVOICE_TTL_MINUTES = Number(process.env.INVOICE_TTL_MINUTES || 30);

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  databasePath:
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "data", "crypto_invoices.db"),
  adminApiKey: process.env.ADMIN_API_KEY || "change-me",
  adminTelegramIds: parseList(process.env.ADMIN_TELEGRAM_IDS),
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  botWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "telegram-webhook",
  webhookHmacSecret: process.env.PAYMENT_WEBHOOK_HMAC_SECRET || "",
  invoiceTtlMinutes: Number.isFinite(INVOICE_TTL_MINUTES)
    ? INVOICE_TTL_MINUTES
    : 30,
  autoVerifyPayments: parseBool(process.env.AUTO_VERIFY_PAYMENTS, true),
  verifyIntervalSeconds: parseNumber(process.env.VERIFY_INTERVAL_SECONDS, 45),
  paymentAmountTolerancePct: parseNumber(
    process.env.PAYMENT_AMOUNT_TOLERANCE_PCT,
    1,
  ),
  paymentAmountMaxOverPct: parseNumber(
    process.env.PAYMENT_AMOUNT_MAX_OVER_PCT,
    3,
  ),
  strictAmountMatch: parseBool(process.env.STRICT_AMOUNT_MATCH, true),
  paymentLateGraceMinutes: parseNumber(
    process.env.PAYMENT_LATE_GRACE_MINUTES,
    15,
  ),
  paymentEarlyMatchGraceSeconds: parseNumber(
    process.env.PAYMENT_EARLY_MATCH_GRACE_SECONDS,
    0,
  ),
  uniqueAmountMaxBumps: parseNumber(process.env.UNIQUE_AMOUNT_MAX_BUMPS, 2000),
  providerRequestTimeoutMs: parseNumber(
    process.env.PROVIDER_REQUEST_TIMEOUT_MS,
    10000,
  ),
  providerMaxRetries: parseNumber(process.env.PROVIDER_MAX_RETRIES, 2),
  providers: {
    etherscan: {
      apiUrl: process.env.ETHERSCAN_API_URL || "https://api.etherscan.io/v2/api",
      apiKey: process.env.ETHERSCAN_API_KEY || "",
      chainId: process.env.ETHERSCAN_CHAIN_ID || "1",
      minConfirmations: parseNumber(process.env.ETH_CONFIRMATIONS_MIN, 3),
      txScanLimit: parseNumber(process.env.ETH_TX_SCAN_LIMIT, 100),
    },
    tron: {
      apiUrl: process.env.TRON_API_URL || "https://api.trongrid.io",
      apiKey: process.env.TRON_API_KEY || "",
      usdtContract:
        process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      minConfirmations: parseNumber(process.env.TRON_CONFIRMATIONS_MIN, 20),
      txScanLimit: parseNumber(process.env.TRON_TX_SCAN_LIMIT, 100),
    },
    btc: {
      apiUrl: process.env.BTC_API_URL || "https://blockstream.info/api",
      minConfirmations: parseNumber(process.env.BTC_CONFIRMATIONS_MIN, 2),
      txScanLimit: parseNumber(process.env.BTC_TX_SCAN_LIMIT, 100),
    },
  },
  walletAddresses: {
    USDT: process.env.USDT_WALLET_ADDRESS || "",
    BTC: process.env.BTC_WALLET_ADDRESS || "",
    ETH: process.env.ETH_WALLET_ADDRESS || "",
  },
  networks: {
    USDT: process.env.USDT_NETWORK || "TRC20",
    BTC: process.env.BTC_NETWORK || "BTC",
    ETH: process.env.ETH_NETWORK || "ERC20",
  },
  ssl: {
    certPath: process.env.SSL_CERT_PATH || "",
    keyPath: process.env.SSL_KEY_PATH || "",
  },
};
