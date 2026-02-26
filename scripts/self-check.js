const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const tempDbPath = path.join(
  process.cwd(),
  "data",
  `self-check-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`,
);

process.env.DATABASE_PATH = tempDbPath;
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";
process.env.USDT_WALLET_ADDRESS =
  process.env.USDT_WALLET_ADDRESS || "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
process.env.BTC_WALLET_ADDRESS =
  process.env.BTC_WALLET_ADDRESS || "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
process.env.ETH_WALLET_ADDRESS =
  process.env.ETH_WALLET_ADDRESS || "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
process.env.USDT_NETWORK = process.env.USDT_NETWORK || "TRC20";
process.env.PAYMENT_WEBHOOK_HMAC_SECRET =
  process.env.PAYMENT_WEBHOOK_HMAC_SECRET || "self-check-secret";

const { db } = require("../src/db");
const { createInvoice, markInvoicePaid } = require("../src/services/invoices.service");
const { processPaymentWebhook, isValidWebhookSignature } = require("../src/services/payments.service");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const invA = await createInvoice({
    amountUsd: 100,
    allowedCurrencies: ["ETH"],
    telegramUserId: null,
    createdByAdminId: "self-check",
  });
  const invB = await createInvoice({
    amountUsd: 100,
    allowedCurrencies: ["ETH"],
    telegramUserId: null,
    createdByAdminId: "self-check",
  });

  const amountA = invA.payments.find((p) => p.currency === "ETH").expectedAmountCrypto;
  const amountB = invB.payments.find((p) => p.currency === "ETH").expectedAmountCrypto;
  assert(amountA !== amountB, "Expected unique ETH amounts for two open invoices");

  const paid1 = markInvoicePaid({
    invoiceId: invA.id,
    currency: "ETH",
    txHash: "0xselfcheck0001",
    confirmations: 3,
    paidAmountCrypto: amountA,
  });
  assert(paid1.changed === true, "First markInvoicePaid should change invoice");

  const paid2 = markInvoicePaid({
    invoiceId: invA.id,
    currency: "ETH",
    txHash: "0xselfcheck0001",
    confirmations: 3,
    paidAmountCrypto: amountA,
  });
  assert(paid2.changed === false, "Second markInvoicePaid should be idempotent");
  assert(paid2.reason === "invoice_not_pending", "Expected invoice_not_pending reason");

  const webhookRes = processPaymentWebhook({
    invoiceId: invA.id,
    currency: "ETH",
    status: "confirmed",
    txHash: "0xselfcheck0001",
    confirmations: 6,
    amount: amountA,
  });
  assert(webhookRes.processed === false, "Webhook should not re-process finalized invoice");

  const invGrace = await createInvoice({
    amountUsd: 20,
    allowedCurrencies: ["ETH"],
    telegramUserId: null,
    createdByAdminId: "self-check",
  });
  const graceAmount = invGrace.payments.find((p) => p.currency === "ETH").expectedAmountCrypto;
  db.prepare("UPDATE invoices SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60 * 1000).toISOString(),
    invGrace.id,
  );
  const withinGrace = markInvoicePaid({
    invoiceId: invGrace.id,
    currency: "ETH",
    txHash: "0xselfcheck0002",
    confirmations: 3,
    paidAmountCrypto: graceAmount,
  });
  assert(withinGrace.changed === true, "Invoice within grace should be payable");

  const invExpired = await createInvoice({
    amountUsd: 21,
    allowedCurrencies: ["ETH"],
    telegramUserId: null,
    createdByAdminId: "self-check",
  });
  const expiredAmount = invExpired.payments.find((p) => p.currency === "ETH").expectedAmountCrypto;
  db.prepare("UPDATE invoices SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    invExpired.id,
  );
  const outsideGrace = markInvoicePaid({
    invoiceId: invExpired.id,
    currency: "ETH",
    txHash: "0xselfcheck0003",
    confirmations: 3,
    paidAmountCrypto: expiredAmount,
  });
  assert(outsideGrace.changed === false, "Invoice outside grace should not be payable");
  assert(outsideGrace.reason === "invoice_expired", "Expected invoice_expired reason");

  const body = JSON.stringify({ hello: "world" });
  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.PAYMENT_WEBHOOK_HMAC_SECRET)
      .update(body)
      .digest("hex");
  assert(isValidWebhookSignature(body, signature), "Expected webhook signature validation to pass");
  assert(!isValidWebhookSignature(body, "sha256=00"), "Expected webhook signature validation to fail");

  console.log("Self-check passed");
}

run()
  .catch((error) => {
    console.error("Self-check failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      db.close();
    } catch (_error) {
      // ignore
    }
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${tempDbPath}${suffix}`;
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    } catch (_error) {
      // ignore cleanup errors
    }
  });
