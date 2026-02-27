const crypto = require("crypto");
const config = require("../config");
const { db, nowIso, toJson, fromJson, logEvent } = require("../db");
const { CURRENCY_META, fetchRatesUsd } = require("./rates.service");

const ALL_CURRENCIES = Object.keys(CURRENCY_META);
const OPEN_INVOICE_STATUSES = ["pending"];
const OPEN_PAYMENT_STATUSES = ["awaiting_payment", "pending_confirmation"];

const SHORT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVOICE_SHORT_PREFIX = "INV";
const PAYMENT_SHORT_PREFIX = "TX";
const SHORT_CODE_LENGTH = 7;

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

function randomShortCode(size = SHORT_CODE_LENGTH) {
  const bytes = crypto.randomBytes(size);
  let value = "";
  for (let i = 0; i < size; i += 1) {
    value += SHORT_ALPHABET[bytes[i] % SHORT_ALPHABET.length];
  }
  return value;
}

function allocateUniqueShortId(prefix, tableName) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const shortId = `${prefix}-${randomShortCode()}`;
    const row = db
      .prepare(`SELECT id FROM ${tableName} WHERE short_id = ? LIMIT 1`)
      .get(shortId);
    if (!row) {
      return shortId;
    }
  }
  throw new Error(`Impossibile generare short ID univoco per ${tableName}`);
}

function allocateInvoiceShortId() {
  return allocateUniqueShortId(INVOICE_SHORT_PREFIX, "invoices");
}

function allocatePaymentShortId() {
  return allocateUniqueShortId(PAYMENT_SHORT_PREFIX, "payments");
}

function backfillMissingShortIds() {
  const tx = db.transaction(() => {
    const invoices = db
      .prepare(
        `
          SELECT id
          FROM invoices
          WHERE short_id IS NULL OR TRIM(short_id) = ''
        `,
      )
      .all();

    const updateInvoice = db.prepare(
      `
        UPDATE invoices
        SET short_id = ?
        WHERE id = ?
      `,
    );

    for (const row of invoices) {
      updateInvoice.run(allocateInvoiceShortId(), row.id);
    }

    const payments = db
      .prepare(
        `
          SELECT id
          FROM payments
          WHERE short_id IS NULL OR TRIM(short_id) = ''
        `,
      )
      .all();

    const updatePayment = db.prepare(
      `
        UPDATE payments
        SET short_id = ?
        WHERE id = ?
      `,
    );

    for (const row of payments) {
      updatePayment.run(allocatePaymentShortId(), row.id);
    }
  });

  tx();
}

backfillMissingShortIds();

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

function isValidEthTxHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || "").trim());
}

function isValidHex64(value) {
  return /^[a-fA-F0-9]{64}$/.test(String(value || "").trim());
}

