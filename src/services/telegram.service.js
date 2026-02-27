const config = require("../config");
const {
  createInvoice,
  deleteAllInvoices,
  deleteInvoiceByRef,
  getDashboardMetrics,
  getInvoiceAdminDetailsByRef,
  getTransactionByRef,
  getInvoiceStatusByRef,
  listInvoices,
  listRecentTransactions,
  listOpenInvoicesForTelegramUser,
  normalizeCurrencies,
  upsertTelegramUser,
} = require("./invoices.service");
const { txExplorerUrl } = require("./explorer-links.service");

const adminSessions = new Map();

const ADMIN_BUTTONS = {
  CREATE: "➕ Nuova fattura",
  DASHBOARD: "📊 Panoramica",
  LIST: "🧾 Lista fatture",
  DETAIL: "🔎 Dettagli fattura",
  TX_FEED: "💳 Flusso transazioni",
  TX_DETAIL: "🧷 Dettaglio tx",
  DELETE_ONE: "🗑 Elimina fattura",
  DELETE_ALL: "🧹 Elimina tutte",
  HELP: "❓ Aiuto",
  CANCEL: "❌ Annulla",
};

const ADMIN_MODES = {
  CREATE_AMOUNT: "create_amount",
  CREATE_TELEGRAM: "create_telegram",
  CREATE_CURRENCIES: "create_currencies",
  STATUS_REF: "status_ref",
  DETAIL_REF: "detail_ref",
  TX_REF: "tx_ref",
  DELETE_ONE_REF: "delete_one_ref",
  DELETE_CONFIRM: "delete_confirm",
};

function adminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: ADMIN_BUTTONS.CREATE }, { text: ADMIN_BUTTONS.DASHBOARD }],
        [{ text: ADMIN_BUTTONS.LIST }, { text: ADMIN_BUTTONS.DETAIL }],
        [{ text: ADMIN_BUTTONS.TX_FEED }, { text: ADMIN_BUTTONS.TX_DETAIL }],
        [{ text: ADMIN_BUTTONS.DELETE_ONE }, { text: ADMIN_BUTTONS.DELETE_ALL }],
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
    return false;
  }
  return config.adminTelegramIds.includes(String(telegramUserId));
}

