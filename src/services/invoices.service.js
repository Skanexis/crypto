const crypto = require("crypto");
const config = require("../config");
const { db, nowIso, toJson, fromJson, logEvent } = require("../db");
const { CURRENCY_META, fetchRatesUsd } = require("./rates.service");

const ALL_CURRENCIES = Object.keys(CURRENCY_META);
const OPEN_INVOICE_STATUSES = ["pending"];
const OPEN_PAYMENT_STATUSES = ["awaiting_payment", "pending_confirmation"];

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

function normalizeCurrencies(input) {
  if (!input) {
    return [...ALL_CURRENCIES];
  }

  const values = Array.isArray(input) ? input : String(input).split(",");
  const normalized = values
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);

  const unique = [...new Set(normalized)];
  for (const currency of unique) {
    if (!ALL_CURRENCIES.includes(currency)) {
      throw new Error(`Valuta non supportata: ${currency}`);
    }
  }

  if (!unique.length) {
    throw new Error("Devi selezionare almeno una valuta");
  }
  return unique;
}

function currencyDecimals(currency) {
  return CURRENCY_META[currency]?.decimals ?? 8;
}

function toFixedUp(value, decimals) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getWalletAddress(currency) {
  const address = config.walletAddresses[currency];
  if (!address) {
    throw new Error(`Wallet non configurato per ${currency}`);
  }
  return String(address).trim();
}

function isValidEthAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function isValidTronAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(value || "").trim());
}

function isValidBtcAddress(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,90}$/i.test(normalized);
}

function assertWalletAddressValid({ currency, network, walletAddress }) {
  const net = String(network || "").toUpperCase();
  const wallet = String(walletAddress || "").trim();

  if (currency === "ETH" || net.includes("ERC20")) {
    if (!isValidEthAddress(wallet)) {
      throw new Error(`Wallet ${currency} non valido (formato EVM atteso)`);
    }
    return;
  }

  if (currency === "USDT" && (net.includes("TRC20") || net.includes("TRON"))) {
    if (!isValidTronAddress(wallet)) {
      throw new Error("Wallet USDT TRC20 non valido (indirizzo Tron atteso)");
    }
    return;
  }

  if (currency === "BTC") {
    if (!isValidBtcAddress(wallet)) {
      throw new Error("Wallet BTC non valido");
    }
  }
}

function reserveUniqueExpectedAmount({ currency, walletAddress, baseAmount }) {
  const decimals = currencyDecimals(currency);
  const step = 1 / 10 ** decimals;
  const maxBumps = Math.max(1, Number(config.uniqueAmountMaxBumps || 2000));
  const graceMs = Math.max(0, Number(config.paymentLateGraceMinutes || 0)) * 60 * 1000;
  const cutoffIso = new Date(Date.now() - graceMs).toISOString();

  const rows = db
    .prepare(
      `
        SELECT p.expected_amount_crypto
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.currency = ?
          AND p.wallet_address = ?
          AND p.status IN (${OPEN_PAYMENT_STATUSES.map(() => "?").join(", ")})
          AND i.status IN (${OPEN_INVOICE_STATUSES.map(() => "?").join(", ")})
          AND i.expires_at > ?
      `,
    )
    .all(
      currency,
      walletAddress,
      ...OPEN_PAYMENT_STATUSES,
      ...OPEN_INVOICE_STATUSES,
      cutoffIso,
    );

  const occupied = new Set(
    rows.map((row) => Number(row.expected_amount_crypto).toFixed(decimals)),
  );

  let candidate = toFixedUp(baseAmount, decimals);
  for (let i = 0; i <= maxBumps; i += 1) {
    const key = candidate.toFixed(decimals);
    if (!occupied.has(key)) {
      return candidate;
    }
    candidate = roundTo(candidate + step, decimals);
  }

  throw new Error(
    `Impossibile assegnare importo univoco per ${currency}, troppi pagamenti aperti`,
  );
}

