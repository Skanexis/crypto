const config = require("../config");
const {
  createInvoice,
  listOpenInvoicesForTelegramUser,
  upsertTelegramUser,
  normalizeCurrencies,
} = require("./invoices.service");

function botEnabled() {
  return Boolean(config.botToken);
}

function isAdminTelegramUser(telegramUserId) {
  if (!config.adminTelegramIds.length) {
    return true;
  }
  return config.adminTelegramIds.includes(String(telegramUserId));
}

async function callTelegramApi(method, payload) {
  if (!botEnabled()) {
    throw new Error("Bot Telegram non configurato");
  }
  const url = `https://api.telegram.org/bot${config.botToken}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(
      `Telegram API error (${method}): ${json.description || response.status}`,
    );
  }
  return json.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return callTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

function formatInvoiceLine(invoice) {
  return `Fattura #${invoice.id.slice(0, 8)} | ${invoice.amountUsd.toFixed(2)} USD | Stato: ${invoice.status}\n${invoice.paymentUrl}`;
}

function parseNewInvoiceArgs(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(
      "Uso: /new_invoice <importo_usd> [telegram_user_id] [valute]\nEsempio: /new_invoice 100 123456789 USDT,BTC,ETH",
    );
  }

  const amountUsd = Number(parts[1]);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("Importo USD non valido");
  }

  let telegramUserId = null;
  let currenciesArg = null;

  if (parts[2]) {
    const arg2 = parts[2];
    const normalizedArg2 = arg2.trim().toUpperCase();
    const looksLikeCurrencies = /^[A-Z,]+$/.test(normalizedArg2);

    if (arg2 === "-" || arg2.toLowerCase() === "none") {
      telegramUserId = null;
    } else if (looksLikeCurrencies) {
      currenciesArg = arg2;
    } else {
      telegramUserId = String(arg2);
    }
  }

  if (parts[3]) {
    currenciesArg = parts[3];
  }

  const allowedCurrencies = currenciesArg
    ? normalizeCurrencies(currenciesArg)
    : normalizeCurrencies(null);

  return {
    amountUsd,
    telegramUserId,
    allowedCurrencies,
  };
}

async function notifyLinkedUserInvoice(telegramUserId, invoice) {
  if (!telegramUserId) {
    return;
  }
  const text =
    `Hai una nuova fattura da pagare.\n` +
    `Importo: ${invoice.amountUsd.toFixed(2)} USD\n` +
    `Scadenza: ${new Date(invoice.expiresAt).toLocaleString("it-IT")}\n` +
    `Link: ${invoice.paymentUrl}`;
  try {
    await sendMessage(String(telegramUserId), text);
  } catch (_error) {
    // L'utente potrebbe non aver ancora avviato la chat con il bot.
  }
}

async function handleStart(message) {
  const userId = String(message.from.id);
  upsertTelegramUser({
    telegramUserId: userId,
    username: message.from.username || null,
    firstName: message.from.first_name || null,
  });

  const invoices = listOpenInvoicesForTelegramUser(userId);
  if (!invoices.length) {
    await sendMessage(
      message.chat.id,
      "Benvenuto. Al momento non ci sono fatture aperte associate al tuo account.",
    );
    return;
  }

  const first = invoices[0];
  const text =
    `Benvenuto. Hai ${invoices.length} fattura/e aperta/e.\n\n` +
    `${formatInvoiceLine(first)}\n\n` +
    (invoices.length > 1
      ? "Usa /my_invoices per vedere tutte le fatture aperte."
      : "Apri il link per completare il pagamento.");

  await sendMessage(message.chat.id, text);
}

async function handleHelp(message) {
  const text =
    "Comandi disponibili:\n" +
    "/start - Mostra eventuali fatture aperte\n" +
    "/my_invoices - Elenco fatture aperte\n" +
    "/help - Mostra questo aiuto\n\n" +
    "Comando admin:\n" +
    "/new_invoice <importo_usd> [telegram_user_id] [valute]\n" +
    "Esempio: /new_invoice 150 123456789 USDT,BTC";
  await sendMessage(message.chat.id, text);
}

async function handleMyInvoices(message) {
  const userId = String(message.from.id);
  const invoices = listOpenInvoicesForTelegramUser(userId);
  if (!invoices.length) {
    await sendMessage(message.chat.id, "Non hai fatture aperte.");
    return;
  }

  const text = invoices.map((invoice) => formatInvoiceLine(invoice)).join("\n\n");
  await sendMessage(message.chat.id, text);
}

async function handleNewInvoice(message) {
  if (!isAdminTelegramUser(message.from.id)) {
    await sendMessage(message.chat.id, "Comando riservato all'amministratore.");
    return;
  }

  const args = parseNewInvoiceArgs(message.text || "");
  const invoice = await createInvoice({
    amountUsd: args.amountUsd,
    telegramUserId: args.telegramUserId,
    allowedCurrencies: args.allowedCurrencies,
    createdByAdminId: String(message.from.id),
  });

  const text =
    "Fattura creata con successo.\n" +
    `ID: ${invoice.id}\n` +
    `Importo: ${invoice.amountUsd.toFixed(2)} USD\n` +
    `Valute: ${invoice.allowedCurrencies.join(", ")}\n` +
    `Scadenza: ${new Date(invoice.expiresAt).toLocaleString("it-IT")}\n` +
    `Link pagamento: ${invoice.paymentUrl}`;
  await sendMessage(message.chat.id, text);

  await notifyLinkedUserInvoice(args.telegramUserId, invoice);
}

async function handleMessage(message) {
  if (!message || !message.text || !message.from) {
    return;
  }

  const text = message.text.trim();
  if (text.startsWith("/start")) {
    await handleStart(message);
    return;
  }
  if (text.startsWith("/help")) {
    await handleHelp(message);
    return;
  }
  if (text.startsWith("/my_invoices")) {
    await handleMyInvoices(message);
    return;
  }
  if (text.startsWith("/new_invoice")) {
    await handleNewInvoice(message);
    return;
  }
}

async function handleTelegramUpdate(update) {
  if (!botEnabled()) {
    return;
  }
  try {
    if (update.message) {
      await handleMessage(update.message);
    }
  } catch (error) {
    if (update?.message?.chat?.id) {
      await sendMessage(update.message.chat.id, `Errore: ${error.message}`);
    }
  }
}

async function setWebhook() {
  if (!botEnabled()) {
    throw new Error("TELEGRAM_BOT_TOKEN non impostato");
  }
  const webhookUrl = `${config.appBaseUrl}/telegram/webhook/${config.botWebhookSecret}`;
  return callTelegramApi("setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
}

module.exports = {
  botEnabled,
  sendMessage,
  handleTelegramUpdate,
  setWebhook,
  isAdminTelegramUser,
};
