const config = require("../config");

function createTimeoutSignal() {
  const timeoutMs = Math.max(1000, Number(config.providerRequestTimeoutMs || 10000));
  return AbortSignal.timeout(timeoutMs);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(responseStatus, error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return true;
  }
  if (!Number.isFinite(responseStatus)) {
    return false;
  }
  return responseStatus === 429 || responseStatus >= 500;
}

async function fetchJson(url, options = {}) {
  const maxAttempts = Math.max(1, Number(config.providerMaxRetries || 0) + 1);
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    let responseStatus = null;
    try {
      const response = await fetch(url, {
        ...options,
        signal: createTimeoutSignal(),
      });
      responseStatus = response.status;
      const bodyText = await response.text();

      let payload;
      try {
        payload = bodyText ? JSON.parse(bodyText) : {};
      } catch (_error) {
        throw new Error(`Provider response non JSON (${response.status})`);
      }

      if (!response.ok) {
        const err = new Error(
          `Provider HTTP ${response.status}: ${payload.message || payload.error || "errore"}`,
        );
        err.responseStatus = response.status;
        throw err;
      }
      return payload;
    } catch (error) {
      lastError = error;
      const retry = attempt < maxAttempts && shouldRetry(responseStatus, error);
      if (!retry) {
        break;
      }
      const backoffMs = Math.min(3000, 250 * 2 ** (attempt - 1));
      await sleep(backoffMs);
    }
  }

  throw lastError || new Error("Provider request failed");
}

function normalizeEthTxHash(hash) {
  return String(hash || "").toLowerCase();
}

async function fetchEthIncomingTransactions(walletAddress) {
  const wallet = String(walletAddress || "").trim();
  if (!wallet) {
    return [];
  }

  const url = new URL(config.providers.etherscan.apiUrl);
  url.searchParams.set("chainid", config.providers.etherscan.chainId);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", wallet);
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", "1");
  url.searchParams.set(
    "offset",
    String(Math.max(1, Number(config.providers.etherscan.txScanLimit || 100))),
  );
  url.searchParams.set("sort", "desc");
  if (config.providers.etherscan.apiKey) {
    url.searchParams.set("apikey", config.providers.etherscan.apiKey);
  }

  const payload = await fetchJson(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });

  const rawResult = payload.result;
  if (payload.status === "0") {
    const msg = String(payload.result || payload.message || "").toLowerCase();
    if (msg.includes("no transactions")) {
      return [];
    }
    throw new Error(`Etherscan errore: ${payload.result || payload.message || "unknown"}`);
  }
  if (!Array.isArray(rawResult)) {
    return [];
  }

  const walletLc = wallet.toLowerCase();
  return rawResult
    .filter((tx) => {
      const to = String(tx.to || "").toLowerCase();
      const success =
        String(tx.isError || "0") === "0" &&
        (String(tx.txreceipt_status || "1") === "1" ||
          String(tx.txreceipt_status || "") === "");
      return to === walletLc && success;
    })
    .map((tx) => ({
      hash: normalizeEthTxHash(tx.hash),
      amount: Number(tx.value) / 1e18,
      timestampMs: Number(tx.timeStamp) * 1000,
      confirmations: Number(tx.confirmations || 0),
      blockNumber: Number(tx.blockNumber || 0),
      from: tx.from || null,
      to: tx.to || null,
    }))
    .filter((tx) => Number.isFinite(tx.amount) && tx.amount > 0)
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

function tronHeaders() {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (config.providers.tron.apiKey) {
    headers["TRON-PRO-API-KEY"] = config.providers.tron.apiKey;
  }
  return headers;
}

function normalizeTronTxHash(hash) {
  return String(hash || "").toLowerCase();
}

async function fetchTronCurrentBlockNumber() {
  const url = `${config.providers.tron.apiUrl}/wallet/getnowblock`;
  const payload = await fetchJson(url, {
    method: "POST",
    headers: tronHeaders(),
    body: "{}",
  });
  return Number(payload?.block_header?.raw_data?.number || 0);
}

async function fetchTronTransactionInfo(txHash) {
  const url = `${config.providers.tron.apiUrl}/wallet/gettransactioninfobyid`;
  const payload = await fetchJson(url, {
    method: "POST",
    headers: tronHeaders(),
    body: JSON.stringify({
      value: txHash,
    }),
  });
  return {
    hash: normalizeTronTxHash(payload.id || txHash),
    blockNumber: Number(payload.blockNumber || 0),
    success: String(payload?.receipt?.result || "").toUpperCase() === "SUCCESS",
    blockTimestampMs: Number(payload.blockTimeStamp || 0),
  };
}

async function fetchTronUsdtIncomingTransfers(walletAddress) {
  const wallet = String(walletAddress || "").trim();
  if (!wallet) {
    return [];
  }

  const url = new URL(
    `${config.providers.tron.apiUrl}/v1/accounts/${encodeURIComponent(wallet)}/transactions/trc20`,
  );
  url.searchParams.set(
    "limit",
    String(Math.max(1, Number(config.providers.tron.txScanLimit || 100))),
  );
  url.searchParams.set("only_to", "true");
  url.searchParams.set("only_confirmed", "true");
  url.searchParams.set("contract_address", config.providers.tron.usdtContract);
  url.searchParams.set("order_by", "block_timestamp,desc");

  const payload = await fetchJson(url.toString(), {
    method: "GET",
    headers: tronHeaders(),
  });

  const data = Array.isArray(payload.data) ? payload.data : [];
  return data
    .filter((tx) => String(tx.type || "").toLowerCase() === "transfer")
    .filter((tx) => String(tx.to || "").trim() === wallet)
    .map((tx) => {
      const decimals = Number(tx?.token_info?.decimals || 6);
      const divider = 10 ** decimals;
      return {
        hash: normalizeTronTxHash(tx.transaction_id),
        amount: Number(tx.value) / divider,
        timestampMs: Number(tx.block_timestamp || 0),
        from: tx.from || null,
        to: tx.to || null,
      };
    })
    .filter((tx) => Number.isFinite(tx.amount) && tx.amount > 0)
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

module.exports = {
  fetchEthIncomingTransactions,
  fetchTronCurrentBlockNumber,
  fetchTronTransactionInfo,
  fetchTronUsdtIncomingTransfers,
  normalizeEthTxHash,
  normalizeTronTxHash,
};
