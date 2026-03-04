const express = require("express");
const QRCode = require("qrcode");
const config = require("../config");
const { requireAdminApiKey } = require("../middleware/auth");
const { createRateLimit } = require("../middleware/rate-limit");
const {
  createInvoice,
  listPendingInvoices,
  listInvoices,
  getDashboardMetrics,
  getRiskMonitor,
  recordRiskMonitorSnapshot,
  listRiskMonitorHistory,
  listRiskAlertEvents,
  getInvoiceStatusByRef,
  getInvoiceWithPaymentsByToken,
  getInvoiceWithPaymentsById,
  getInvoiceAdminDetailsByRef,
  listRecentEvents,
  listRecentTransactions,
  getTransactionByRef,
  markInvoicePaid,
  deleteAllInvoices,
  deleteInvoiceByRef,
  resolveInvoiceIdByRef,
  isInvoiceExpired,
} = require("../services/invoices.service");
const { fetchRatesUsd } = require("../services/rates.service");
const {
  isValidWebhookSignature,
  processPaymentWebhook,
} = require("../services/payments.service");
const {
  notifyInvoicePaid,
  notifyInvoiceCreated,
  notifyInvoiceDeleted,
  notifyBulkDelete,
  notifyVerifierSummary,
} = require("../services/notifications.service");
const { verifyPendingPayments } = require("../services/payment-verifier.service");
const { txExplorerUrl, addressExplorerUrl } = require("../services/explorer-links.service");

const router = express.Router();

const publicRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 120 });
const webhookRateLimit = createRateLimit({ windowMs: 60 * 1000, max: 300 });

function queryFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function paymentQrText(payment) {
  if (payment.currency === "BTC") {
    return `bitcoin:${payment.walletAddress}?amount=${payment.expectedAmountCrypto}`;
  }
  if (payment.currency === "ETH") {
    return `ethereum:${payment.walletAddress}?value=${payment.expectedAmountCrypto}`;
  }
  if (payment.currency === "USDT") {
    return `tron:${payment.walletAddress}?amount=${payment.expectedAmountCrypto}`;
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
        explorerTxUrl: txExplorerUrl({
          currency: payment.currency,
          network: payment.network,
          txHash: payment.txHash,
        }),
        explorerAddressUrl: addressExplorerUrl({
          currency: payment.currency,
          network: payment.network,
          address: payment.walletAddress,
        }),
      };
    }),
  );
  return mapped;
}