function toInvoiceDto(row, paymentRows) {
  if (!row) {
    return null;
  }
  const invoiceExpired =
    new Date(row.expires_at).getTime() <= Date.now() || row.status === "expired";
  const computedStatus = row.status === "pending" && invoiceExpired ? "expired" : row.status;

  const invoice = {
    id: row.id,
    token: row.public_token,
    amountUsd: Number(row.amount_usd),
    allowedCurrencies: fromJson(row.allowed_currencies, []),
    exchangeSnapshot: fromJson(row.exchange_snapshot, {}),
    status: computedStatus,
    expiresAt: row.expires_at,
    telegramUserId: row.telegram_user_id,
    createdByAdminId: row.created_by_admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paymentUrl: `${config.appBaseUrl}/pay/${row.public_token}`,
  };

  if (paymentRows) {
    invoice.payments = paymentRows.map((payment) => ({
      id: payment.id,
      currency: payment.currency,
      network: payment.network,
      walletAddress: payment.wallet_address,
      expectedAmountCrypto: Number(payment.expected_amount_crypto),
      paidAmountCrypto: payment.paid_amount_crypto
        ? Number(payment.paid_amount_crypto)
        : null,
      txHash: payment.tx_hash,
      confirmations: Number(payment.confirmations || 0),
      status: payment.status,
      createdAt: payment.created_at,
      updatedAt: payment.updated_at,
    }));
  }

  invoice.expired = invoiceExpired;
  return invoice;
}

function getInvoiceWithPaymentsById(id) {
  const invoiceRow = db
    .prepare(
      `
        SELECT * FROM invoices WHERE id = ?
      `,
    )
    .get(id);
  if (!invoiceRow) {
    return null;
  }
  const paymentRows = db
    .prepare(
      `
        SELECT * FROM payments WHERE invoice_id = ? ORDER BY currency
      `,
    )
    .all(id);
  return toInvoiceDto(invoiceRow, paymentRows);
}

function getInvoiceWithPaymentsByToken(token) {
  const invoiceRow = db
    .prepare(
      `
        SELECT * FROM invoices WHERE public_token = ?
      `,
    )
    .get(token);
  if (!invoiceRow) {
    return null;
  }
  const paymentRows = db
    .prepare(
      `
        SELECT * FROM payments WHERE invoice_id = ? ORDER BY currency
      `,
    )
    .all(invoiceRow.id);
  return toInvoiceDto(invoiceRow, paymentRows);
}

