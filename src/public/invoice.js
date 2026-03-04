const token = window.location.pathname.split("/").filter(Boolean).pop();

const els = {
  invoiceRef: document.getElementById("invoiceRef"),
  usdAmount: document.getElementById("usdAmount"),
  expiresAt: document.getElementById("expiresAt"),
  countdown: document.getElementById("countdown"),
  invoiceBadge: document.getElementById("invoiceBadge"),
  statusHintBadge: document.getElementById("statusHintBadge"),
  statusHint: document.getElementById("statusHint"),
  walletCards: document.getElementById("walletCards"),
  invoiceId: document.getElementById("invoiceId"),
  invoiceToken: document.getElementById("invoiceToken"),
  updatedAt: document.getElementById("updatedAt"),
  currenciesText: document.getElementById("currenciesText"),
  finalMessage: document.getElementById("finalMessage"),
  toast: document.getElementById("toast"),
};

const state = {
  invoice: null,
  countdownTimer: null,
  pollTimer: null,
  toastTimer: null,
  unavailable: false,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

function formatDate(value) {
  return new Date(value).toLocaleString("it-IT");
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const hh = Math.floor(total / 3600)
    .toString()
    .padStart(2, "0");
  const mm = Math.floor((total % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(total % 60)
    .toString()
    .padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 1700);
}

function setStatusUI(status) {
  const normalized = String(status || "pending").toLowerCase();
  els.invoiceBadge.className = `status-badge ${normalized}`;
  els.statusHintBadge.className = `status-badge ${normalized}`;
  els.invoiceBadge.textContent = localizeStatus(normalized);
  els.statusHintBadge.textContent = localizeStatus(normalized);

  if (normalized === "paid") {
    els.statusHint.className = "notice ok";
    els.statusHint.textContent = "Pagamento confermato. Operazione completata.";
    return;
  }
  if (normalized === "expired") {
    els.statusHint.className = "notice warn";
    els.statusHint.textContent = "Fattura scaduta. Richiedi una nuova fattura all'amministratore.";
    return;
  }
  if (normalized === "cancelled") {
    els.statusHint.className = "notice warn";
    els.statusHint.textContent = "Questa fattura e stata annullata.";
    return;
  }

  els.statusHint.className = "notice";
  els.statusHint.textContent = "Invia il pagamento e attendi la conferma di rete.";
}

async function copyText(value, successMessage) {
  const text = String(value || "").trim();
  if (!text || text === "-") return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage || "Copiato");
  } catch (_error) {
    showToast("Copia non riuscita");
  }
}