function assertTxHashValidForPayment({ currency, network, txHash }) {
  const normalizedHash = String(txHash || "").trim();
  if (!normalizedHash) {
    return;
  }

  const curr = String(currency || "").toUpperCase();
  const net = String(network || "").toUpperCase();

  if (curr === "ETH" || net.includes("ERC20") || net.includes("ETH")) {
    if (!isValidEthTxHash(normalizedHash)) {
      throw new Error("Tx hash ETH non valido (formato 0x + 64 hex)");
    }
    return;
  }

  if (curr === "USDT" && (net.includes("TRC20") || net.includes("TRON"))) {
    if (!isValidHex64(normalizedHash)) {
      throw new Error("Tx hash TRON non valido (64 caratteri hex)");
    }
    return;
  }

  if (curr === "BTC" || net.includes("BTC") || net.includes("BITCOIN")) {
    if (!isValidHex64(normalizedHash)) {
      throw new Error("Tx hash BTC non valido (64 caratteri hex)");
    }
  }
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
    shortId: row.short_id || `${INVOICE_SHORT_PREFIX}-${String(row.id || "").slice(0, 8).toUpperCase()}`,
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
    txHashPreview: row.tx_hash_preview || null,
    txShortIdPreview: row.tx_short_id_preview || null,
    paymentUrl: `${config.appBaseUrl}/pay/${row.public_token}`,
  };

  if (paymentRows) {
    invoice.payments = paymentRows.map((payment) => ({
      id: payment.id,
      shortId:
        payment.short_id ||
        `${PAYMENT_SHORT_PREFIX}-${String(payment.id || "").slice(0, 8).toUpperCase()}`,
      currency: payment.currency,
      network: payment.network,
      walletAddress: payment.wallet_address,
      expectedAmountCrypto: Number(payment.expected_amount_crypto),
      paidAmountCrypto:
        payment.paid_amount_crypto !== null && payment.paid_amount_crypto !== undefined
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

function isInvoiceExpired(invoice) {
  if (!invoice) {
    return false;
  }
  return Boolean(invoice.expired || new Date(invoice.expiresAt).getTime() <= Date.now());
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

function normalizeInvoiceRef(invoiceRef) {
  return String(invoiceRef || "").trim();
}

function resolveInvoiceIdByRef(invoiceRef) {
  const raw = normalizeInvoiceRef(invoiceRef);
  if (!raw) {
    return null;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    const byId = db.prepare(`SELECT id FROM invoices WHERE id = ?`).get(raw);
    if (byId) {
      return byId.id;
    }
  }

  const noHash = raw.replace(/^#/, "").toUpperCase();
  const candidates = new Set([noHash]);
  if (!noHash.startsWith(`${INVOICE_SHORT_PREFIX}-`)) {
    candidates.add(`${INVOICE_SHORT_PREFIX}-${noHash}`);
  }

  for (const candidate of candidates) {
    const byShort = db
      .prepare(
        `
          SELECT id
          FROM invoices
          WHERE UPPER(short_id) = ?
          LIMIT 1
        `,
      )
      .get(candidate);
    if (byShort) {
      return byShort.id;
    }
  }

  if (/^[0-9a-f]{8}$/i.test(raw)) {
    const byPrefix = db
      .prepare(
        `
          SELECT id
          FROM invoices
          WHERE LOWER(SUBSTR(id, 1, 8)) = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(raw.toLowerCase());
    if (byPrefix) {
      return byPrefix.id;
    }
  }

  return null;
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
  const expiresAt = new Date(now.getTime() + config.invoiceTtlMinutes * 60 * 1000);
  const invoiceId = crypto.randomUUID();
  const invoiceShortId = allocateInvoiceShortId();
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
      shortId: allocatePaymentShortId(),
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
          short_id,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      invoiceId,
      invoiceShortId,
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
          short_id,
          invoice_id,
          currency,
          network,
          wallet_address,
          expected_amount_crypto,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const payment of payments) {
      insertPayment.run(
        payment.id,
        payment.shortId,
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
    invoiceShortId,
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

function listPendingInvoices(limit = 10) {
  const max = Math.max(1, Math.min(200, Number(limit || 10)));
  const rows = db
    .prepare(
      `
        SELECT * FROM invoices
        WHERE status = 'pending'
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(max);

  return rows.map((row) => toInvoiceDto(row, null));
}

function listInvoices({ status = "all", limit = 50, search = "" } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit || 50)));
  const filters = [];
  const params = [];

  if (String(status || "").toLowerCase() !== "all") {
    filters.push("i.status = ?");
    params.push(String(status).toLowerCase());
  }

  const trimmedSearch = String(search || "").trim();
  if (trimmedSearch) {
    filters.push(
      `(
        i.id LIKE ? OR
        i.short_id LIKE ? OR
        i.telegram_user_id LIKE ? OR
        i.public_token LIKE ?
      )`,
    );
    const wildcard = `%${trimmedSearch}%`;
    params.push(wildcard, wildcard, wildcard, wildcard);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
        SELECT
          i.*,
          (
            SELECT p.tx_hash
            FROM payments p
            WHERE p.invoice_id = i.id
              AND p.tx_hash IS NOT NULL
            ORDER BY p.updated_at DESC
            LIMIT 1
          ) AS tx_hash_preview,
          (
            SELECT p.short_id
            FROM payments p
            WHERE p.invoice_id = i.id
              AND p.tx_hash IS NOT NULL
            ORDER BY p.updated_at DESC
            LIMIT 1
          ) AS tx_short_id_preview
        FROM invoices i
        ${whereClause}
        ORDER BY i.created_at DESC
        LIMIT ?
      `,
    )
    .all(...params, max);

  return rows.map((row) => toInvoiceDto(row, null));
}

function deleteAllInvoices() {
  const now = nowIso();
  const summary = {
    deletedInvoices: 0,
    deletedPayments: 0,
    deletedOpenInvoices: 0,
    deletedOpenPayments: 0,
    executedAt: now,
  };

  const tx = db.transaction(() => {
    const invoiceCountRow = db.prepare(`SELECT COUNT(*) AS total FROM invoices`).get();
    const paymentCountRow = db.prepare(`SELECT COUNT(*) AS total FROM payments`).get();
    const openInvoiceCountRow = db
      .prepare(`SELECT COUNT(*) AS total FROM invoices WHERE status = 'pending'`)
      .get();
    const openPaymentCountRow = db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM payments
          WHERE status IN (${OPEN_PAYMENT_STATUSES.map(() => "?").join(", ")})
        `,
      )
      .get(...OPEN_PAYMENT_STATUSES);

    summary.deletedInvoices = Number(invoiceCountRow?.total || 0);
    summary.deletedPayments = Number(paymentCountRow?.total || 0);
    summary.deletedOpenInvoices = Number(openInvoiceCountRow?.total || 0);
    summary.deletedOpenPayments = Number(openPaymentCountRow?.total || 0);

    db.prepare(`DELETE FROM invoices`).run();
  });

  tx();

  logEvent("invoice", "*", "bulk_deleted", summary);
  return summary;
}

function deleteInvoiceByRef(invoiceRef, deletedBy = "admin") {
  const invoiceId = resolveInvoiceIdByRef(invoiceRef);
  if (!invoiceId) {
    return null;
  }

  const invoice = getInvoiceWithPaymentsById(invoiceId);
  if (!invoice) {
    return null;
  }

  const deletedAt = nowIso();
  const summary = {
    invoiceId: invoice.id,
    invoiceShortId: invoice.shortId,
    deletedPayments: invoice.payments.length,
    deletedStatusBefore: invoice.status,
    deletedAt,
  };

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM invoices WHERE id = ?`).run(invoice.id);
  });

  tx();

  logEvent("invoice", invoice.id, "deleted", {
    by: String(deletedBy || "admin"),
    invoiceShortId: invoice.shortId,
    deletedPayments: invoice.payments.length,
    deletedStatusBefore: invoice.status,
    deletedAt,
  });

  return summary;
}

function expireDueInvoices() {
  const now = nowIso();
  const graceMs = Math.max(0, Number(config.paymentLateGraceMinutes || 0)) * 60 * 1000;
  const cutoffIso = new Date(Date.now() - graceMs).toISOString();
  const overdueRows = db
    .prepare(
      `
        SELECT id, short_id
        FROM invoices
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

  for (const row of overdueRows) {
    logEvent("invoice", row.id, "expired", {
      invoiceShortId: row.short_id,
      expiredAt: now,
    });
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

  if (normalizedTxHash) {
    assertTxHashValidForPayment({
      currency: targetPayment.currency,
      network: targetPayment.network,
      txHash: normalizedTxHash,
    });
  }

  const normalizedPaidAmount =
    paidAmountCrypto !== null && paidAmountCrypto !== undefined
      ? Number(paidAmountCrypto)
      : Number(targetPayment.expectedAmountCrypto);
  if (
    paidAmountCrypto !== null &&
    paidAmountCrypto !== undefined &&
    (!Number.isFinite(normalizedPaidAmount) || normalizedPaidAmount <= 0)
  ) {
    throw new Error("Importo pagato non valido");
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
      Number.isFinite(normalizedPaidAmount) ? normalizedPaidAmount : null,
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
    if (
      message.includes("idx_payments_tx_hash_unique") ||
      message.includes("UNIQUE constraint failed: payments.tx_hash")
    ) {
      return {
        invoice: getInvoiceWithPaymentsById(invoiceId),
        changed: false,
        reason: "tx_hash_already_used",
      };
    }
    throw error;
  }

  logEvent("invoice", invoiceId, "paid", {
    invoiceShortId: invoice.shortId,
    currency: normalizedCurrency,
    txHash: normalizedTxHash || null,
    confirmations: Number(confirmations || 0),
    paidAmountCrypto: Number.isFinite(normalizedPaidAmount)
      ? normalizedPaidAmount
      : null,
  });

  logEvent("payment", targetPayment.id, "confirmed", {
    paymentShortId: targetPayment.shortId,
    invoiceId,
    invoiceShortId: invoice.shortId,
    currency: normalizedCurrency,
    txHash: normalizedTxHash || null,
    confirmations: Number(confirmations || 0),
    paidAmountCrypto: Number.isFinite(normalizedPaidAmount)
      ? normalizedPaidAmount
      : null,
  });

  return {
    invoice: getInvoiceWithPaymentsById(invoiceId),
    changed: true,
    reason: "paid",
  };
}

function toInvoiceStatusDto(invoice) {
  return {
    invoiceId: invoice.id,
    invoiceShortId: invoice.shortId,
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

function getInvoiceStatusById(invoiceId) {
  const invoice = getInvoiceWithPaymentsById(invoiceId);
  if (!invoice) {
    return null;
  }
  return toInvoiceStatusDto(invoice);
}

function getInvoiceStatusByRef(invoiceRef) {
  const invoiceId = resolveInvoiceIdByRef(invoiceRef);
  if (!invoiceId) {
    return null;
  }
  return getInvoiceStatusById(invoiceId);
}

function toEventDto(row) {
  return {
    id: Number(row.id),
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    payload: fromJson(row.payload, null),
    createdAt: row.created_at,
  };
}

function listRecentEvents(limit = 100) {
  const max = Math.max(1, Math.min(1000, Number(limit || 100)));
  const rows = db
    .prepare(
      `
        SELECT *
        FROM events
        ORDER BY id DESC
        LIMIT ?
      `,
    )
    .all(max);

  return rows.map(toEventDto);
}

function listInvoiceEventsByRef(invoiceRef, limit = 120) {
  const invoiceId = resolveInvoiceIdByRef(invoiceRef);
  if (!invoiceId) {
    return [];
  }

  const invoice = getInvoiceWithPaymentsById(invoiceId);
  if (!invoice) {
    return [];
  }

  const max = Math.max(1, Math.min(1000, Number(limit || 120)));
  const paymentIds = invoice.payments.map((payment) => payment.id);
  const conditions = ["(entity_type = 'invoice' AND entity_id = ?)"];
  const params = [invoice.id];

  if (paymentIds.length) {
    conditions.push(
      `(entity_type = 'payment' AND entity_id IN (${paymentIds
        .map(() => "?")
        .join(", ")}))`,
    );
    params.push(...paymentIds);
  }

  const rows = db
    .prepare(
      `
        SELECT *
        FROM events
        WHERE ${conditions.join(" OR ")}
        ORDER BY id DESC
        LIMIT ?
      `,
    )
    .all(...params, max);

  const paymentMap = new Map(invoice.payments.map((payment) => [payment.id, payment]));
  return rows.map((row) => {
    const event = toEventDto(row);
    if (event.entityType === "invoice") {
      return {
        ...event,
        entityShortId: invoice.shortId,
      };
    }

    const payment = paymentMap.get(event.entityId);
    return {
      ...event,
      entityShortId: payment?.shortId || null,
      invoiceShortId: invoice.shortId,
    };
  });
}

function mapTransactionRow(row) {
  return {
    id: row.id,
    shortId: row.short_id,
    invoiceId: row.invoice_id,
    invoiceShortId: row.invoice_short_id,
    invoiceStatus: row.invoice_status,
    invoiceAmountUsd: Number(row.invoice_amount_usd),
    invoiceExpiresAt: row.invoice_expires_at,
    currency: row.currency,
    network: row.network,
    walletAddress: row.wallet_address,
    expectedAmountCrypto: Number(row.expected_amount_crypto),
    paidAmountCrypto:
      row.paid_amount_crypto !== null && row.paid_amount_crypto !== undefined
        ? Number(row.paid_amount_crypto)
        : null,
    txHash: row.tx_hash,
    confirmations: Number(row.confirmations || 0),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolvePaymentIdByRef(txRef) {
  const raw = String(txRef || "").trim();
  if (!raw) {
    return null;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    const byId = db.prepare(`SELECT id FROM payments WHERE id = ?`).get(raw);
    if (byId) {
      return byId.id;
    }
  }

  const noHash = raw.replace(/^#/, "").toUpperCase();
  const shortCandidates = new Set([noHash]);
  if (!noHash.startsWith(`${PAYMENT_SHORT_PREFIX}-`)) {
    shortCandidates.add(`${PAYMENT_SHORT_PREFIX}-${noHash}`);
  }

  for (const candidate of shortCandidates) {
    const byShort = db
      .prepare(
        `
          SELECT id
          FROM payments
          WHERE UPPER(short_id) = ?
          LIMIT 1
        `,
      )
      .get(candidate);
    if (byShort) {
      return byShort.id;
    }
  }

  const normalizedHash = raw.toLowerCase();
  const byHash = db
    .prepare(
      `
        SELECT id
        FROM payments
        WHERE LOWER(tx_hash) = ?
        LIMIT 1
      `,
    )
    .get(normalizedHash);
  if (byHash) {
    return byHash.id;
  }

  if (/^[0-9a-f]{8}$/i.test(raw)) {
    const byPrefix = db
      .prepare(
        `
          SELECT id
          FROM payments
          WHERE LOWER(SUBSTR(id, 1, 8)) = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(raw.toLowerCase());
    if (byPrefix) {
      return byPrefix.id;
    }
  }

  return null;
}

function listRecentTransactions({
  limit = 100,
  invoiceRef = null,
  search = "",
  status = "all",
} = {}) {
  const max = Math.max(1, Math.min(1000, Number(limit || 100)));
  const params = [];
  const where = [];

  if (invoiceRef) {
    const invoiceId = resolveInvoiceIdByRef(invoiceRef);
    if (!invoiceId) {
      return [];
    }
    where.push("i.id = ?");
    params.push(invoiceId);
  }

  const normalizedStatus = String(status || "all").toLowerCase();
  if (normalizedStatus !== "all") {
    where.push("p.status = ?");
    params.push(normalizedStatus);
  }

  const normalizedSearch = String(search || "").trim();
  if (normalizedSearch) {
    where.push(
      `(
        p.id LIKE ? OR
        p.short_id LIKE ? OR
        p.tx_hash LIKE ? OR
        i.id LIKE ? OR
        i.short_id LIKE ?
      )`,
    );
    const wildcard = `%${normalizedSearch}%`;
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.invoice_id,
          p.currency,
          p.network,
          p.wallet_address,
          p.expected_amount_crypto,
          p.paid_amount_crypto,
          p.tx_hash,
          p.confirmations,
          p.status,
          p.created_at,
          p.updated_at,
          i.short_id AS invoice_short_id,
          i.status AS invoice_status,
          i.amount_usd AS invoice_amount_usd,
          i.expires_at AS invoice_expires_at
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        ${whereSql}
        ORDER BY p.updated_at DESC
        LIMIT ?
      `,
    )
    .all(...params, max);

  return rows.map(mapTransactionRow);
}

function getTransactionByRef(txRef) {
  const paymentId = resolvePaymentIdByRef(txRef);
  if (!paymentId) {
    return null;
  }

  const row = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.invoice_id,
          p.currency,
          p.network,
          p.wallet_address,
          p.expected_amount_crypto,
          p.paid_amount_crypto,
          p.tx_hash,
          p.confirmations,
          p.status,
          p.created_at,
          p.updated_at,
          i.short_id AS invoice_short_id,
          i.status AS invoice_status,
          i.amount_usd AS invoice_amount_usd,
          i.expires_at AS invoice_expires_at
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.id = ?
        LIMIT 1
      `,
    )
    .get(paymentId);

  return row ? mapTransactionRow(row) : null;
}

function getInvoiceAdminDetailsByRef(invoiceRef) {
  const invoiceId = resolveInvoiceIdByRef(invoiceRef);
  if (!invoiceId) {
    return null;
  }

  const invoice = getInvoiceWithPaymentsById(invoiceId);
  if (!invoice) {
    return null;
  }

  return {
    invoice,
    events: listInvoiceEventsByRef(invoice.shortId, 160),
    transactions: listRecentTransactions({ limit: 120, invoiceRef: invoice.shortId }),
  };
}

function getDashboardMetrics() {
  const invoiceTotal = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM invoices`).get()?.total || 0,
  );
  const invoiceByStatusRows = db
    .prepare(
      `
        SELECT status, COUNT(*) AS total
        FROM invoices
        GROUP BY status
      `,
    )
    .all();

  const paymentTotal = Number(
    db.prepare(`SELECT COUNT(*) AS total FROM payments`).get()?.total || 0,
  );
  const paymentByStatusRows = db
    .prepare(
      `
        SELECT status, COUNT(*) AS total
        FROM payments
        GROUP BY status
      `,
    )
    .all();

  const paidUsd = Number(
    db
      .prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM invoices WHERE status = 'paid'`)
      .get()?.total || 0,
  );
  const pendingUsd = Number(
    db
      .prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM invoices WHERE status = 'pending'`)
      .get()?.total || 0,
  );

  const invoiceByStatus = {
    pending: 0,
    paid: 0,
    expired: 0,
    cancelled: 0,
  };
  for (const row of invoiceByStatusRows) {
    invoiceByStatus[String(row.status || "").toLowerCase()] = Number(row.total || 0);
  }

  const paymentByStatus = {
    awaiting_payment: 0,
    pending_confirmation: 0,
    confirmed: 0,
    cancelled: 0,
    expired: 0,
  };
  for (const row of paymentByStatusRows) {
    paymentByStatus[String(row.status || "").toLowerCase()] = Number(row.total || 0);
  }

  return {
    generatedAt: nowIso(),
    invoices: {
      total: invoiceTotal,
      ...invoiceByStatus,
    },
    payments: {
      total: paymentTotal,
      ...paymentByStatus,
    },
    volume: {
      paidUsd,
      pendingUsd,
    },
  };
}

function severityRank(severity) {
  const value = String(severity || "").toLowerCase();
  if (value === "critical") return 3;
  if (value === "high") return 2;
  if (value === "medium") return 1;
  return 0;
}

function createRiskSummary(alerts, displayed) {
  const summary = {
    total: Number(alerts.length || 0),
    displayed: Number(displayed || 0),
    critical: 0,
    high: 0,
    medium: 0,
    byCode: {},
  };

  for (const alert of alerts) {
    const severity = String(alert.severity || "").toLowerCase();
    if (severity === "critical") summary.critical += 1;
    else if (severity === "high") summary.high += 1;
    else summary.medium += 1;

    const code = String(alert.code || "UNKNOWN");
    summary.byCode[code] = Number(summary.byCode[code] || 0) + 1;
  }

  return summary;
}

function getRiskMonitor({ limit = 80 } = {}) {
  const max = Math.max(10, Math.min(300, Number(limit || 80)));
  const now = new Date();
  const nowMs = now.getTime();
  const nowIsoValue = now.toISOString();
  const reviewLimit = Math.max(60, max * 3);
  const alerts = [];

  const pushAlert = (alert) => {
    alerts.push({
      code: String(alert.code || "UNKNOWN"),
      severity: String(alert.severity || "medium").toLowerCase(),
      title: String(alert.title || "Avviso"),
      description: String(alert.description || ""),
      entityType: alert.entityType || "system",
      entityRef: alert.entityRef || null,
      invoiceRef: alert.invoiceRef || null,
      txRef: alert.txRef || null,
      txHash: alert.txHash || null,
      updatedAt: alert.updatedAt || nowIsoValue,
      details: alert.details || {},
    });
  };

  const overduePendingRows = db
    .prepare(
      `
        SELECT id, short_id, amount_usd, expires_at, updated_at
        FROM invoices
        WHERE status = 'pending'
          AND expires_at <= ?
        ORDER BY expires_at ASC
        LIMIT ?
      `,
    )
    .all(nowIsoValue, reviewLimit);

  for (const row of overduePendingRows) {
    const overdueMinutes = Math.max(
      1,
      Math.floor((nowMs - new Date(row.expires_at).getTime()) / 60000),
    );
    pushAlert({
      code: "INVOICE_PENDING_OVERDUE",
      severity: overdueMinutes >= 30 ? "critical" : "high",
      title: `Fattura in attesa oltre scadenza (${overdueMinutes}m)`,
      description:
        "La fattura e ancora in attesa nonostante la scadenza: verifica job di scadenza e stato pagamenti.",
      entityType: "invoice",
      entityRef: row.short_id || row.id,
      invoiceRef: row.short_id || row.id,
      updatedAt: row.updated_at || row.expires_at,
      details: {
        amountUsd: Number(row.amount_usd),
        expiresAt: row.expires_at,
        overdueMinutes,
      },
    });
  }

  const orphanPendingRows = db
    .prepare(
      `
        SELECT i.id, i.short_id, i.amount_usd, i.updated_at
        FROM invoices i
        WHERE i.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM payments p
            WHERE p.invoice_id = i.id
              AND p.status IN (${OPEN_PAYMENT_STATUSES.map(() => "?").join(", ")})
          )
        ORDER BY i.updated_at DESC
        LIMIT ?
      `,
    )
    .all(...OPEN_PAYMENT_STATUSES, reviewLimit);

  for (const row of orphanPendingRows) {
    pushAlert({
      code: "INVOICE_PENDING_WITHOUT_OPEN_PAYMENT",
      severity: "critical",
      title: "Fattura in attesa senza pagamenti aperti",
      description:
        "Incoerenza di stato: fattura in attesa ma nessun pagamento in attesa pagamento/in attesa conferme.",
      entityType: "invoice",
      entityRef: row.short_id || row.id,
      invoiceRef: row.short_id || row.id,
      updatedAt: row.updated_at,
      details: {
        amountUsd: Number(row.amount_usd),
      },
    });
  }

  const paidWithoutConfirmedRows = db
    .prepare(
      `
        SELECT i.id, i.short_id, i.amount_usd, i.updated_at
        FROM invoices i
        WHERE i.status = 'paid'
          AND NOT EXISTS (
            SELECT 1
            FROM payments p
            WHERE p.invoice_id = i.id
              AND p.status = 'confirmed'
          )
        ORDER BY i.updated_at DESC
        LIMIT ?
      `,
    )
    .all(reviewLimit);

  for (const row of paidWithoutConfirmedRows) {
    pushAlert({
      code: "INVOICE_PAID_WITHOUT_CONFIRMED_PAYMENT",
      severity: "critical",
      title: "Fattura pagata senza pagamento confermato",
      description:
        "Stato fattura non coerente con i pagamenti associati. Verifica eventi manuali/webhook.",
      entityType: "invoice",
      entityRef: row.short_id || row.id,
      invoiceRef: row.short_id || row.id,
      updatedAt: row.updated_at,
      details: {
        amountUsd: Number(row.amount_usd),
      },
    });
  }

  const duplicateHashRows = db
    .prepare(
      `
        SELECT LOWER(tx_hash) AS tx_hash_norm, COUNT(*) AS total
        FROM payments
        WHERE tx_hash IS NOT NULL
          AND TRIM(tx_hash) <> ''
        GROUP BY LOWER(tx_hash)
        HAVING COUNT(*) > 1
        ORDER BY total DESC
        LIMIT ?
      `,
    )
    .all(reviewLimit);

  for (const row of duplicateHashRows) {
    const sample = db
      .prepare(
        `
          SELECT
            p.id,
            p.short_id,
            p.updated_at,
            i.short_id AS invoice_short_id
          FROM payments p
          INNER JOIN invoices i ON i.id = p.invoice_id
          WHERE LOWER(p.tx_hash) = ?
          ORDER BY p.updated_at DESC
          LIMIT 3
        `,
      )
      .all(row.tx_hash_norm);

    const firstSample = sample[0] || null;
    pushAlert({
      code: "TX_HASH_DUPLICATE_CASE_INSENSITIVE",
      severity: "critical",
      title: "Tx hash duplicato (case-insensitive)",
      description:
        "Lo stesso hash risulta legato a piu pagamenti. Richiede audit immediato.",
      entityType: "payment",
      entityRef: firstSample?.short_id || firstSample?.id || row.tx_hash_norm,
      invoiceRef: firstSample?.invoice_short_id || null,
      txRef: firstSample?.short_id || firstSample?.id || null,
      txHash: row.tx_hash_norm,
      updatedAt: firstSample?.updated_at || nowIsoValue,
      details: {
        hash: row.tx_hash_norm,
        occurrences: Number(row.total || 0),
        sampleTxRefs: sample.map((item) => item.short_id || item.id),
      },
    });
  }

  const confirmedWithoutHashRows = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.currency,
          p.network,
          p.updated_at,
          p.invoice_id,
          i.short_id AS invoice_short_id
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'confirmed'
          AND (p.tx_hash IS NULL OR TRIM(p.tx_hash) = '')
        ORDER BY p.updated_at DESC
        LIMIT ?
      `,
    )
    .all(reviewLimit);

  for (const row of confirmedWithoutHashRows) {
    pushAlert({
      code: "CONFIRMED_PAYMENT_WITHOUT_TX_HASH",
      severity: "high",
      title: "Pagamento confermato senza hash tx",
      description:
        "Pagamento marcato confermato ma hash assente: tracciabilita incompleta.",
      entityType: "payment",
      entityRef: row.short_id || row.id,
      invoiceRef: row.invoice_short_id || row.invoice_id,
      txRef: row.short_id || row.id,
      updatedAt: row.updated_at,
      details: {
        currency: row.currency,
        network: row.network,
      },
    });
  }

  const confirmedWithoutPaidAmountRows = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.currency,
          p.network,
          p.expected_amount_crypto,
          p.paid_amount_crypto,
          p.updated_at,
          p.invoice_id,
          i.short_id AS invoice_short_id
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'confirmed'
          AND (p.paid_amount_crypto IS NULL OR p.paid_amount_crypto <= 0)
        ORDER BY p.updated_at DESC
        LIMIT ?
      `,
    )
    .all(reviewLimit);

  for (const row of confirmedWithoutPaidAmountRows) {
    pushAlert({
      code: "CONFIRMED_PAYMENT_WITHOUT_PAID_AMOUNT",
      severity: "high",
      title: "Pagamento confermato senza importo pagato",
      description:
        "Pagamento confermato con importo pagato nullo/zero. Verifica dati webhook o conferma manuale.",
      entityType: "payment",
      entityRef: row.short_id || row.id,
      invoiceRef: row.invoice_short_id || row.invoice_id,
      txRef: row.short_id || row.id,
      updatedAt: row.updated_at,
      details: {
        currency: row.currency,
        network: row.network,
        expectedAmountCrypto: Number(row.expected_amount_crypto),
        paidAmountCrypto:
          row.paid_amount_crypto !== null && row.paid_amount_crypto !== undefined
            ? Number(row.paid_amount_crypto)
            : null,
      },
    });
  }

  const confirmedRows = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.currency,
          p.network,
          p.expected_amount_crypto,
          p.paid_amount_crypto,
          p.tx_hash,
          p.updated_at,
          p.invoice_id,
          i.short_id AS invoice_short_id
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'confirmed'
        ORDER BY p.updated_at DESC
        LIMIT ?
      `,
    )
    .all(reviewLimit);

  for (const row of confirmedRows) {
    const txHash = String(row.tx_hash || "").trim();
    if (txHash) {
      try {
        assertTxHashValidForPayment({
          currency: row.currency,
          network: row.network,
          txHash,
        });
      } catch (_error) {
        pushAlert({
          code: "CONFIRMED_PAYMENT_INVALID_TX_HASH_FORMAT",
          severity: "high",
          title: "Formato tx hash non valido",
          description:
            "Hash registrato ma non compatibile con currency/network configurati.",
          entityType: "payment",
          entityRef: row.short_id || row.id,
          invoiceRef: row.invoice_short_id || row.invoice_id,
          txRef: row.short_id || row.id,
          txHash,
          updatedAt: row.updated_at,
          details: {
            currency: row.currency,
            network: row.network,
          },
        });
      }
    }

    if (row.paid_amount_crypto === null || row.paid_amount_crypto === undefined) {
      continue;
    }

    const expected = Number(row.expected_amount_crypto);
    const paid = Number(row.paid_amount_crypto);
    if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(paid)) {
      continue;
    }

    const decimals = currencyDecimals(row.currency);
    const expectedRounded = roundTo(expected, decimals);
    const paidRounded = roundTo(paid, decimals);

    let mismatch = false;
    if (config.strictAmountMatch) {
      mismatch = expectedRounded !== paidRounded;
    } else {
      const underTolerance = Math.max(0, Number(config.paymentAmountTolerancePct || 0));
      const maxOverTolerance = Math.max(0, Number(config.paymentAmountMaxOverPct || 0));
      const minAccepted = expected * (1 - underTolerance / 100);
      const maxAccepted = expected * (1 + maxOverTolerance / 100);
      const epsilon = 1e-12;
      mismatch = paid + epsilon < minAccepted || paid - epsilon > maxAccepted;
    }

    if (!mismatch) {
      continue;
    }

    const deltaPct = expected > 0 ? Math.abs(((paid - expected) / expected) * 100) : 0;
    pushAlert({
      code: "CONFIRMED_PAYMENT_AMOUNT_MISMATCH",
      severity: deltaPct >= 5 ? "high" : "medium",
      title: "Scostamento importo tra atteso e pagato",
      description:
        "Il pagamento confermato non coincide con l'importo atteso nei limiti configurati.",
      entityType: "payment",
      entityRef: row.short_id || row.id,
      invoiceRef: row.invoice_short_id || row.invoice_id,
      txRef: row.short_id || row.id,
      txHash: txHash || null,
      updatedAt: row.updated_at,
      details: {
        currency: row.currency,
        expectedAmountCrypto: expectedRounded,
        paidAmountCrypto: paidRounded,
        deltaPct: Number(deltaPct.toFixed(4)),
      },
    });
  }

  const awaitingStaleMinutes = Math.max(
    20,
    Math.floor(Number(config.invoiceTtlMinutes || 30) * 0.75),
  );
  const awaitingCutoffIso = new Date(nowMs - awaitingStaleMinutes * 60 * 1000).toISOString();
  const staleAwaitingRows = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.currency,
          p.updated_at,
          p.created_at,
          p.invoice_id,
          i.short_id AS invoice_short_id
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'awaiting_payment'
          AND i.status = 'pending'
          AND p.updated_at <= ?
        ORDER BY p.updated_at ASC
        LIMIT ?
      `,
    )
    .all(awaitingCutoffIso, reviewLimit);

  for (const row of staleAwaitingRows) {
    const staleMinutes = Math.max(
      1,
      Math.floor((nowMs - new Date(row.updated_at || row.created_at).getTime()) / 60000),
    );
    pushAlert({
      code: "PAYMENT_AWAITING_STALE",
      severity: staleMinutes >= 60 ? "high" : "medium",
      title: `Pagamento in attesa troppo vecchio (${staleMinutes}m)`,
      description:
        "Pagamento fermo in stato attesa pagamento da troppo tempo: utile verificare provider e polling.",
      entityType: "payment",
      entityRef: row.short_id || row.id,
      invoiceRef: row.invoice_short_id || row.invoice_id,
      txRef: row.short_id || row.id,
      updatedAt: row.updated_at || row.created_at,
      details: {
        currency: row.currency,
        staleMinutes,
      },
    });
  }

  const pendingConfStaleMinutes = Math.max(
    15,
    Number(config.providers?.btc?.minConfirmations || 0) * 8,
  );
  const pendingConfCutoffIso = new Date(
    nowMs - pendingConfStaleMinutes * 60 * 1000,
  ).toISOString();
  const stalePendingConfRows = db
    .prepare(
      `
        SELECT
          p.id,
          p.short_id,
          p.currency,
          p.network,
          p.tx_hash,
          p.updated_at,
          p.confirmations,
          p.invoice_id,
          i.short_id AS invoice_short_id
        FROM payments p
        INNER JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'pending_confirmation'
          AND p.updated_at <= ?
        ORDER BY p.updated_at ASC
        LIMIT ?
      `,
    )
    .all(pendingConfCutoffIso, reviewLimit);

  for (const row of stalePendingConfRows) {
    const staleMinutes = Math.max(
      1,
      Math.floor((nowMs - new Date(row.updated_at).getTime()) / 60000),
    );
    pushAlert({
      code: "PAYMENT_PENDING_CONFIRMATION_STALE",
      severity: staleMinutes >= 45 ? "high" : "medium",
      title: `Attesa conferme troppo lunga (${staleMinutes}m)`,
      description:
        "Conferme bloccate oltre soglia: verifica nodo/provider e stato transazione.",
      entityType: "payment",
      entityRef: row.short_id || row.id,
      invoiceRef: row.invoice_short_id || row.invoice_id,
      txRef: row.short_id || row.id,
      txHash: row.tx_hash || null,
      updatedAt: row.updated_at,
      details: {
        currency: row.currency,
        network: row.network,
        confirmations: Number(row.confirmations || 0),
        staleMinutes,
      },
    });
  }

  const sortedAlerts = alerts
    .sort((a, b) => {
      const severityDiff = severityRank(b.severity) - severityRank(a.severity);
      if (severityDiff !== 0) {
        return severityDiff;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, max);

  return {
    generatedAt: nowIsoValue,
    summary: createRiskSummary(alerts, sortedAlerts.length),
    alerts: sortedAlerts,
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
          i.short_id AS invoice_short_id,
          i.created_at AS invoice_created_at,
          i.expires_at AS invoice_expires_at,
          i.telegram_user_id,
          i.created_by_admin_id,
          i.amount_usd,
          p.id AS payment_id,
          p.short_id AS payment_short_id,
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
    invoiceShortId: row.invoice_short_id,
    invoiceCreatedAt: row.invoice_created_at,
    invoiceExpiresAt: row.invoice_expires_at,
    telegramUserId: row.telegram_user_id,
    createdByAdminId: row.created_by_admin_id,
    amountUsd: Number(row.amount_usd),
    paymentId: row.payment_id,
    paymentShortId: row.payment_short_id,
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
        WHERE LOWER(tx_hash) = LOWER(?)
        LIMIT 1
      `,
    )
    .get(String(txHash).trim());
  return Boolean(row);
}

module.exports = {
  ALL_CURRENCIES,
  createInvoice,
  upsertTelegramUser,
  listOpenInvoicesForTelegramUser,
  listPendingInvoices,
  listInvoices,
  getDashboardMetrics,
  getRiskMonitor,
  getInvoiceWithPaymentsById,
  getInvoiceWithPaymentsByToken,
  getInvoiceStatusById,
  getInvoiceStatusByRef,
  getInvoiceAdminDetailsByRef,
  listInvoiceEventsByRef,
  listRecentEvents,
  listRecentTransactions,
  getTransactionByRef,
  resolveInvoiceIdByRef,
  resolvePaymentIdByRef,
  markInvoicePaid,
  deleteAllInvoices,
  deleteInvoiceByRef,
  expireDueInvoices,
  normalizeCurrencies,
  listPendingPaymentsForCurrencies,
  isTxHashAlreadyUsed,
  isInvoiceExpired,
};
