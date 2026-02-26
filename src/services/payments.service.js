const crypto = require("crypto");
const config = require("../config");
const {
  getInvoiceWithPaymentsById,
  getInvoiceWithPaymentsByToken,
  markInvoicePaid,
} = require("./invoices.service");

function isValidWebhookSignature(rawBody, signature) {
  if (!config.webhookHmacSecret) {
    return true;
  }
  if (!signature || !rawBody) {
    return false;
  }
  const digest = crypto
    .createHmac("sha256", config.webhookHmacSecret)
    .update(rawBody)
    .digest("hex");
  const signedHex = signature.replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]+$/i.test(signedHex) || signedHex.length !== digest.length) {
    return false;
  }
  const expected = Buffer.from(digest, "hex");
  const provided = Buffer.from(signedHex, "hex");
  if (expected.length !== provided.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, provided);
}

function resolveInvoice(payload) {
  if (payload.invoiceId) {
    return getInvoiceWithPaymentsById(String(payload.invoiceId));
  }
  if (payload.invoiceToken) {
    return getInvoiceWithPaymentsByToken(String(payload.invoiceToken));
  }
  return null;
}

function processPaymentWebhook(payload) {
  const invoice = resolveInvoice(payload);
  if (!invoice) {
    throw new Error("Fattura non trovata");
  }

  const currency = String(payload.currency || "").toUpperCase();
  const status = String(payload.status || "").toLowerCase();
  if (status !== "confirmed" && status !== "paid") {
    return {
      processed: false,
      reason: "Stato webhook non finale",
      invoiceId: invoice.id,
    };
  }

  const result = markInvoicePaid({
    invoiceId: invoice.id,
    currency,
    txHash: payload.txHash || payload.tx_hash || null,
    confirmations: Number(payload.confirmations || 1),
    paidAmountCrypto:
      payload.paidAmountCrypto !== undefined
        ? Number(payload.paidAmountCrypto)
        : payload.amount !== undefined
          ? Number(payload.amount)
          : null,
  });

  return result.changed
    ? {
        processed: true,
        invoiceId: result.invoice.id,
        status: result.invoice.status,
        txHash: payload.txHash || payload.tx_hash || null,
      }
    : {
        processed: false,
        reason: result.reason || "Pagamento non applicato",
        invoiceId: invoice.id,
        status: result.invoice?.status || invoice.status,
      };
}

module.exports = {
  isValidWebhookSignature,
  processPaymentWebhook,
};