function openWalletUri(payment) {
  const uri = String(payment.qrText || "");
  if (
    uri.startsWith("bitcoin:") ||
    uri.startsWith("ethereum:") ||
    uri.startsWith("tron:") ||
    uri.startsWith("http://") ||
    uri.startsWith("https://")
  ) {
    window.location.href = uri;
    return;
  }
  copyText(payment.walletAddress, "Indirizzo copiato");
}
function renderWalletCards(payments, invoiceStatus) {
  if (!payments || !payments.length) {
    els.walletCards.innerHTML = '<div class="notice">Nessun metodo di pagamento disponibile.</div>';
    return;
  }

  els.walletCards.innerHTML = payments
    .map((payment) => {
      const amountValue = String(payment.expectedAmountCrypto ?? "");
      const statusKey = String(payment.status || "").toLowerCase();
      const safeStatusKey = /^[a-z_]+$/.test(statusKey) ? statusKey : "awaiting_payment";
      const safeCurrency = escapeHtml(payment.currency || "");
      const safeNetwork = escapeHtml(payment.network || "");
      const safeAmountValue = escapeHtml(amountValue);
      const safeWalletAddress = escapeHtml(payment.walletAddress || "");
      const safeTxHash = escapeHtml(payment.txHash || "");
      const safePaymentId = escapeHtml(payment.id || "");
      const safeQrDataUrl = escapeHtml(payment.qrDataUrl || "");
      const safeExplorerTxUrl = escapeHtml(payment.explorerTxUrl || "");
      const txInfo = payment.txHash
        ? `<div class="copy-field"><small>Hash tx</small><strong class="mono">${safeTxHash}</strong></div>`
        : "";
      const explorerBtn = payment.explorerTxUrl && payment.txHash
        ? `<button class="btn btn-ghost" data-open-url="${safeExplorerTxUrl}">Apri explorer tx</button>`
        : "";
      return `
        <article class="wallet-card">
          <div class="wallet-head">
            <div class="wallet-title">
              <h4>${safeCurrency}</h4>
              <span>${safeNetwork}</span>
            </div>
            <span class="status-badge ${safeStatusKey}">${escapeHtml(localizeStatus(payment.status))}</span>
          </div>

          <div class="qr-row">
            <div class="qr-box">
              <img src="${safeQrDataUrl}" alt="QR ${safeCurrency}" />
            </div>
            <div class="stack">
              <div class="copy-field">
                <small>Importo esatto</small>
                <strong class="mono">${safeAmountValue} ${safeCurrency}</strong>
              </div>
              <div class="copy-field">
                <small>Indirizzo wallet</small>
                <strong class="mono">${safeWalletAddress}</strong>
              </div>
              ${txInfo}
            </div>
          </div>

          <div class="client-actions">
            <button class="btn btn-primary" data-copy-amount="${safeAmountValue}">Copia importo</button>
            <button class="btn btn-secondary" data-copy-address="${safeWalletAddress}">Copia indirizzo</button>
            <button class="btn btn-ghost" data-open-wallet="${safePaymentId}">Apri wallet</button>
            ${explorerBtn}
          </div>
        </article>
      `;
    })
    .join("");

  const hasTrackedPayment = (payments || []).some((payment) =>
    ["pending_confirmation", "confirmed"].includes(String(payment.status || "").toLowerCase()),
  );
  const disabled = String(invoiceStatus || "").toLowerCase() !== "pending" || hasTrackedPayment;
  if (disabled) {
    [...els.walletCards.querySelectorAll("button")].forEach((button) => {
      button.disabled = true;
    });
  }
}

function applyPaymentProgressHint(invoice) {
  const trackedPayment = (invoice.payments || []).find(
    (payment) => String(payment.status || "").toLowerCase() === "pending_confirmation",
  );
  if (!trackedPayment) {
    return false;
  }

  const confirmations = Number(trackedPayment.confirmations || 0);
  els.statusHintBadge.className = "status-badge pending_confirmation";
  els.statusHintBadge.textContent = localizeStatus("pending_confirmation");
  els.statusHint.className = "notice ok";
  els.statusHint.textContent =
    `Pagamento ${trackedPayment.currency} rilevato sulla rete. Attendere le conferme blockchain (${confirmations}).`;

  const txLine = trackedPayment.txHash ? `\nHash tx: ${trackedPayment.txHash}` : "";
  els.finalMessage.className = "notice";
  els.finalMessage.textContent =
    `Transazione registrata. Non inviare un secondo pagamento.${txLine}`;
  els.finalMessage.classList.remove("hidden");
  return true;
}

function applyInvoice(invoice) {
  state.invoice = invoice;

  els.invoiceRef.textContent = invoice.shortId || invoice.id;
  els.usdAmount.textContent = `${Number(invoice.amountUsd).toFixed(2)} USD`;
  els.expiresAt.textContent = formatDate(invoice.expiresAt);
  els.invoiceId.textContent = invoice.id;
  els.invoiceToken.textContent = invoice.token;
  els.updatedAt.textContent = formatDate(invoice.updatedAt);
  els.currenciesText.textContent = (invoice.allowedCurrencies || []).join(", ");

  setStatusUI(invoice.status);
  renderWalletCards(invoice.payments || [], invoice.status);
  refreshCountdown();

  if (invoice.status === "paid") {
    const confirmed = (invoice.payments || []).find((item) => item.status === "confirmed");
    const txLine = confirmed?.txHash ? `\nHash tx: ${confirmed.txHash}` : "";
    els.finalMessage.className = "notice ok";
    els.finalMessage.textContent =
      `Pagamento ricevuto e confermato. Puoi chiudere la pagina.${txLine}`;
    els.finalMessage.classList.remove("hidden");
    return;
  }

  if (applyPaymentProgressHint(invoice)) {
    return;
  }

  if (invoice.status === "expired") {
    els.finalMessage.className = "notice warn";
    els.finalMessage.textContent = "Fattura scaduta. Richiedi una nuova fattura.";
    els.finalMessage.classList.remove("hidden");
    return;
  }

  els.finalMessage.className = "notice hidden";
  els.finalMessage.textContent = "";
}

