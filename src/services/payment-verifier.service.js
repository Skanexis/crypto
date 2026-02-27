const config = require("../config");
const { logEvent } = require("../db");
const {
  listPendingPaymentsForCurrencies,
  markInvoicePaid,
  isTxHashAlreadyUsed,
} = require("./invoices.service");
const { notifyInvoicePaid } = require("./notifications.service");
const {
  fetchEthIncomingTransactions,
  fetchTronCurrentBlockNumber,
  fetchTronTransactionInfo,
  fetchTronUsdtIncomingTransfers,
  fetchBtcCurrentTipHeight,
  fetchBtcAddressTransactions,
  normalizeEthTxHash,
  normalizeTronTxHash,
  normalizeBtcTxHash,
} = require("./chain-providers.service");

const EARLY_MATCH_GRACE_MS = Math.max(
  0,
  Number(config.paymentEarlyMatchGraceSeconds || 0),
) * 1000;
const MAX_REFS_PER_RESULT = 40;
const MAX_REFS_IN_LOG = 16;
let verifierInProgress = false;
const CURRENCY_DECIMALS = {
  USDT: 6,
  BTC: 8,
  ETH: 8,
};

function toMs(value) {
  return new Date(value).getTime();
}

function isInInvoiceWindow(payment, txTimestampMs) {
  const startMs = toMs(payment.invoiceCreatedAt) - EARLY_MATCH_GRACE_MS;
  const endMs =
    toMs(payment.invoiceExpiresAt) +
    Math.max(0, Number(config.paymentLateGraceMinutes || 0)) * 60 * 1000;
  return txTimestampMs >= startMs && txTimestampMs <= endMs;
}

