const config = require("../config");
const {
  createInvoice,
  deleteAllInvoices,
  getInvoiceStatusById,
  listOpenInvoicesForTelegramUser,
  listPendingInvoices,
  normalizeCurrencies,
  upsertTelegramUser,
} = require("./invoices.service");

const adminSessions = new Map();

const ADMIN_BUTTONS = {
  CREATE: "➕ Nuova fattura",
  LIST: "📄 Fatture aperte",
  STATUS: "🔎 Stato fattura",
  DELETE_ALL: "🧹 Elimina tutte le fatture",
  HELP: "❓ Aiuto admin",
  CANCEL: "❌ Annulla",
};

const ADMIN_MODES = {
  CREATE_AMOUNT: "create_amount",
  CREATE_TELEGRAM: "create_telegram",
  CREATE_CURRENCIES: "create_currencies",
  STATUS_ID: "status_id",
  DELETE_CONFIRM: "delete_confirm",
};

function adminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: ADMIN_BUTTONS.CREATE }, { text: ADMIN_BUTTONS.LIST }],
        [{ text: ADMIN_BUTTONS.STATUS }, { text: ADMIN_BUTTONS.DELETE_ALL }],
        [{ text: ADMIN_BUTTONS.HELP }, { text: ADMIN_BUTTONS.CANCEL }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

function botEnabled() {
  return Boolean(config.botToken);
}

function isAdminTelegramUser(telegramUserId) {
  if (!config.adminTelegramIds.length) {
    return true;
  }
  return config.adminTelegramIds.includes(String(telegramUserId));
}

function getAdminSession(chatId) {
  return adminSessions.get(String(chatId)) || null;
}

function setAdminSession(chatId, mode, data = {}) {
  adminSessions.set(String(chatId), {
    mode,
    data: { ...data },
  });
}

function clearAdminSession(chatId) {
  adminSessions.delete(String(chatId));
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
  return `#${invoice.id.slice(0, 8)} | ${invoice.amountUsd.toFixed(2)} USD | ${invoice.status}\n${invoice.paymentUrl}`;
}

function formatInvoiceStatus(status) {
  const paymentLines = (status.payments || [])
    .map(
      (payment) =>
        `${payment.currency}: ${payment.status} (${payment.expectedAmountCrypto} ${payment.currency})`,
    )
    .join("\n");

  return (
    `Fattura: ${status.invoiceId}\n` +
    `Stato: ${status.status}\n` +
    `Importo: ${status.amountUsd.toFixed(2)} USD\n` +
    `Scadenza: ${new Date(status.expiresAt).toLocaleString("it-IT")}\n` +
    `Link: ${status.paymentUrl}\n\n` +
    `Pagamenti:\n${paymentLines || "Nessuno"}`
  );
}

function parseNewInvoiceArgs(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(
      "Uso: /new_invoice <importo_usd> [telegram_user_id] [valute]\nEsempio: /new_invoice 100 123456789 USDT,BTC,ETH",
    );
  }

  const amountUsd = Number(String(parts[1]).replace(",", "."));
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

function parseOptionalTelegramId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "-" || normalized.toLowerCase() === "skip") {
    return null;
  }
  if (!/^\d{5,20}$/.test(normalized)) {
    throw new Error("Telegram user id non valido. Usa un numero o '-' per saltare.");
  }
  return normalized;
}

function parseCurrenciesInput(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("Inserisci almeno una valuta.");
  }
  if (
    normalized.toLowerCase() === "tutte" ||
    normalized.toLowerCase() === "all"
  ) {
    return normalizeCurrencies(null);
  }
  return normalizeCurrencies(normalized);
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

async function sendAdminDashboard(chatId, intro = "") {
  const pending = listPendingInvoices(5);
  const introPrefix = intro ? `${intro}\n\n` : "";
  const text =
    introPrefix +
    "Menu admin pronto.\n" +
    `Fatture aperte (ultime ${pending.length}):\n` +
    (pending.length
      ? pending.map((invoice) => formatInvoiceLine(invoice)).join("\n\n")
      : "Nessuna fattura aperta.") +
    "\n\nUsa i pulsanti per le azioni rapide.";

  await sendMessage(chatId, text, adminKeyboard());
}