async function createInvoice({
  amountUsd,
  allowedCurrencies,
  telegramUserId,
  createdByAdminId,
}) {
  const parsedAmount = Number(amountUsd);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Importo USD non valido");
  }

  const currencies = normalizeCurrencies(allowedCurrencies);
  const ratesUsd = await fetchRatesUsd();

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.invoiceTtlMinutes * 60 * 1000,
  );
  const invoiceId = crypto.randomUUID();
  const token = randomToken(24);
  const createdAt = now.toISOString();

  const exchangeSnapshot = {
    ratesUsd,
    fetchedAt: createdAt,
  };

  const payments = currencies.map((currency) => {
    const decimals = currencyDecimals(currency);
    const walletAddress = getWalletAddress(currency);
    const network = config.networks[currency];
    assertWalletAddressValid({
      currency,
      network,
      walletAddress,
    });
    const baseAmount = toFixedUp(parsedAmount / ratesUsd[currency], decimals);
    const expectedAmountCrypto = reserveUniqueExpectedAmount({
      currency,
      walletAddress,
      baseAmount,
    });
    return {
      id: crypto.randomUUID(),
      invoiceId,
      currency,
      network,
      walletAddress,
      expectedAmountCrypto,
      status: "awaiting_payment",
      createdAt,
      updatedAt: createdAt,
    };
  });

  const tx = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO invoices (
          id,
          public_token,
          amount_usd,
          allowed_currencies,
          exchange_snapshot,
          status,
          expires_at,
          telegram_user_id,
          created_by_admin_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      invoiceId,
      token,
      parsedAmount,
      toJson(currencies),
      toJson(exchangeSnapshot),
      "pending",
      expiresAt.toISOString(),
      telegramUserId ? String(telegramUserId) : null,
      createdByAdminId ? String(createdByAdminId) : null,
      createdAt,
      createdAt,
    );

    const insertPayment = db.prepare(
      `
        INSERT INTO payments (
          id,
          invoice_id,
          currency,
          network,
          wallet_address,
          expected_amount_crypto,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const payment of payments) {
      insertPayment.run(
        payment.id,
        payment.invoiceId,
        payment.currency,
        payment.network,
        payment.walletAddress,
        payment.expectedAmountCrypto,
        payment.status,
        payment.createdAt,
        payment.updatedAt,
      );
    }
  });

  tx();

  logEvent("invoice", invoiceId, "created", {
    amountUsd: parsedAmount,
    currencies,
    telegramUserId: telegramUserId ? String(telegramUserId) : null,
  });

  return getInvoiceWithPaymentsById(invoiceId);
}

function upsertTelegramUser({ telegramUserId, username, firstName }) {
  const id = String(telegramUserId);
  const now = nowIso();
  const existing = db
    .prepare(`SELECT id FROM users WHERE telegram_user_id = ?`)
    .get(id);
  if (existing) {
    db.prepare(
      `
        UPDATE users
        SET username = ?, first_name = ?
        WHERE telegram_user_id = ?
      `,
    ).run(username || null, firstName || null, id);
    return;
  }

  db.prepare(
    `
      INSERT INTO users (telegram_user_id, username, first_name, created_at)
      VALUES (?, ?, ?, ?)
    `,
  ).run(id, username || null, firstName || null, now);
}

function listOpenInvoicesForTelegramUser(telegramUserId) {
  const rows = db
    .prepare(
      `
        SELECT * FROM invoices
        WHERE telegram_user_id = ?
          AND status IN (${OPEN_INVOICE_STATUSES.map(() => "?").join(", ")})
        ORDER BY created_at DESC
      `,
    )
    .all(String(telegramUserId), ...OPEN_INVOICE_STATUSES);

  return rows.map((row) => toInvoiceDto(row, null));
}

function expireDueInvoices() {
  const now = nowIso();
  const graceMs = Math.max(0, Number(config.paymentLateGraceMinutes || 0)) * 60 * 1000;
  const cutoffIso = new Date(Date.now() - graceMs).toISOString();
  const overdueRows = db
    .prepare(
      `
        SELECT id FROM invoices
        WHERE status = 'pending'
          AND expires_at <= ?
      `,
    )
    .all(cutoffIso);

  if (!overdueRows.length) {
    return 0;
  }

  const ids = overdueRows.map((item) => item.id);
  const placeholders = ids.map(() => "?").join(", ");

  db.prepare(
    `
      UPDATE invoices
      SET status = 'expired', updated_at = ?
      WHERE id IN (${placeholders})
    `,
  ).run(now, ...ids);

  db.prepare(
    `
      UPDATE payments
      SET status = 'expired', updated_at = ?
      WHERE invoice_id IN (${placeholders})
        AND status IN (${OPEN_PAYMENT_STATUSES.map(() => "?").join(", ")})
    `,
  ).run(now, ...ids, ...OPEN_PAYMENT_STATUSES);

  for (const id of ids) {
    logEvent("invoice", id, "expired", { expiredAt: now });
  }
  return ids.length;
}

function markInvoicePaid({
  invoiceId,
  currency,
  txHash,
  confirmations = 1,
  paidAmountCrypto = null,
}) {
  const normalizedCurrency = String(currency || "").toUpperCase();
  const normalizedTxHash = txHash ? String(txHash).trim().toLowerCase() : null;
  const invoiceRow = db
    .prepare(
      `
        SELECT id, status, expires_at
        FROM invoices
        WHERE id = ?
      `,
    )
    .get(invoiceId);
  if (!invoiceRow) {
    throw new Error("Fattura non trovata");
  }
  const invoice = getInvoiceWithPaymentsById(invoiceId);
  if (invoiceRow.status !== "pending") {
    return {
      invoice,
      changed: false,
      reason: "invoice_not_pending",
    };
  }

  const graceMs = Math.max(0, Number(config.paymentLateGraceMinutes || 0)) * 60 * 1000;
  const hardExpiryMs = new Date(invoiceRow.expires_at).getTime() + graceMs;
  if (Date.now() > hardExpiryMs) {
    return {
      invoice,
      changed: false,
      reason: "invoice_expired",
    };
  }

  const targetPayment = invoice.payments.find(
    (payment) => payment.currency === normalizedCurrency,
  );
  if (!targetPayment) {
    throw new Error("Valuta pagamento non valida per questa fattura");
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `
        UPDATE payments
        SET status = 'confirmed',
            paid_amount_crypto = ?,
            tx_hash = ?,
            confirmations = ?,
            updated_at = ?
        WHERE id = ?
      `,
    ).run(
      paidAmountCrypto !== null ? Number(paidAmountCrypto) : null,
      normalizedTxHash || null,
      Number(confirmations || 0),
      now,
      targetPayment.id,
    );

    db.prepare(
      `
        UPDATE payments
        SET status = 'cancelled', updated_at = ?
        WHERE invoice_id = ?
          AND id != ?
          AND status IN (${OPEN_PAYMENT_STATUSES.map(() => "?").join(", ")})
      `,
    ).run(now, invoiceId, targetPayment.id, ...OPEN_PAYMENT_STATUSES);

    db.prepare(
      `
        UPDATE invoices
        SET status = 'paid',
            updated_at = ?
        WHERE id = ?
      `,
    ).run(now, invoiceId);
  });

  try {
    tx();
  } catch (error) {
    const message = String(error.message || "");
    if (message.includes("idx_payments_tx_hash_unique")) {
      return {
        invoice: getInvoiceWithPaymentsById(invoiceId),
        changed: false,
        reason: "tx_hash_already_used",
      };
    }
    throw error;
  }

  logEvent("invoice", invoiceId, "paid", {
    currency: normalizedCurrency,
    txHash: normalizedTxHash || null,
    confirmations: Number(confirmations || 0),
    paidAmountCrypto: paidAmountCrypto !== null ? Number(paidAmountCrypto) : null,
  });

  return {
    invoice: getInvoiceWithPaymentsById(invoiceId),
    changed: true,
    reason: "paid",
  };
}

function getInvoiceStatusById(invoiceId) {
  const invoice = getInvoiceWithPaymentsById(invoiceId);
  if (!invoice) {
    return null;
  }
  return {
    invoiceId: invoice.id,
    token: invoice.token,
    status: invoice.status,
    expiresAt: invoice.expiresAt,
    expired: invoice.expired,
    telegramUserId: invoice.telegramUserId,
    createdByAdminId: invoice.createdByAdminId,
    payments: invoice.payments,
    amountUsd: invoice.amountUsd,
    paymentUrl: invoice.paymentUrl,
  };
}

function listPendingPaymentsForCurrencies(currencies) {
  const normalized = (currencies || [])
    .map((currency) => String(currency || "").toUpperCase())
    .filter(Boolean);
  if (!normalized.length) {
    return [];
  }

  const now = Date.now();
  const graceMs = Math.max(0, Number(config.paymentLateGraceMinutes || 0)) * 60 * 1000;
  const cutoffIso = new Date(now - graceMs).toISOString();
  const currencyPlaceholders = normalized.map(() => "?").join(", ");
  const openInvoicePlaceholders = OPEN_INVOICE_STATUSES.map(() => "?").join(", ");
  const openPaymentPlaceholders = OPEN_PAYMENT_STATUSES.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `
        SELECT
          i.id AS invoice_id,
          i.created_at AS invoice_created_at,
          i.expires_at AS invoice_expires_at,
          i.telegram_user_id,
          i.created_by_admin_id,
          i.amount_usd,
          p.id AS payment_id,
          p.currency,
          p.network,
          p.wallet_address,
          p.expected_amount_crypto,
          p.created_at AS payment_created_at
        FROM invoices i
        INNER JOIN payments p ON p.invoice_id = i.id
        WHERE i.status IN (${openInvoicePlaceholders})
          AND p.status IN (${openPaymentPlaceholders})
          AND i.expires_at > ?
          AND p.currency IN (${currencyPlaceholders})
        ORDER BY i.created_at ASC
      `,
    )
    .all(
      ...OPEN_INVOICE_STATUSES,
      ...OPEN_PAYMENT_STATUSES,
      cutoffIso,
      ...normalized,
    );

  return rows.map((row) => ({
    invoiceId: row.invoice_id,
    invoiceCreatedAt: row.invoice_created_at,
    invoiceExpiresAt: row.invoice_expires_at,
    telegramUserId: row.telegram_user_id,
    createdByAdminId: row.created_by_admin_id,
    amountUsd: Number(row.amount_usd),
    paymentId: row.payment_id,
    currency: row.currency,
    network: row.network,
    walletAddress: row.wallet_address,
    expectedAmountCrypto: Number(row.expected_amount_crypto),
    paymentCreatedAt: row.payment_created_at,
  }));
}

function isTxHashAlreadyUsed(txHash) {
  if (!txHash) {
    return false;
  }
  const row = db
    .prepare(
      `
        SELECT id
        FROM payments
        WHERE tx_hash = ?
        LIMIT 1
      `,
    )
    .get(String(txHash));
  return Boolean(row);
}

module.exports = {
  ALL_CURRENCIES,
  createInvoice,
  upsertTelegramUser,
  listOpenInvoicesForTelegramUser,
  getInvoiceWithPaymentsById,
  getInvoiceWithPaymentsByToken,
  getInvoiceStatusById,
  markInvoicePaid,
  expireDueInvoices,
  normalizeCurrencies,
  listPendingPaymentsForCurrencies,
  isTxHashAlreadyUsed,
};
