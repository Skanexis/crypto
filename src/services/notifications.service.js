const config = require("../config");
const { sendMessage } = require("./telegram.service");
const { txExplorerUrl } = require("./explorer-links.service");

const alertState = new Map();

function normalizeChatId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (!/^-?\d{5,20}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function collectAdminRecipients() {
  const recipients = new Set();
  for (const raw of config.adminTelegramIds || []) {
    const normalized = normalizeChatId(raw);
    if (normalized) {
      recipients.add(normalized);
    }
  }
  return recipients;
}

function shouldSendAlert(key, fingerprint, cooldownSec = 120) {
  if (!key) return true;
  const now = Date.now();
  const prev = alertState.get(key);
  if (
    prev &&
    prev.fingerprint === fingerprint &&
    now - prev.sentAtMs < Math.max(0, Number(cooldownSec || 0)) * 1000
  ) {
    return false;
  }
  alertState.set(key, {
    fingerprint,
    sentAtMs: now,
  });
  return true;
}

async function deliverToRecipients(recipients, text) {
  const tasks = [...recipients].map(async (chatId) => {
    try {
      await sendMessage(chatId, text);
    } catch (_error) {
      // Ignore telegram failures: non-blocking notifications.
    }
  });
  await Promise.all(tasks);
}

async function notifyAdmins(text, options = {}) {
  const recipients = collectAdminRecipients();
  if (!recipients.size) {
    return;
  }

  const key = options.dedupeKey || null;
  const fingerprint = String(options.fingerprint || text || "").slice(0, 1200);
  const cooldownSec = Number(options.cooldownSec || 0);
  if (!shouldSendAlert(key, fingerprint, cooldownSec)) {
    return;
  }

  await deliverToRecipients(recipients, text);
}

function collectInvoiceRecipients(invoice) {
  const recipients = new Set();
  const linkedUser = normalizeChatId(invoice?.telegramUserId);
  if (linkedUser) {
    recipients.add(linkedUser);
  }
  const creator = normalizeChatId(invoice?.createdByAdminId);
  if (creator) {
    recipients.add(creator);
  }
  for (const adminId of collectAdminRecipients()) {
    recipients.add(adminId);
  }
  return recipients;
}

function shortHash(value, size = 16) {
  const text = String(value || "").trim();
  if (!text || text.length <= size) {
    return text;
  }
  return `${text.slice(0, size)}...`;
}

function adminInvoiceUrl(invoiceRef) {
  const ref = String(invoiceRef || "").trim();
  if (!ref || !config.appBaseUrl) {
    return null;
  }
  return `${config.appBaseUrl}/admin/invoices?ref=${encodeURIComponent(ref)}`;
}

function formatRiskDetails(alert) {
  const details = alert?.details && typeof alert.details === "object" ? alert.details : {};
  const parts = [];

  if (Number.isFinite(Number(details.amountUsd))) {
    parts.push(`${Number(details.amountUsd).toFixed(2)} USD`);
  }
  if (details.currency) {
    parts.push(String(details.currency).toUpperCase());
  }
  if (Number.isFinite(Number(details.confirmations))) {
    if (Number.isFinite(Number(details.requiredConfirmations))) {
      parts.push(`conf ${Number(details.confirmations)}/${Number(details.requiredConfirmations)}`);
    } else {
      parts.push(`conf ${Number(details.confirmations)}`);
    }
  }
  if (Number.isFinite(Number(details.staleMinutes))) {
    parts.push(`fermo ${Number(details.staleMinutes)}m`);
  }
  if (Number.isFinite(Number(details.overdueMinutes))) {
    parts.push(`oltre soglia ${Number(details.overdueMinutes)}m`);
  }
  if (Number.isFinite(Number(details.alertThresholdMinutes))) {
    parts.push(`soglia ${Number(details.alertThresholdMinutes)}m`);
  }

  return parts.join(" | ");
}

function formatRiskAlertBlock(alert, index) {
  const title = String(alert?.title || alert?.code || "Alert").trim();
  const severity = localizeRiskSeverity(alert?.severity);
  const invoiceRef = String(alert?.invoiceRef || "").trim();
  const txRef = String(alert?.txRef || "").trim();
  const txHash = String(alert?.txHash || "").trim();
  const lines = [`${index + 1}. ${severity.toUpperCase()} | ${title}`];

  if (invoiceRef) {
    lines.push(`Fattura: ${invoiceRef}`);
  }
  if (txRef) {
    lines.push(`Pagamento: ${txRef}`);
  }
  if (txHash) {
    lines.push(`Tx hash: ${shortHash(txHash, 24)}`);
  }

  const detailLine = formatRiskDetails(alert);
  if (detailLine) {
    lines.push(`Dettagli: ${detailLine}`);
  } else if (alert?.description) {
    lines.push(`Dettagli: ${String(alert.description).trim()}`);
  }

  const invoiceUrl = adminInvoiceUrl(invoiceRef);
  if (invoiceUrl) {
    lines.push(`Apri: ${invoiceUrl}`);
  }

  return lines.join("\n");
}

async function notifyInvoicePaid(invoice, currency, options = {}) {
  if (!invoice) {
    return;
  }

  const normalizedCurrency = String(currency || "").toUpperCase();
  const source = options.source || "manuale";
  const txHash = options.txHash || null;

  const textLines = [
    "Pagamento confermato.",
    `Fattura: ${invoice.shortId || invoice.id}`,
    `ID tecnico: ${invoice.id}`,
    `Importo: ${Number(invoice.amountUsd).toFixed(2)} USD`,
    `Valuta: ${normalizedCurrency}`,
    `Origine verifica: ${source}`,
  ];
  if (txHash) {
    textLines.push(`Tx: ${txHash}`);
    const payment = (invoice.payments || []).find(
      (item) => String(item.currency || "").toUpperCase() === normalizedCurrency,
    );
    const explorer = txExplorerUrl({
      currency: normalizedCurrency,
      network: payment?.network || null,
      txHash,
    });
    if (explorer) {
      textLines.push(`Explorer: ${explorer}`);
    }
  }
  const text = textLines.join("\n");

  await deliverToRecipients(collectInvoiceRecipients(invoice), text);
}

async function notifyPaymentPendingConfirmation(invoice, currency, options = {}) {
  if (!invoice) {
    return;
  }

  const normalizedCurrency = String(currency || "").toUpperCase();
  const txHash = String(options.txHash || "").trim();
  const confirmations = Math.max(0, Number(options.confirmations || 0));
  const requiredConfirmations = Math.max(0, Number(options.requiredConfirmations || 0));
  const source = options.source || "verifier";
  const payment = (invoice.payments || []).find(
    (item) => String(item.currency || "").toUpperCase() === normalizedCurrency,
  );
  const explorer = txHash
    ? txExplorerUrl({
        currency: normalizedCurrency,
        network: payment?.network || null,
        txHash,
      })
    : null;

  const textLines = [
    "Pagamento rilevato, conferma in corso.",
    `Fattura: ${invoice.shortId || invoice.id}`,
    `Importo: ${Number(invoice.amountUsd).toFixed(2)} USD`,
    `Valuta: ${normalizedCurrency}`,
    `Conferme: ${confirmations}${requiredConfirmations > 0 ? `/${requiredConfirmations}` : ""}`,
    `Origine verifica: ${source}`,
  ];
  if (txHash) {
    textLines.push(`Tx: ${txHash}`);
  }
  if (explorer) {
    textLines.push(`Explorer: ${explorer}`);
  }

  const text = textLines.join("\n");
  if (
    !shouldSendAlert(
      `payment-pending-confirmation-${payment?.id || invoice.id}-${normalizedCurrency}`,
      txHash || `${invoice.id}:${normalizedCurrency}`,
      12 * 60 * 60,
    )
  ) {
    return;
  }

  await deliverToRecipients(collectInvoiceRecipients(invoice), text);
}

async function notifyInvoiceCreated(invoice, options = {}) {
  if (!invoice) return;
  const source = options.source || "api";
  const actor = options.actor || invoice.createdByAdminId || "sistema";
  const text =
    `Nuova fattura creata\n` +
    `Rif: ${invoice.shortId || invoice.id}\n` +
    `Importo: ${Number(invoice.amountUsd || 0).toFixed(2)} USD\n` +
    `Valute: ${(invoice.allowedCurrencies || []).join(", ")}\n` +
    `Scadenza: ${new Date(invoice.expiresAt).toLocaleString("it-IT")}\n` +
    `Operatore: ${actor}\n` +
    `Origine: ${source}\n` +
    `Link: ${invoice.paymentUrl}`;
  await notifyAdmins(text, {
    dedupeKey: `invoice-created-${invoice.id}`,
    fingerprint: invoice.id,
    cooldownSec: 5,
  });
}

async function notifyInvoiceDeleted(summary, options = {}) {
  if (!summary) return;
  const source = options.source || "api";
  const actor = options.actor || "sistema";
  const text =
    `Fattura eliminata\n` +
    `Rif: ${summary.invoiceShortId || summary.invoiceId}\n` +
    `Pagamenti eliminati: ${summary.deletedPayments}\n` +
    `Stato precedente: ${summary.deletedStatusBefore}\n` +
    `Operatore: ${actor}\n` +
    `Origine: ${source}\n` +
    `Quando: ${new Date(summary.deletedAt).toLocaleString("it-IT")}`;
  await notifyAdmins(text, {
    dedupeKey: `invoice-deleted-${summary.invoiceId}`,
    fingerprint: summary.invoiceId,
    cooldownSec: 10,
  });
}

async function notifyBulkDelete(summary, options = {}) {
  if (!summary) return;
  const source = options.source || "api";
  const actor = options.actor || "sistema";
  const text =
    `Eliminazione massiva completata\n` +
    `Fatture eliminate: ${Number(summary.deletedInvoices || 0)}\n` +
    `Pagamenti eliminati: ${Number(summary.deletedPayments || 0)}\n` +
    `Fatture aperte eliminate: ${Number(summary.deletedOpenInvoices || 0)}\n` +
    `Pagamenti aperti eliminati: ${Number(summary.deletedOpenPayments || 0)}\n` +
    `Operatore: ${actor}\n` +
    `Origine: ${source}\n` +
    `Quando: ${new Date(summary.executedAt).toLocaleString("it-IT")}`;
  await notifyAdmins(text, {
    dedupeKey: `bulk-delete-${summary.executedAt}`,
    fingerprint: `${summary.executedAt}:${summary.deletedInvoices}:${summary.deletedPayments}`,
    cooldownSec: 15,
  });
}

async function notifyVerifierSummary(summary, options = {}) {
  if (!summary) return;
  if (Number(summary.paid || 0) <= 0 && (!summary.errors || summary.errors.length === 0)) {
    return;
  }

  const source = options.source || "job";
  const resultLines = (summary.results || []).map((item) => {
    const disabled = item.disabled ? " (disabled)" : "";
    return `${item.currency}${disabled}: checked ${item.checked}, paid ${item.paid}, errors ${item.errors.length}`;
  });

  const text =
    `Alert verifica pagamenti\n` +
    `Origine: ${source}\n` +
    `Esecuzione: ${new Date(summary.ranAt).toLocaleString("it-IT")}\n` +
    `Totale controllati: ${summary.checked}\n` +
    `Totale pagati: ${summary.paid}\n` +
    `Totale errori: ${summary.errors.length}\n\n` +
    `Provider:\n${resultLines.join("\n")}` +
    (summary.errors.length
      ? `\n\nPrime anomalie:\n${summary.errors.slice(0, 5).join("\n")}`
      : "");

  await notifyAdmins(text, {
    dedupeKey: "verifier-summary",
    fingerprint: `${summary.paid}|${summary.errors.slice(0, 8).join("|")}`,
    cooldownSec: 120,
  });
}

function localizeRiskSeverity(severity) {
  const key = String(severity || "").toLowerCase();
  if (key === "critical") return "critico";
  if (key === "high") return "alto";
  if (key === "medium") return "medio";
  return key || "n/d";
}

async function notifyRiskMonitorSummary(monitor, options = {}) {
  if (!monitor || !monitor.summary) {
    return;
  }
  const summary = monitor.summary;
  if (Number(summary.critical || 0) <= 0 && Number(summary.high || 0) <= 0) {
    return;
  }

  const topAlerts = (monitor.alerts || []).slice(0, 5);
  const source = options.source || "job";
  const alertLines =
    topAlerts.map((alert, index) => formatRiskAlertBlock(alert, index)).join("\n\n") ||
    "Nessun alert";

  const text =
    `Alert monitor rischi\n` +
    `Origine: ${source}\n` +
    `Aggiornato: ${new Date(monitor.generatedAt).toLocaleString("it-IT")}\n` +
    `Totale: ${summary.total} (critici ${summary.critical}, alti ${summary.high}, medi ${summary.medium})\n\n` +
    `Alert principali:\n${alertLines}`;

  await notifyAdmins(text, {
    dedupeKey: "risk-monitor",
    fingerprint: topAlerts
      .map((alert) => `${alert.code}|${alert.invoiceRef || ""}|${alert.txRef || ""}`)
      .join(";"),
    cooldownSec: 180,
  });
}

module.exports = {
  notifyAdmins,
  notifyInvoicePaid,
  notifyPaymentPendingConfirmation,
  notifyInvoiceCreated,
  notifyInvoiceDeleted,
  notifyBulkDelete,
  notifyVerifierSummary,
  notifyRiskMonitorSummary,
};