function withExplorerLinksForTransactions(transactions) {
  return (transactions || []).map((tx) => ({
    ...tx,
    explorerTxUrl: txExplorerUrl({
      currency: tx.currency,
      network: tx.network,
      txHash: tx.txHash,
    }),
    explorerAddressUrl: addressExplorerUrl({
      currency: tx.currency,
      network: tx.network,
      address: tx.walletAddress,
    }),
  }));
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
    const createdByAdminId = req.body.created_by_admin_id || "api_admin";
    const invoice = await createInvoice({
      amountUsd: req.body.amount_usd,
      allowedCurrencies: req.body.allowed_currencies,
      telegramUserId: req.body.telegram_user_id,
      createdByAdminId,
    });
    await notifyInvoiceCreated(invoice, {
      source: "api",
      actor: String(createdByAdminId),
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

router.post("/invoices/delete-all", requireAdminApiKey, async (req, res, next) => {
  try {
    const confirmation = String(req.body.confirm || "").trim().toUpperCase();
    if (confirmation !== "DELETE_ALL" && confirmation !== "ELIMINA_TUTTO") {
      res.status(400).json({
        error: "Bad Request",
        message: "Conferma mancante. Invia confirm=ELIMINA_TUTTO",
      });
      return;
    }

    const summary = deleteAllInvoices();
    await notifyBulkDelete(summary, {
      source: "api",
      actor: "api_admin",
    });
    res.json({
      ok: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/dashboard", requireAdminApiKey, (req, res, next) => {
  try {
    const metrics = getDashboardMetrics();
    const riskMonitor = getRiskMonitor({
      limit: Number(req.query.risk_limit || 80),
    });
    const recentEvents = listRecentEvents(Number(req.query.events_limit || 20));
    const recentTransactionsRaw = listRecentTransactions({
      limit: Number(req.query.tx_limit || 20),
    });
    const recentTransactions = withExplorerLinksForTransactions(
      recentTransactionsRaw,
    );

    res.json({
      metrics,
      riskMonitor,
      recentEvents,
      recentTransactions,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/risk-monitor", requireAdminApiKey, (req, res, next) => {
  try {
    const riskMonitor = getRiskMonitor({
      limit: Number(req.query.limit || 120),
    });
    const snapshot = queryFlag(req.query.persist)
      ? recordRiskMonitorSnapshot(riskMonitor, {
          source: String(req.query.source || "manual-api"),
        })
      : null;
    const history = listRiskMonitorHistory(Number(req.query.history_limit || 40));
    const alertHistory = listRiskAlertEvents({
      limit: Number(req.query.alert_limit || 120),
      severity: req.query.severity || "all",
      code: req.query.code || "",
      source: req.query.alert_source || "",
      state: req.query.state || "all",
    });
    res.json({
      riskMonitor,
      history,
      alertHistory,
      snapshot,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/invoices", requireAdminApiKey, (req, res, next) => {
  try {
    const invoices = listInvoices({
      status: req.query.status || "all",
      limit: Number(req.query.limit || 100),
      search: req.query.search || "",
    });

    res.json({
      invoices,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/invoices/:invoiceRef", requireAdminApiKey, async (req, res, next) => {
  try {
    const details = getInvoiceAdminDetailsByRef(req.params.invoiceRef);
    if (!details) {
      res.status(404).json({
        error: "Not Found",
        message: "Fattura non trovata",
      });
      return;
    }

    const paymentsWithQr = await withQrCodes(details.invoice.payments || []);
    res.json({
      invoice: {
        ...details.invoice,
        payments: paymentsWithQr,
      },
      events: details.events,
      transactions: withExplorerLinksForTransactions(details.transactions),
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/admin/invoices/:invoiceRef", requireAdminApiKey, async (req, res, next) => {
  try {
    const deletedBy =
      (req.body && req.body.deleted_by) ||
      req.query.deleted_by ||
      "api_admin";
    const summary = deleteInvoiceByRef(
      req.params.invoiceRef,
      deletedBy,
    );

    if (!summary) {
      res.status(404).json({
        error: "Not Found",
        message: "Fattura non trovata",
      });
      return;
    }

    await notifyInvoiceDeleted(summary, {
      source: "api",
      actor: String(deletedBy),
    });

    res.json({
      ok: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/events", requireAdminApiKey, (req, res, next) => {
  try {
    const events = listRecentEvents(Number(req.query.limit || 200));
    res.json({
      events,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/transactions", requireAdminApiKey, (req, res, next) => {
  try {
    const transactionsRaw = listRecentTransactions({
      limit: Number(req.query.limit || 200),
      invoiceRef: req.query.invoice_ref || null,
      search: req.query.search || "",
      status: req.query.status || "all",
    });
    const transactions = withExplorerLinksForTransactions(transactionsRaw);
    res.json({
      transactions,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/transactions/:txRef", requireAdminApiKey, (req, res, next) => {
  try {
    const transaction = getTransactionByRef(req.params.txRef);
    if (!transaction) {
      res.status(404).json({
        error: "Not Found",
        message: "Transazione non trovata",
      });
      return;
    }
    res.json({
      transaction: withExplorerLinksForTransactions([transaction])[0],
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

    if (isInvoiceExpired(invoice)) {
      res.status(410).json({
        error: "Gone",
        message: "Fattura scaduta. Richiedi una nuova fattura.",
      });
      return;
    }

    const paymentsWithQr = await withQrCodes(invoice.payments);
    res.json({
      invoice: {
        id: invoice.id,
        shortId: invoice.shortId,
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
  "/invoices/id/:invoiceRef/status",
  requireAdminApiKey,
  (req, res, next) => {
    try {
      const status = getInvoiceStatusByRef(req.params.invoiceRef);
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
  "/invoices/:invoiceRef/mark-paid",
  requireAdminApiKey,
  async (req, res, next) => {
    try {
      const rawTxHash = req.body.tx_hash;
      const rawPaidAmount = req.body.paid_amount_crypto;
      const hasTxHash = Boolean(String(rawTxHash || "").trim());
      const hasPaidAmount =
        rawPaidAmount !== undefined &&
        rawPaidAmount !== null &&
        String(rawPaidAmount).trim() !== "";
      if (!hasTxHash && !hasPaidAmount) {
        res.status(400).json({
          error: "Bad Request",
          message:
            "Per conferma manuale serve tx_hash o paid_amount_crypto",
        });
        return;
      }

      const invoiceId = resolveInvoiceIdByRef(req.params.invoiceRef);
      if (!invoiceId) {
        res.status(404).json({
          error: "Not Found",
          message: "Fattura non trovata",
        });
        return;
      }

      const result = markInvoicePaid({
        invoiceId,
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
    if (!config.webhookHmacSecret) {
      res.status(503).json({
        error: "Service Unavailable",
        message: "PAYMENT_WEBHOOK_HMAC_SECRET non configurato",
      });
      return;
    }

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
    await notifyVerifierSummary(summary, {
      source: "manual-api",
    });
    res.json({
      ok: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