function localizeStatus(status) {
  const key = String(status || "").toLowerCase();
  const map = {
    pending: "in attesa",
    paid: "pagata",
    expired: "scaduta",
    cancelled: "annullata",
    awaiting_payment: "in attesa pagamento",
    pending_confirmation: "in attesa conferme",
    confirmed: "confermata",
  };
  return map[key] || key || "n/d";
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

function isAdminControlText(textRaw) {
  const text = String(textRaw || "").trim();
  return (
    text === ADMIN_BUTTONS.CREATE ||
    text === ADMIN_BUTTONS.DASHBOARD ||
    text === ADMIN_BUTTONS.LIST ||
    text === ADMIN_BUTTONS.DETAIL ||
    text === ADMIN_BUTTONS.TX_FEED ||
    text === ADMIN_BUTTONS.TX_DETAIL ||
    text === ADMIN_BUTTONS.DELETE_ONE ||
    text === ADMIN_BUTTONS.DELETE_ALL ||
    text === ADMIN_BUTTONS.HELP ||
    text === ADMIN_BUTTONS.CANCEL ||
    text.startsWith("/admin") ||
    text.startsWith("/admin_dashboard") ||
    text.startsWith("/new_invoice") ||
    text.startsWith("/nuova_fattura") ||
    text.startsWith("/pending_invoices") ||
    text.startsWith("/fatture_in_attesa") ||
    text.startsWith("/invoice_status") ||
    text.startsWith("/stato_fattura") ||
    text.startsWith("/invoice_detail") ||
    text.startsWith("/dettaglio_fattura") ||
    text.startsWith("/invoice_logs") ||
    text.startsWith("/tx_feed") ||
    text.startsWith("/flusso_tx") ||
    text.startsWith("/tx_status") ||
    text.startsWith("/stato_tx") ||
    text.startsWith("/tx_detail") ||
    text.startsWith("/dettaglio_tx") ||
    text.startsWith("/invoice_delete") ||
    text.startsWith("/elimina_fattura") ||
    text.startsWith("/delete_all_invoices") ||
    text.startsWith("/elimina_tutte_fatture") ||
    text.startsWith("/help") ||
    text.startsWith("/aiuto") ||
    text.startsWith("/cancel")
  );
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
      `Errore API Telegram (${method}): ${json.description || response.status}`,
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

function shortHash(value, size = 10) {
  const text = String(value || "");
  if (!text || text.length <= size) {
    return text;
  }
  return `${text.slice(0, size)}...`;
}

function formatInvoiceLine(invoice) {
  return `${invoice.shortId} | ${invoice.amountUsd.toFixed(2)} USD | ${localizeStatus(invoice.status)}\n${invoice.paymentUrl}`;
}

function formatInvoiceStatus(status) {
  const paymentLines = (status.payments || [])
    .map((payment) => {
      const txPart = payment.txHash ? ` | tx ${shortHash(payment.txHash, 12)}` : "";
      const explorer = payment.txHash
        ? txExplorerUrl({
            currency: payment.currency,
            network: payment.network,
            txHash: payment.txHash,
          })
        : null;
      const explorerPart = explorer ? ` | ${shortHash(explorer, 24)}` : "";
      return `${payment.shortId} ${payment.currency}: ${localizeStatus(payment.status)} (${payment.expectedAmountCrypto} ${payment.currency})${txPart}${explorerPart}`;
    })
    .join("\n");

  return (
    `Fattura: ${status.invoiceShortId}\n` +
    `ID tecnico: ${status.invoiceId}\n` +
    `Stato: ${localizeStatus(status.status)}\n` +
    `Importo: ${status.amountUsd.toFixed(2)} USD\n` +
    `Scadenza: ${new Date(status.expiresAt).toLocaleString("it-IT")}\n` +
    `Link: ${status.paymentUrl}\n\n` +
    `Transazioni:\n${paymentLines || "Nessuna"}`
  );
}

function formatInvoiceDetails(details) {
  const invoice = details.invoice;
  const paymentLines = (invoice.payments || [])
    .map((payment) => {
      const txPart = payment.txHash ? ` | tx ${shortHash(payment.txHash, 14)}` : "";
      const explorer = payment.txHash
        ? txExplorerUrl({
            currency: payment.currency,
            network: payment.network,
            txHash: payment.txHash,
          })
        : null;
      const explorerPart = explorer ? ` | ${shortHash(explorer, 28)}` : "";
      return `${payment.shortId} ${payment.currency} ${localizeStatus(payment.status)} | atteso ${payment.expectedAmountCrypto}${txPart}${explorerPart}`;
    })
    .join("\n");

  const eventLines = (details.events || [])
    .slice(0, 6)
    .map((event) => {
      const when = new Date(event.createdAt).toLocaleString("it-IT");
      const ref = event.entityShortId || event.entityId;
      return `${when} | ${event.action} | ${ref}`;
    })
    .join("\n");

  return (
    `Dettagli fattura ${invoice.shortId}\n` +
    `ID: ${invoice.id}\n` +
    `Stato: ${localizeStatus(invoice.status)}\n` +
    `Importo: ${invoice.amountUsd.toFixed(2)} USD\n` +
    `Scadenza: ${new Date(invoice.expiresAt).toLocaleString("it-IT")}\n\n` +
    `Transazioni:\n${paymentLines || "Nessuna"}\n\n` +
    `Eventi recenti:\n${eventLines || "Nessun evento"}`
  );
}

function formatTxLine(tx) {
  const hashPart = tx.txHash ? shortHash(tx.txHash, 14) : "n/d";
  return `${tx.shortId} | ${tx.currency} ${localizeStatus(tx.status)} | ${hashPart} | inv ${tx.invoiceShortId}`;
}

function formatTxDetails(tx) {
  const explorer = txExplorerUrl({
    currency: tx.currency,
    network: tx.network,
    txHash: tx.txHash,
  });

  return (
    `Transazione: ${tx.shortId}\n` +
    `ID tecnico: ${tx.id}\n` +
    `Stato: ${localizeStatus(tx.status)}\n` +
    `Valuta/Rete: ${tx.currency} ${tx.network}\n` +
    `Fattura: ${tx.invoiceShortId}\n` +
    `Importo atteso: ${tx.expectedAmountCrypto} ${tx.currency}\n` +
    `Importo pagato: ${tx.paidAmountCrypto !== null ? `${tx.paidAmountCrypto} ${tx.currency}` : "n/d"}\n` +
    `Conferme: ${tx.confirmations}\n` +
    `Tx hash: ${tx.txHash || "n/d"}\n` +
    `Explorer: ${explorer || "n/d"}\n` +
    `Aggiornata: ${new Date(tx.updatedAt).toLocaleString("it-IT")}`
  );
}

function parseNewInvoiceArgs(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(
      "Uso: /new_invoice o /nuova_fattura <importo_usd> [telegram_user_id] [valute]\nEsempio: /nuova_fattura 100 123456789 USDT,BTC,ETH",
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

    if (arg2 === "-" || arg2.toLowerCase() === "none" || arg2.toLowerCase() === "nessuno") {
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
  if (normalized === "-" || normalized.toLowerCase() === "skip" || normalized.toLowerCase() === "salta") {
    return null;
  }
  if (!/^\d{5,20}$/.test(normalized)) {
    throw new Error("ID utente Telegram non valido. Usa un numero o '-' per saltare.");
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
    normalized.toLowerCase() === "all" ||
    normalized.toLowerCase() === "tutto"
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
    `Riferimento: ${invoice.shortId}\n` +
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
  const metrics = getDashboardMetrics();
  const pending = listInvoices({ status: "pending", limit: 5 });
  const introPrefix = intro ? `${intro}\n\n` : "";

  const text =
    `${introPrefix}` +
    `Panoramica amministrativa\n` +
    `Fatture: ${metrics.invoices.total} (in attesa ${metrics.invoices.pending}, pagate ${metrics.invoices.paid}, scadute ${metrics.invoices.expired})\n` +
    `Transazioni: ${metrics.payments.total} (confermate ${metrics.payments.confirmed}, in attesa pagamento ${metrics.payments.awaiting_payment})\n` +
    `Volume: pagato ${metrics.volume.paidUsd.toFixed(2)} USD | in attesa ${metrics.volume.pendingUsd.toFixed(2)} USD\n\n` +
    `Ultime aperte:\n` +
    (pending.length
      ? pending.map((invoice) => formatInvoiceLine(invoice)).join("\n\n")
      : "Nessuna fattura aperta.") +
    `\n\nComandi rapidi: /stato_fattura <INV-...>, /dettaglio_fattura <INV-...>, /flusso_tx, /stato_tx <TX-...>, /elimina_fattura <INV-...>`;

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
    "/my_invoices o /mie_fatture - Elenco fatture aperte associate\n" +
    "/help o /aiuto - Mostra questo aiuto";

  if (!isAdmin) {
    await sendMessage(message.chat.id, baseText);
    return;
  }

  const adminText =
    `${baseText}\n\n` +
    "Comandi amministratore:\n" +
    "/admin - Apri panoramica\n" +
    "/nuova_fattura <importo_usd> [telegram_user_id] [valute]\n" +
    "/fatture_in_attesa\n" +
    "/stato_fattura <rif_fattura>\n" +
    "/dettaglio_fattura <rif_fattura>\n" +
    "/flusso_tx\n" +
    "/stato_tx <rif_tx|tx_hash>\n" +
    "/elimina_fattura <rif_fattura>\n" +
    "/elimina_tutte_fatture\n" +
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
    `Rif: ${invoice.shortId}\n` +
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
  const isSlashCommand = text.startsWith("/new_invoice") || text.startsWith("/nuova_fattura");
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
  const invoices = listInvoices({ status: "pending", limit: 15 });
  if (!invoices.length) {
    await sendMessage(message.chat.id, "Nessuna fattura aperta.", adminKeyboard());
    return;
  }

  const text =
    `Fatture aperte: ${invoices.length}\n\n` +
    invoices
      .map(
        (invoice) =>
          `${invoice.shortId} | ${invoice.amountUsd.toFixed(2)} USD | scade ${new Date(
            invoice.expiresAt,
          ).toLocaleString("it-IT")}`,
      )
      .join("\n");
  await sendMessage(message.chat.id, text, adminKeyboard());
}

async function requestInvoiceStatus(message) {
  setAdminSession(message.chat.id, ADMIN_MODES.STATUS_REF);
  await sendMessage(
    message.chat.id,
    "Inserisci riferimento fattura (esempio: INV-ABC1234) oppure UUID.",
    adminKeyboard(),
  );
}

async function requestInvoiceDetails(message) {
  setAdminSession(message.chat.id, ADMIN_MODES.DETAIL_REF);
  await sendMessage(
    message.chat.id,
    "Inserisci riferimento fattura per vedere dettagli e log.",
    adminKeyboard(),
  );
}

async function processInvoiceStatusByRef(message, invoiceRefRaw) {
  const invoiceRef = String(invoiceRefRaw || "").trim();
  if (!invoiceRef) {
    throw new Error("Riferimento fattura mancante.");
  }
  const status = getInvoiceStatusByRef(invoiceRef);
  if (!status) {
    await sendMessage(message.chat.id, "Fattura non trovata.", adminKeyboard());
    return;
  }
  await sendMessage(message.chat.id, formatInvoiceStatus(status), adminKeyboard());
}

async function processInvoiceDetailsByRef(message, invoiceRefRaw) {
  const invoiceRef = String(invoiceRefRaw || "").trim();
  if (!invoiceRef) {
    throw new Error("Riferimento fattura mancante.");
  }

  const details = getInvoiceAdminDetailsByRef(invoiceRef);
  if (!details) {
    await sendMessage(message.chat.id, "Fattura non trovata.", adminKeyboard());
    return;
  }

  await sendMessage(message.chat.id, formatInvoiceDetails(details), adminKeyboard());
}

async function showRecentTransactions(message) {
  const transactions = listRecentTransactions({
    limit: 12,
    status: "confirmed",
  });
  if (!transactions.length) {
    await sendMessage(
      message.chat.id,
      "Nessuna transazione confermata disponibile.",
      adminKeyboard(),
    );
    return;
  }

  const text =
    `Flusso transazioni (ultime ${transactions.length}):\n\n` +
    transactions.map((tx) => formatTxLine(tx)).join("\n");
  await sendMessage(message.chat.id, text, adminKeyboard());
}

async function requestTxDetails(message) {
  setAdminSession(message.chat.id, ADMIN_MODES.TX_REF);
  await sendMessage(
    message.chat.id,
    "Inserisci riferimento tx (esempio: TX-ABC1234) oppure hash tx.",
    adminKeyboard(),
  );
}

async function processTxDetailsByRef(message, txRefRaw) {
  const txRef = String(txRefRaw || "").trim();
  if (!txRef) {
    throw new Error("Riferimento tx mancante.");
  }
  const tx = getTransactionByRef(txRef);
  if (!tx) {
    await sendMessage(message.chat.id, "Transazione non trovata.", adminKeyboard());
    return;
  }

  await sendMessage(message.chat.id, formatTxDetails(tx), adminKeyboard());
}

async function requestDeleteOne(message) {
  setAdminSession(message.chat.id, ADMIN_MODES.DELETE_ONE_REF);
  await sendMessage(
    message.chat.id,
    "Inserisci riferimento fattura da eliminare (esempio: INV-ABC1234).",
    adminKeyboard(),
  );
}

async function processDeleteOneByRef(message, invoiceRefRaw) {
  const invoiceRef = String(invoiceRefRaw || "").trim();
  if (!invoiceRef) {
    throw new Error("Riferimento fattura mancante.");
  }

  const summary = deleteInvoiceByRef(invoiceRef, String(message.from.id));
  if (!summary) {
    await sendMessage(message.chat.id, "Fattura non trovata.", adminKeyboard());
    return;
  }

  clearAdminSession(message.chat.id);
  await sendAdminDashboard(
    message.chat.id,
    `Fattura eliminata.\nRif: ${summary.invoiceShortId}\nPagamenti eliminati: ${summary.deletedPayments}`,
  );
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
    `Eliminazione completata.\nFatture eliminate: ${summary.deletedInvoices}\nPagamenti eliminati: ${summary.deletedPayments}`,
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

  if (isAdminControlText(text)) {
    clearAdminSession(message.chat.id);
    return false;
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
      "Inserisci ID Telegram cliente oppure '-' per saltare.",
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
      `Fattura creata.\nRif: ${invoice.shortId}\nImporto: ${invoice.amountUsd.toFixed(
        2,
      )} USD\nValute: ${invoice.allowedCurrencies.join(", ")}\nLink: ${invoice.paymentUrl}`,
    );
    return true;
  }

  if (session.mode === ADMIN_MODES.STATUS_REF) {
    clearAdminSession(message.chat.id);
    await processInvoiceStatusByRef(message, text);
    return true;
  }

  if (session.mode === ADMIN_MODES.DETAIL_REF) {
    clearAdminSession(message.chat.id);
    await processInvoiceDetailsByRef(message, text);
    return true;
  }

  if (session.mode === ADMIN_MODES.TX_REF) {
    clearAdminSession(message.chat.id);
    await processTxDetailsByRef(message, text);
    return true;
  }

  if (session.mode === ADMIN_MODES.DELETE_ONE_REF) {
    await processDeleteOneByRef(message, text);
    return true;
  }

  if (session.mode === ADMIN_MODES.DELETE_CONFIRM) {
    await processDeleteAll(message, text);
    return true;
  }

  return false;
}

async function handleAdminMessage(message, text) {
  const handledBySession = await handleAdminSessionInput(message, text);
  if (handledBySession) {
    return true;
  }

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

  if (
    text.startsWith("/admin") ||
    text.startsWith("/admin_dashboard") ||
    text === ADMIN_BUTTONS.DASHBOARD
  ) {
    clearAdminSession(message.chat.id);
    await sendAdminDashboard(message.chat.id);
    return true;
  }

  if (text === ADMIN_BUTTONS.HELP || text.startsWith("/help") || text.startsWith("/aiuto")) {
    clearAdminSession(message.chat.id);
    await handleHelp(message);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.CREATE ||
    text.startsWith("/new_invoice") ||
    text.startsWith("/nuova_fattura")
  ) {
    clearAdminSession(message.chat.id);
    await handleNewInvoiceCommand(message);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.LIST ||
    text.startsWith("/pending_invoices") ||
    text.startsWith("/fatture_in_attesa")
  ) {
    clearAdminSession(message.chat.id);
    await showPendingInvoices(message);
    return true;
  }

  if (text.startsWith("/invoice_status") || text.startsWith("/stato_fattura")) {
    clearAdminSession(message.chat.id);
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await requestInvoiceStatus(message);
      return true;
    }
    await processInvoiceStatusByRef(message, parts[1]);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.DETAIL ||
    text.startsWith("/invoice_detail") ||
    text.startsWith("/dettaglio_fattura") ||
    text.startsWith("/invoice_logs")
  ) {
    clearAdminSession(message.chat.id);
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await requestInvoiceDetails(message);
      return true;
    }
    await processInvoiceDetailsByRef(message, parts[1]);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.TX_FEED ||
    text.startsWith("/tx_feed") ||
    text.startsWith("/flusso_tx")
  ) {
    clearAdminSession(message.chat.id);
    await showRecentTransactions(message);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.TX_DETAIL ||
    text.startsWith("/tx_status") ||
    text.startsWith("/stato_tx") ||
    text.startsWith("/tx_detail") ||
    text.startsWith("/dettaglio_tx")
  ) {
    clearAdminSession(message.chat.id);
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await requestTxDetails(message);
      return true;
    }
    await processTxDetailsByRef(message, parts[1]);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.DELETE_ONE ||
    text.startsWith("/invoice_delete") ||
    text.startsWith("/elimina_fattura")
  ) {
    clearAdminSession(message.chat.id);
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await requestDeleteOne(message);
      return true;
    }
    await processDeleteOneByRef(message, parts[1]);
    return true;
  }

  if (
    text === ADMIN_BUTTONS.DELETE_ALL ||
    text.startsWith("/delete_all_invoices") ||
    text.startsWith("/elimina_tutte_fatture")
  ) {
    clearAdminSession(message.chat.id);
    await requestDeleteAll(message);
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
  const isAdminCommand =
    isAdminControlText(text) &&
    !text.startsWith("/help") &&
    !text.startsWith("/aiuto") &&
    !text.startsWith("/cancel");

  if (isAdmin) {
    const handled = await handleAdminMessage(message, text);
    if (handled) {
      return;
    }
    await sendAdminDashboard(
      message.chat.id,
      "Comando non riconosciuto. Usa il menu admin o /aiuto.",
    );
    return;
  }

  if (text.startsWith("/start")) {
    await handleStart(message);
    return;
  }
  if (text.startsWith("/help") || text.startsWith("/aiuto")) {
    await handleHelp(message);
    return;
  }
  if (text.startsWith("/my_invoices") || text.startsWith("/mie_fatture")) {
    await handleMyInvoices(message);
    return;
  }

  if (isAdminCommand) {
    await sendMessage(
      message.chat.id,
      "Comando riservato all'amministratore.",
    );
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
  if (!config.adminTelegramIds.length) {
    throw new Error("ADMIN_TELEGRAM_IDS obbligatorio: whitelist admin mancante.");
  }
  if (!String(config.appBaseUrl || "").toLowerCase().startsWith("https://")) {
    throw new Error("APP_BASE_URL deve iniziare con https:// per registrare il webhook Telegram.");
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