async function handleStart(message) {
  const userId = String(message.from.id);
  upsertTelegramUser({
    telegramUserId: userId,
    username: message.from.username || null,
    firstName: message.from.first_name || null,
  });

  if (isAdminTelegramUser(userId)) {
    clearAdminSession(message.chat.id);
    await sendAdminDashboard(message.chat.id, "Benvenuto amministratore.");
    return;
  }

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
  const isAdmin = isAdminTelegramUser(message.from.id);
  const baseText =
    "Comandi disponibili:\n" +
    "/start - Avvia il bot\n" +
    "/my_invoices - Elenco fatture aperte associate\n" +
    "/help - Mostra questo aiuto";

  if (!isAdmin) {
    await sendMessage(message.chat.id, baseText);
    return;
  }

  const adminText =
    `${baseText}\n\n` +
    "Comandi admin:\n" +
    "/admin - Apri il menu admin\n" +
    "/new_invoice <importo_usd> [telegram_user_id] [valute]\n" +
    "/invoice_status <invoice_id>\n" +
    "/pending_invoices\n" +
    "/delete_all_invoices\n" +
    "/cancel";
  await sendMessage(message.chat.id, adminText, adminKeyboard());
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

async function createInvoiceFromArgs(message, args) {
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
  await sendMessage(message.chat.id, text, adminKeyboard());
  await notifyLinkedUserInvoice(args.telegramUserId, invoice);
}

async function handleNewInvoiceCommand(message) {
  if (!isAdminTelegramUser(message.from.id)) {
    await sendMessage(message.chat.id, "Comando riservato all'amministratore.");
    return;
  }

  const text = String(message.text || "").trim();
  const isSlashCommand = text.startsWith("/new_invoice");
  const parts = text.split(/\s+/);
  const hasCommandArgs = isSlashCommand && parts.length >= 2;

  if (!hasCommandArgs) {
    setAdminSession(message.chat.id, ADMIN_MODES.CREATE_AMOUNT);
    await sendMessage(
      message.chat.id,
      "Creazione guidata fattura.\nInserisci importo USD (esempio: 150.50)",
      adminKeyboard(),
    );
    return;
  }

  const args = parseNewInvoiceArgs(text);
  await createInvoiceFromArgs(message, args);
}

async function showPendingInvoices(message) {
  const invoices = listPendingInvoices(10);
  if (!invoices.length) {
    await sendMessage(message.chat.id, "Nessuna fattura aperta.", adminKeyboard());
    return;
  }

  const text =
    `Fatture aperte: ${invoices.length}\n\n` +
    invoices
      .map(
        (invoice) =>
          `ID: ${invoice.id}\n${invoice.amountUsd.toFixed(2)} USD | scade ${new Date(
            invoice.expiresAt,
          ).toLocaleString("it-IT")}\n${invoice.paymentUrl}`,
      )
      .join("\n\n");
  await sendMessage(message.chat.id, text, adminKeyboard());
}

async function requestInvoiceStatus(message) {
  setAdminSession(message.chat.id, ADMIN_MODES.STATUS_ID);
  await sendMessage(
    message.chat.id,
    "Inserisci invoice ID completo per vedere lo stato.",
    adminKeyboard(),
  );
}

async function processInvoiceStatusById(message, invoiceIdRaw) {
  const invoiceId = String(invoiceIdRaw || "").trim();
  if (!invoiceId) {
    throw new Error("Invoice ID mancante.");
  }
  const status = getInvoiceStatusById(invoiceId);
  if (!status) {
    await sendMessage(message.chat.id, "Fattura non trovata.", adminKeyboard());
    return;
  }
  await sendMessage(message.chat.id, formatInvoiceStatus(status), adminKeyboard());
}

async function requestDeleteAll(message) {
  setAdminSession(message.chat.id, ADMIN_MODES.DELETE_CONFIRM);
  await sendMessage(
    message.chat.id,
    "ATTENZIONE: questa azione elimina TUTTE le fatture.\nScrivi esattamente: ELIMINA TUTTO\nPer annullare usa ❌ Annulla.",
    adminKeyboard(),
  );
}

async function processDeleteAll(message, confirmationText) {
  const normalized = String(confirmationText || "").trim().toUpperCase();
  if (normalized !== "ELIMINA TUTTO") {
    await sendMessage(
      message.chat.id,
      "Conferma non valida. Scrivi esattamente ELIMINA TUTTO oppure usa ❌ Annulla.",
      adminKeyboard(),
    );
    return;
  }

  const summary = deleteAllInvoices();
  clearAdminSession(message.chat.id);
  await sendAdminDashboard(
    message.chat.id,
    `Eliminazione completata.\nInvoice eliminate: ${summary.deletedInvoices}\nPagamenti eliminati: ${summary.deletedPayments}`,
  );
}

async function handleAdminSessionInput(message, text) {
  const session = getAdminSession(message.chat.id);
  if (!session) {
    return false;
  }

  if (text === ADMIN_BUTTONS.CANCEL || text.startsWith("/cancel")) {
    clearAdminSession(message.chat.id);
    await sendAdminDashboard(message.chat.id, "Azione annullata.");
    return true;
  }

  if (session.mode === ADMIN_MODES.CREATE_AMOUNT) {
    const normalizedAmount = String(text || "").trim().replace(",", ".");
    const amountUsd = Number(normalizedAmount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      await sendMessage(
        message.chat.id,
        "Importo non valido. Inserisci un numero positivo in USD (esempio: 150.50).",
        adminKeyboard(),
      );
      return true;
    }
    setAdminSession(message.chat.id, ADMIN_MODES.CREATE_TELEGRAM, { amountUsd });
    await sendMessage(
      message.chat.id,
      "Inserisci telegram_user_id cliente oppure '-' per saltare.",
      adminKeyboard(),
    );
    return true;
  }

  if (session.mode === ADMIN_MODES.CREATE_TELEGRAM) {
    const telegramUserId = parseOptionalTelegramId(text);
    setAdminSession(message.chat.id, ADMIN_MODES.CREATE_CURRENCIES, {
      ...session.data,
      telegramUserId,
    });
    await sendMessage(
      message.chat.id,
      "Inserisci valute (esempio: USDT,BTC,ETH) oppure 'tutte'.",
      adminKeyboard(),
    );
    return true;
  }

  if (session.mode === ADMIN_MODES.CREATE_CURRENCIES) {
    const allowedCurrencies = parseCurrenciesInput(text);
    const invoice = await createInvoice({
      amountUsd: session.data.amountUsd,
      telegramUserId: session.data.telegramUserId,
      allowedCurrencies,
      createdByAdminId: String(message.from.id),
    });
    clearAdminSession(message.chat.id);

    await notifyLinkedUserInvoice(session.data.telegramUserId, invoice);
    await sendAdminDashboard(
      message.chat.id,
      `Fattura creata.\nID: ${invoice.id}\nImporto: ${invoice.amountUsd.toFixed(
        2,
      )} USD\nValute: ${invoice.allowedCurrencies.join(", ")}\nLink: ${invoice.paymentUrl}`,
    );
    return true;
  }

  if (session.mode === ADMIN_MODES.STATUS_ID) {
    clearAdminSession(message.chat.id);
    await processInvoiceStatusById(message, text);
    return true;
  }

  if (session.mode === ADMIN_MODES.DELETE_CONFIRM) {
    await processDeleteAll(message, text);
    return true;
  }

  return false;
}

async function handleAdminMessage(message, text) {
  if (text === ADMIN_BUTTONS.CANCEL || text.startsWith("/cancel")) {
    clearAdminSession(message.chat.id);
    await sendAdminDashboard(message.chat.id, "Azione annullata.");
    return true;
  }

  if (text.startsWith("/start")) {
    clearAdminSession(message.chat.id);
    await handleStart(message);
    return true;
  }

  if (text.startsWith("/admin") || text === ADMIN_BUTTONS.HELP) {
    clearAdminSession(message.chat.id);
    await sendAdminDashboard(message.chat.id);
    return true;
  }

  if (text.startsWith("/help")) {
    clearAdminSession(message.chat.id);
    await handleHelp(message);
    return true;
  }

  if (text === ADMIN_BUTTONS.CREATE || text.startsWith("/new_invoice")) {
    clearAdminSession(message.chat.id);
    await handleNewInvoiceCommand(message);
    return true;
  }

  if (text === ADMIN_BUTTONS.LIST || text.startsWith("/pending_invoices")) {
    clearAdminSession(message.chat.id);
    await showPendingInvoices(message);
    return true;
  }

  if (text === ADMIN_BUTTONS.STATUS) {
    clearAdminSession(message.chat.id);
    await requestInvoiceStatus(message);
    return true;
  }

  if (text.startsWith("/invoice_status")) {
    clearAdminSession(message.chat.id);
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await requestInvoiceStatus(message);
      return true;
    }
    await processInvoiceStatusById(message, parts[1]);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.DELETE_ALL ||
    text.startsWith("/delete_all_invoices")
  ) {
    clearAdminSession(message.chat.id);
    await requestDeleteAll(message);
    return true;
  }

  const handledBySession = await handleAdminSessionInput(message, text);
  if (handledBySession) {
    return true;
  }

  return false;
}

async function handleMessage(message) {
  if (!message || !message.text || !message.from) {
    return;
  }

  const text = message.text.trim();
  const isAdmin = isAdminTelegramUser(message.from.id);

  if (isAdmin) {
    const handled = await handleAdminMessage(message, text);
    if (handled) {
      return;
    }
    await sendAdminDashboard(
      message.chat.id,
      "Comando non riconosciuto. Usa il menu admin.",
    );
    return;
  }

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
