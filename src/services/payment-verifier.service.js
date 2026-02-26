const config = require("../config");
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
  normalizeEthTxHash,
  normalizeTronTxHash,
} = require("./chain-providers.service");

const EARLY_MATCH_GRACE_MS = Math.max(
  0,
  Number(config.paymentEarlyMatchGraceSeconds || 0),
) * 1000;
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
    };
  }

  const walletMap = groupByWallet(pending);
  const usedHashes = new Set();
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
          usedHashes.add(normalizeEthTxHash(match.hash));
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
  };
}

function shouldVerifyTronUsdtPayment(payment) {
  const network = String(payment.network || "").toUpperCase();
  return network.includes("TRC20") || network.includes("TRON");
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
    };
  }

  const walletMap = groupByWallet(pending);
  const usedHashes = new Set();
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
          usedHashes.add(normalizeTronTxHash(candidate.hash));
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
  };
}

async function verifyPendingPayments() {
  if (verifierInProgress) {
    return {
      ranAt: new Date().toISOString(),
      autoVerifyEnabled: Boolean(config.autoVerifyPayments),
      results: [],
      checked: 0,
      paid: 0,
      errors: [],
      skipped: true,
      reason: "verifier already running",
    };
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
    summary.results.push(ethResult, tronResult);

    for (const item of summary.results) {
      summary.checked += item.checked;
      summary.paid += item.paid;
      if (item.errors.length) {
        summary.errors.push(...item.errors);
      }
    }

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