function renderUnavailable(message) {
  state.unavailable = true;
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  if (state.pollTimer) clearInterval(state.pollTimer);

  document.body.innerHTML = `
    <div class="glow glow-a" aria-hidden="true"></div>
    <div class="glow glow-b" aria-hidden="true"></div>
    <main class="center-state">
      <section class="state-card">
        <span class="eyebrow">Fattura non disponibile</span>
        <h2>Pagamento non disponibile</h2>
        <p>${escapeHtml(message)}</p>
      </section>
    </main>
  `;
}

function refreshCountdown() {
  if (!state.invoice) return;
  const remainingMs = new Date(state.invoice.expiresAt).getTime() - Date.now();
  els.countdown.textContent = formatCountdown(remainingMs);
}
async function loadInvoice() {
  const response = await fetch(`/api/invoices/${token}`);
  if (response.status === 410) {
    renderUnavailable("La fattura e scaduta. Richiedi una nuova fattura all'amministratore.");
    return null;
  }
  if (response.status === 404) {
    renderUnavailable("La fattura non esiste o il link non e valido.");
    return null;
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.message || `Errore HTTP ${response.status}`);
  }

  applyInvoice(data.invoice);
  return data.invoice;
}

function attachWalletActions() {
  els.walletCards.addEventListener("click", async (event) => {
    const copyAmountBtn = event.target.closest("button[data-copy-amount]");
    if (copyAmountBtn && !copyAmountBtn.disabled) {
      await copyText(copyAmountBtn.dataset.copyAmount, "Importo copiato");
      return;
    }

    const copyAddressBtn = event.target.closest("button[data-copy-address]");
    if (copyAddressBtn && !copyAddressBtn.disabled) {
      await copyText(copyAddressBtn.dataset.copyAddress, "Indirizzo copiato");
      return;
    }

    const openExplorerBtn = event.target.closest("button[data-open-url]");
    if (openExplorerBtn && !openExplorerBtn.disabled) {
      window.open(openExplorerBtn.dataset.openUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const openWalletBtn = event.target.closest("button[data-open-wallet]");
    if (!openWalletBtn || openWalletBtn.disabled) {
      return;
    }

    const paymentId = openWalletBtn.dataset.openWallet;
    const payment = (state.invoice?.payments || []).find((item) => String(item.id) === String(paymentId));
    if (!payment) {
      return;
    }
    openWalletUri(payment);
  });
}

async function bootstrap() {
  try {
    const invoice = await loadInvoice();
    if (!invoice || state.unavailable) {
      return;
    }

    attachWalletActions();

    state.countdownTimer = setInterval(() => {
      if (!state.invoice || state.unavailable) return;
      refreshCountdown();
    }, 1000);

    state.pollTimer = setInterval(async () => {
      if (state.unavailable) {
        return;
      }
      try {
        const updated = await loadInvoice();
        if (!updated || state.unavailable) {
          return;
        }

        const status = String(updated.status || "").toLowerCase();
        if (status !== "pending") {
          clearInterval(state.pollTimer);
        }
      } catch (_error) {
        // no-op: retry on next poll
      }
    }, 10000);
  } catch (error) {
    renderUnavailable(`Errore durante il caricamento: ${error.message}`);
  }
}

bootstrap();
