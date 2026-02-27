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

  const recipients = new Set();
  const linkedUser = normalizeChatId(invoice.telegramUserId);
  if (linkedUser) {
    recipients.add(linkedUser);
  }
  const creator = normalizeChatId(invoice.createdByAdminId);
  if (creator) {
    recipients.add(creator);
  }
  for (const adminId of collectAdminRecipients()) {
    recipients.add(adminId);
  }

  await deliverToRecipients(recipients, text);
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
    topAlerts
      .map((alert) => {
        const invoiceRef = alert.invoiceRef || "-";
        const txRef = alert.txRef || "-";
        return `${localizeRiskSeverity(alert.severity)} | ${alert.code} | inv ${invoiceRef} | tx ${txRef}`;
      })
      .join("\n") || "Nessun alert";

  const text =
    `Alert monitor rischi\n` +
    `Origine: ${source}\n` +
    `Aggiornato: ${new Date(monitor.generatedAt).toLocaleString("it-IT")}\n` +
    `Totale: ${summary.total} (critici ${summary.critical}, alti ${summary.high}, medi ${summary.medium})\n\n` +
    `Top alert:\n${alertLines}`;

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
  notifyInvoiceCreated,
  notifyInvoiceDeleted,
  notifyBulkDelete,
  notifyVerifierSummary,
  notifyRiskMonitorSummary,
};