function roundToDecimals(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function isAmountMatch(payment, actual) {
  const expected = Number(payment.expectedAmountCrypto);
  const decimals = CURRENCY_DECIMALS[payment.currency] || 8;
  const actualRounded = roundToDecimals(actual, decimals);
  const expectedRounded = roundToDecimals(expected, decimals);

  if (config.strictAmountMatch) {
    return actualRounded === expectedRounded;
  }

  const underTolerance = Math.max(0, Number(config.paymentAmountTolerancePct || 0));
  const maxOverPct = Math.max(0, Number(config.paymentAmountMaxOverPct || 0));
  const minAccepted = expected * (1 - underTolerance / 100);
  const maxAccepted = expected * (1 + maxOverPct / 100);
  const value = Number(actual);
  const epsilon = 1e-12;
  return value + epsilon >= minAccepted && value - epsilon <= maxAccepted;
}

function groupByWallet(payments) {
  const map = new Map();
  for (const payment of payments) {
    const wallet = String(payment.walletAddress || "").trim();
    if (!wallet) {
      continue;
    }
    const list = map.get(wallet) || [];
    list.push(payment);
    map.set(wallet, list);
  }
  return map;
}

function sortByInvoiceCreatedAtAsc(list) {
  return [...list].sort(
    (a, b) => toMs(a.invoiceCreatedAt) - toMs(b.invoiceCreatedAt),
  );
}

function addRef(set, value) {
  if (!set || set.size >= MAX_REFS_PER_RESULT) {
    return;
  }
  const normalized = String(value || "").trim();
  if (!normalized) {
    return;
  }
  set.add(normalized);
}

function mergeRefArrays(results, key) {
  const values = [];
  const seen = new Set();
  for (const result of results || []) {
    const items = Array.isArray(result?.[key]) ? result[key] : [];
    for (const item of items) {
      const normalized = String(item || "").trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      values.push(normalized);
    }
  }
  return values;
}

function buildVerifierRefsPayload(results) {
  const matchedInvoiceShortIds = mergeRefArrays(results, "invoiceRefs");
  const matchedPaymentShortIds = mergeRefArrays(results, "paymentRefs");
  const checkedInvoiceShortIds = mergeRefArrays(results, "checkedInvoiceRefs");
  const checkedPaymentShortIds = mergeRefArrays(results, "checkedPaymentRefs");
  const txHashes = mergeRefArrays(results, "txHashes");
  const invoiceShortIds = matchedInvoiceShortIds.length
    ? matchedInvoiceShortIds
    : checkedInvoiceShortIds;
  const paymentShortIds = matchedPaymentShortIds.length
    ? matchedPaymentShortIds
    : checkedPaymentShortIds;

  return {
    invoiceShortId: invoiceShortIds[0] || null,
    paymentShortId: paymentShortIds[0] || null,
    txHash: txHashes[0] || null,
    invoiceShortIds: invoiceShortIds.slice(0, MAX_REFS_IN_LOG),
    paymentShortIds: paymentShortIds.slice(0, MAX_REFS_IN_LOG),
    txHashes: txHashes.slice(0, MAX_REFS_IN_LOG),
    matchedInvoiceShortIds: matchedInvoiceShortIds.slice(0, MAX_REFS_IN_LOG),
    matchedPaymentShortIds: matchedPaymentShortIds.slice(0, MAX_REFS_IN_LOG),
    checkedInvoiceShortIds: checkedInvoiceShortIds.slice(0, MAX_REFS_IN_LOG),
    checkedPaymentShortIds: checkedPaymentShortIds.slice(0, MAX_REFS_IN_LOG),
  };
}

async function confirmInvoice(payment, txData, source) {
  const result = markInvoicePaid({
    invoiceId: payment.invoiceId,
    currency: payment.currency,
    txHash: txData.hash,
    confirmations: txData.confirmations || 1,
    paidAmountCrypto: txData.amount,
  });

  if (!result.changed) {
    return result;
  }

  await notifyInvoicePaid(result.invoice, payment.currency, {
    txHash: txData.hash,
    source,
  });
  return result;
}

async function verifyEthPayments() {
  if (!config.providers.etherscan.apiKey) {
    return {
      currency: "ETH",
      checked: 0,
      paid: 0,
      errors: [],
      invoiceRefs: [],
      paymentRefs: [],
      txHashes: [],
      checkedInvoiceRefs: [],
      checkedPaymentRefs: [],
      disabled: true,
      reason: "ETHERSCAN_API_KEY non configurata",
    };
  }

  const pending = listPendingPaymentsForCurrencies(["ETH"]);
  if (!pending.length) {
    return {
      currency: "ETH",
      checked: 0,
      paid: 0,
      errors: [],
      invoiceRefs: [],
      paymentRefs: [],
      txHashes: [],
      checkedInvoiceRefs: [],
      checkedPaymentRefs: [],
    };
  }

  const walletMap = groupByWallet(pending);
  const usedHashes = new Set();
  const invoiceRefs = new Set();
  const paymentRefs = new Set();
  const txHashes = new Set();
  const checkedInvoiceRefs = new Set();
  const checkedPaymentRefs = new Set();
  const errors = [];
  let checked = 0;
  let paid = 0;

  for (const [wallet, walletPayments] of walletMap.entries()) {
    let transactions = [];
    try {
      transactions = await fetchEthIncomingTransactions(wallet);
    } catch (error) {
      errors.push(`ETH wallet ${wallet}: ${error.message}`);
      continue;
    }

    const sortedPayments = sortByInvoiceCreatedAtAsc(walletPayments);
    for (const payment of sortedPayments) {
      checked += 1;
      addRef(checkedInvoiceRefs, payment.invoiceShortId || payment.invoiceId);
      addRef(checkedPaymentRefs, payment.paymentShortId || payment.paymentId);
      const match = transactions.find((tx) => {
        const hash = normalizeEthTxHash(tx.hash);
        if (!hash || usedHashes.has(hash) || isTxHashAlreadyUsed(hash)) {
          return false;
        }
        if (!isInInvoiceWindow(payment, tx.timestampMs)) {
          return false;
        }
        if (
          Number(tx.confirmations || 0) <
          Number(config.providers.etherscan.minConfirmations || 0)
        ) {
          return false;
        }
        return isAmountMatch(payment, tx.amount);
      });

      if (!match) {
        continue;
      }

      try {
        const confirmResult = await confirmInvoice(
          payment,
          {
            hash: normalizeEthTxHash(match.hash),
            amount: match.amount,
            confirmations: match.confirmations,
          },
          "etherscan",
        );
        if (confirmResult.changed) {
          const normalizedHash = normalizeEthTxHash(match.hash);
          usedHashes.add(normalizedHash);
          addRef(invoiceRefs, payment.invoiceShortId || payment.invoiceId);
          addRef(paymentRefs, payment.paymentShortId || payment.paymentId);
          addRef(txHashes, normalizedHash);
          paid += 1;
        }
      } catch (error) {
        errors.push(
          `ETH invoice ${payment.invoiceId} / tx ${match.hash}: ${error.message}`,
        );
      }
    }
  }

  return {
    currency: "ETH",
    checked,
    paid,
    errors,
    invoiceRefs: [...invoiceRefs],
    paymentRefs: [...paymentRefs],
    txHashes: [...txHashes],
    checkedInvoiceRefs: [...checkedInvoiceRefs],
    checkedPaymentRefs: [...checkedPaymentRefs],
  };
}

function shouldVerifyTronUsdtPayment(payment) {
  const network = String(payment.network || "").toUpperCase();
  return network.includes("TRC20") || network.includes("TRON");
}

function shouldVerifyBtcPayment(payment) {
  const network = String(payment.network || "").toUpperCase();
  return network.includes("BTC") || network.includes("BITCOIN");
}

async function verifyTronUsdtPayments() {
  const pending = listPendingPaymentsForCurrencies(["USDT"]).filter(
    shouldVerifyTronUsdtPayment,
  );
  if (!pending.length) {
    return {
      currency: "USDT_TRC20",
      checked: 0,
      paid: 0,
      errors: [],
      invoiceRefs: [],
      paymentRefs: [],
      txHashes: [],
      checkedInvoiceRefs: [],
      checkedPaymentRefs: [],
    };
  }

  let currentBlock = 0;
  try {
    currentBlock = await fetchTronCurrentBlockNumber();
  } catch (error) {
    return {
      currency: "USDT_TRC20",
      checked: 0,
      paid: 0,
      errors: [`TRON current block error: ${error.message}`],
      invoiceRefs: [],
      paymentRefs: [],
      txHashes: [],
      checkedInvoiceRefs: [],
      checkedPaymentRefs: [],
    };
  }

  const walletMap = groupByWallet(pending);
  const usedHashes = new Set();
  const invoiceRefs = new Set();
  const paymentRefs = new Set();
  const txHashes = new Set();
  const checkedInvoiceRefs = new Set();
  const checkedPaymentRefs = new Set();
  const errors = [];
  let checked = 0;
  let paid = 0;

  for (const [wallet, walletPayments] of walletMap.entries()) {
    let transfers = [];
    try {
      transfers = await fetchTronUsdtIncomingTransfers(wallet);
    } catch (error) {
      errors.push(`TRON wallet ${wallet}: ${error.message}`);
      continue;
    }

    const sortedPayments = sortByInvoiceCreatedAtAsc(walletPayments);
    for (const payment of sortedPayments) {
      checked += 1;
      addRef(checkedInvoiceRefs, payment.invoiceShortId || payment.invoiceId);
      addRef(checkedPaymentRefs, payment.paymentShortId || payment.paymentId);
      const candidate = transfers.find((tx) => {
        const hash = normalizeTronTxHash(tx.hash);
        if (!hash || usedHashes.has(hash) || isTxHashAlreadyUsed(hash)) {
          return false;
        }
        if (!isInInvoiceWindow(payment, tx.timestampMs)) {
          return false;
        }
        return isAmountMatch(payment, tx.amount);
      });

      if (!candidate) {
        continue;
      }

      try {
        const txInfo = await fetchTronTransactionInfo(candidate.hash);
        if (!txInfo.success) {
          continue;
        }

        const confirmations =
          currentBlock > 0 && txInfo.blockNumber > 0
            ? Math.max(currentBlock - txInfo.blockNumber + 1, 0)
            : 0;
        if (confirmations < Number(config.providers.tron.minConfirmations || 0)) {
          continue;
        }

        const confirmResult = await confirmInvoice(
          payment,
          {
            hash: normalizeTronTxHash(candidate.hash),
            amount: candidate.amount,
            confirmations,
          },
          "trongrid-usdt-trc20",
        );
        if (confirmResult.changed) {
          const normalizedHash = normalizeTronTxHash(candidate.hash);
          usedHashes.add(normalizedHash);
          addRef(invoiceRefs, payment.invoiceShortId || payment.invoiceId);
          addRef(paymentRefs, payment.paymentShortId || payment.paymentId);
          addRef(txHashes, normalizedHash);
          paid += 1;
        }
      } catch (error) {
        errors.push(
          `TRON invoice ${payment.invoiceId} / tx ${candidate.hash}: ${error.message}`,
        );
      }
    }
  }

  return {
    currency: "USDT_TRC20",
    checked,
    paid,
    errors,
    invoiceRefs: [...invoiceRefs],
    paymentRefs: [...paymentRefs],
    txHashes: [...txHashes],
    checkedInvoiceRefs: [...checkedInvoiceRefs],
    checkedPaymentRefs: [...checkedPaymentRefs],
  };
}

async function verifyBtcPayments() {
  const pending = listPendingPaymentsForCurrencies(["BTC"]).filter(
    shouldVerifyBtcPayment,
  );
  if (!pending.length) {
    return {
      currency: "BTC",
      checked: 0,
      paid: 0,
      errors: [],
      invoiceRefs: [],
      paymentRefs: [],
      txHashes: [],
      checkedInvoiceRefs: [],
      checkedPaymentRefs: [],
    };
  }

  let tipHeight = 0;
  try {
    tipHeight = await fetchBtcCurrentTipHeight();
  } catch (error) {
    return {
      currency: "BTC",
      checked: 0,
      paid: 0,
      errors: [`BTC tip height error: ${error.message}`],
      invoiceRefs: [],
      paymentRefs: [],
      txHashes: [],
      checkedInvoiceRefs: [],
      checkedPaymentRefs: [],
    };
  }

  const walletMap = groupByWallet(pending);
  const usedHashes = new Set();
  const invoiceRefs = new Set();
  const paymentRefs = new Set();
  const txHashes = new Set();
  const checkedInvoiceRefs = new Set();
  const checkedPaymentRefs = new Set();
  const errors = [];
  let checked = 0;
  let paid = 0;

  for (const [wallet, walletPayments] of walletMap.entries()) {
    let transactions = [];
    try {
      transactions = await fetchBtcAddressTransactions(wallet, tipHeight);
    } catch (error) {
      errors.push(`BTC wallet ${wallet}: ${error.message}`);
      continue;
    }

    const sortedPayments = sortByInvoiceCreatedAtAsc(walletPayments);
    for (const payment of sortedPayments) {
      checked += 1;
      addRef(checkedInvoiceRefs, payment.invoiceShortId || payment.invoiceId);
      addRef(checkedPaymentRefs, payment.paymentShortId || payment.paymentId);
      const candidate = transactions.find((tx) => {
        const hash = normalizeBtcTxHash(tx.hash);
        if (!hash || usedHashes.has(hash) || isTxHashAlreadyUsed(hash)) {
          return false;
        }
        if (!isInInvoiceWindow(payment, tx.timestampMs)) {
          return false;
        }
        if (
          Number(tx.confirmations || 0) <
          Number(config.providers.btc.minConfirmations || 0)
        ) {
          return false;
        }
        return isAmountMatch(payment, tx.amount);
      });

      if (!candidate) {
        continue;
      }

      try {
        const confirmResult = await confirmInvoice(
          payment,
          {
            hash: normalizeBtcTxHash(candidate.hash),
            amount: candidate.amount,
            confirmations: candidate.confirmations,
          },
          "blockstream-btc",
        );
        if (confirmResult.changed) {
          const normalizedHash = normalizeBtcTxHash(candidate.hash);
          usedHashes.add(normalizedHash);
          addRef(invoiceRefs, payment.invoiceShortId || payment.invoiceId);
          addRef(paymentRefs, payment.paymentShortId || payment.paymentId);
          addRef(txHashes, normalizedHash);
          paid += 1;
        }
      } catch (error) {
        errors.push(
          `BTC invoice ${payment.invoiceId} / tx ${candidate.hash}: ${error.message}`,
        );
      }
    }
  }

  return {
    currency: "BTC",
    checked,
    paid,
    errors,
    invoiceRefs: [...invoiceRefs],
    paymentRefs: [...paymentRefs],
    txHashes: [...txHashes],
    checkedInvoiceRefs: [...checkedInvoiceRefs],
    checkedPaymentRefs: [...checkedPaymentRefs],
  };
}

async function verifyPendingPayments() {
  if (verifierInProgress) {
    const skippedSummary = {
      ranAt: new Date().toISOString(),
      autoVerifyEnabled: Boolean(config.autoVerifyPayments),
      results: [],
      checked: 0,
      paid: 0,
      errors: [],
      skipped: true,
      reason: "verifier already running",
    };
    logEvent("system", "payment_verifier", "run_skipped", skippedSummary);
    return skippedSummary;
  }

  verifierInProgress = true;
  try {
    const summary = {
      ranAt: new Date().toISOString(),
      autoVerifyEnabled: Boolean(config.autoVerifyPayments),
      results: [],
      checked: 0,
      paid: 0,
      errors: [],
      skipped: false,
    };

    const ethResult = await verifyEthPayments();
    const tronResult = await verifyTronUsdtPayments();
    const btcResult = await verifyBtcPayments();
    summary.results.push(ethResult, tronResult, btcResult);

    for (const item of summary.results) {
      summary.checked += item.checked;
      summary.paid += item.paid;
      if (item.errors.length) {
        summary.errors.push(...item.errors);
      }
    }
    const refsPayload = buildVerifierRefsPayload(summary.results);
    Object.assign(summary, refsPayload);

    logEvent("system", "payment_verifier", "run", {
      ranAt: summary.ranAt,
      checked: summary.checked,
      paid: summary.paid,
      errors: summary.errors.slice(0, 25),
      skipped: false,
      autoVerifyEnabled: summary.autoVerifyEnabled,
      invoiceShortId: summary.invoiceShortId,
      paymentShortId: summary.paymentShortId,
      txHash: summary.txHash,
      invoiceShortIds: summary.invoiceShortIds,
      paymentShortIds: summary.paymentShortIds,
      txHashes: summary.txHashes,
      matchedInvoiceShortIds: summary.matchedInvoiceShortIds,
      matchedPaymentShortIds: summary.matchedPaymentShortIds,
      checkedInvoiceShortIds: summary.checkedInvoiceShortIds,
      checkedPaymentShortIds: summary.checkedPaymentShortIds,
    });

    return summary;
  } finally {
    verifierInProgress = false;
  }
}

async function runPaymentVerifierJob() {
  if (!config.autoVerifyPayments) {
    return null;
  }
  return verifyPendingPayments();
}

module.exports = {
  verifyPendingPayments,
  runPaymentVerifierJob,
};
