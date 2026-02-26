const { sendMessage } = require("./telegram.service");

async function notifyInvoicePaid(invoice, currency, options = {}) {
  if (!invoice) {
    return;
  }

  const normalizedCurrency = String(currency || "").toUpperCase();
  const source = options.source || "manuale";
  const txHash = options.txHash || null;

  const textLines = [
    "Pagamento confermato.",
    `Fattura: ${invoice.id}`,
    `Importo: ${Number(invoice.amountUsd).toFixed(2)} USD`,
    `Valuta: ${normalizedCurrency}`,
    `Origine verifica: ${source}`,
  ];
  if (txHash) {
    textLines.push(`Tx: ${txHash}`);
  }
  const text = textLines.join("\n");

  const recipients = new Set();
  if (invoice.telegramUserId) {
    recipients.add(String(invoice.telegramUserId));
  }
  if (invoice.createdByAdminId) {
    recipients.add(String(invoice.createdByAdminId));
  }

  const tasks = [...recipients].map(async (chatId) => {
    try {
      await sendMessage(chatId, text);
    } catch (_error) {
      // Ignora errori Telegram non bloccanti.
    }
  });
  await Promise.all(tasks);
}

module.exports = {
  notifyInvoicePaid,
};
