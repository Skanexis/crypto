const express = require("express");
const QRCode = require("qrcode");
const { requireAdminApiKey } = require("../middleware/auth");
const { createRateLimit } = require("../middleware/rate-limit");
const {
  createInvoice,
  listPendingInvoices,
  getInvoiceStatusById,
  getInvoiceWithPaymentsByToken,
  getInvoiceWithPaymentsById,
  markInvoicePaid,
  deleteAllInvoices,
} = require("../services/invoices.service");
const { fetchRatesUsd } = require("../services/rates.service");
const {
  isValidWebhookSignature,
  processPaymentWebhook,
} = require("../services/payments.service");
const { notifyInvoicePaid } = require("../services/notifications.service");
const { verifyPendingPayments } = require("../services/payment-verifier.service");

const router = express.Router();

const publicRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 120 });
const webhookRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 300 });

function paymentQrText(payment) {
  if (payment.currency === "BTC") {
    return `bitcoin:${payment.walletAddress}?amount=${payment.expectedAmountCrypto}`;
  }
  if (payment.currency === "ETH") {
    return `ethereum:${payment.walletAddress}?value=${payment.expectedAmountCrypto}`;
  }
  return `${payment.walletAddress}?amount=${payment.expectedAmountCrypto}&network=${payment.network}`;
}

async function withQrCodes(payments) {
  const mapped = await Promise.all(
    payments.map(async (payment) => {
      const qrText = paymentQrText(payment);
      const qrDataUrl = await QRCode.toDataURL(qrText, {
        width: 360,
        margin: 1,
      });
      return {
        ...payment,
        qrText,
        qrDataUrl,
      };
    }),
  );
  return mapped;
}

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "crypto-invoice-bot",
    now: new Date().toISOString(),
  });
});

router.get("/rates", publicRateLimit, async (_req, res, next) => {
  try {
    const ratesUsd = await fetchRatesUsd();
    res.json({
      base: "USD",
      ratesUsd,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/invoices", requireAdminApiKey, async (req, res, next) => {
  try {
    const invoice = await createInvoice({
      amountUsd: req.body.amount_usd,
      allowedCurrencies: req.body.allowed_currencies,
      telegramUserId: req.body.telegram_user_id,
      createdByAdminId: req.body.created_by_admin_id || "api_admin",
    });
    res.status(201).json({
      invoice,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/invoices/pending", requireAdminApiKey, (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 20);
    const invoices = listPendingInvoices(limit);
    res.json({
      invoices,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/invoices/delete-all", requireAdminApiKey, (req, res, next) => {
  try {
    if (String(req.body.confirm || "").trim().toUpperCase() !== "DELETE_ALL") {
      res.status(400).json({
        error: "Bad Request",
        message: "Conferma mancante. Invia confirm=DELETE_ALL",
      });
      return;
    }

    const summary = deleteAllInvoices();
    res.json({
      ok: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/invoices/:token", publicRateLimit, async (req, res, next) => {
  try {
    const invoice = getInvoiceWithPaymentsByToken(req.params.token);
    if (!invoice) {
      res.status(404).json({
        error: "Not Found",
        message: "Fattura non trovata",
      });
      return;
    }

    const paymentsWithQr = await withQrCodes(invoice.payments);
    res.json({
      invoice: {
        id: invoice.id,
        token: invoice.token,
        amountUsd: invoice.amountUsd,
        allowedCurrencies: invoice.allowedCurrencies,
        status: invoice.status,
        expiresAt: invoice.expiresAt,
        expired: invoice.expired,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        payments: paymentsWithQr,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/invoices/id/:invoiceId/status",
  requireAdminApiKey,
  (req, res, next) => {
    try {
      const status = getInvoiceStatusById(req.params.invoiceId);
      if (!status) {
        res.status(404).json({
          error: "Not Found",
          message: "Fattura non trovata",
        });
        return;
      }
      res.json({
        status,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/invoices/:invoiceId/mark-paid",
  requireAdminApiKey,
  async (req, res, next) => {
    try {
      const result = markInvoicePaid({
        invoiceId: req.params.invoiceId,
        currency: req.body.currency,
        txHash: req.body.tx_hash,
        confirmations: req.body.confirmations,
        paidAmountCrypto: req.body.paid_amount_crypto,
      });
      if (result.changed) {
        await notifyInvoicePaid(
          result.invoice,
          String(req.body.currency || "").toUpperCase(),
          {
            txHash: req.body.tx_hash || null,
            source: "manuale-admin",
          },
        );
      }
      res.json({
        invoice: result.invoice,
        changed: result.changed,
        reason: result.reason,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post("/payments/webhook", webhookRateLimit, async (req, res, next) => {
  try {
    const signature = req.get("x-webhook-signature");
    const valid = isValidWebhookSignature(req.rawBody, signature);
    if (!valid) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Firma webhook non valida",
      });
      return;
    }

    const result = processPaymentWebhook(req.body);
    if (result.processed && req.body.currency) {
      const invoice = getInvoiceWithPaymentsById(result.invoiceId);
      if (invoice) {
        await notifyInvoicePaid(invoice, String(req.body.currency).toUpperCase(), {
          txHash: req.body.txHash || req.body.tx_hash || null,
          source: "webhook-provider",
        });
      }
    }
    res.json({
      ok: true,
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/payments/verify-now", requireAdminApiKey, async (_req, res, next) => {
  try {
    const summary = await verifyPendingPayments();
    res.json({
      ok: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
