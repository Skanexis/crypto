function normalizeNet(currency, network) {
  return {
    currency: String(currency || "").toUpperCase(),
    network: String(network || "").toUpperCase(),
  };
}

function txExplorerUrl({ currency, network, txHash }) {
  const tx = String(txHash || "").trim();
  if (!tx) {
    return null;
  }

  const meta = normalizeNet(currency, network);
  if (meta.currency === "BTC" || meta.network.includes("BTC") || meta.network.includes("BITCOIN")) {
    return `https://mempool.space/tx/${encodeURIComponent(tx)}`;
  }
  if (meta.currency === "ETH" || meta.network.includes("ERC20") || meta.network.includes("ETH")) {
    return `https://etherscan.io/tx/${encodeURIComponent(tx)}`;
  }
  if (meta.currency === "USDT" && (meta.network.includes("TRC20") || meta.network.includes("TRON"))) {
    return `https://tronscan.org/#/transaction/${encodeURIComponent(tx)}`;
  }

  return null;
}

function addressExplorerUrl({ currency, network, address }) {
  const wallet = String(address || "").trim();
  if (!wallet) {
    return null;
  }

  const meta = normalizeNet(currency, network);
  if (meta.currency === "BTC" || meta.network.includes("BTC") || meta.network.includes("BITCOIN")) {
    return `https://mempool.space/address/${encodeURIComponent(wallet)}`;
  }
  if (meta.currency === "ETH" || meta.network.includes("ERC20") || meta.network.includes("ETH")) {
    return `https://etherscan.io/address/${encodeURIComponent(wallet)}`;
  }
  if (meta.currency === "USDT" && (meta.network.includes("TRC20") || meta.network.includes("TRON"))) {
    return `https://tronscan.org/#/address/${encodeURIComponent(wallet)}`;
  }

  return null;
}

module.exports = {
  txExplorerUrl,
  addressExplorerUrl,
};
