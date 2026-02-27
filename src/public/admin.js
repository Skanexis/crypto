const AUTO_REFRESH_INTERVAL_MS = 15000;
const API_KEY_STORAGE_KEY = "enterprise_payments_admin_api_key";

const els = {
  apiKey: document.getElementById("apiKey"),
  connectBtn: document.getElementById("connectBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  autoRefreshBtn: document.getElementById("autoRefreshBtn"),
  createBtn: document.getElementById("createBtn"),
  verifyBtn: document.getElementById("verifyBtn"),
  deleteAllBtn: document.getElementById("deleteAllBtn"),
  searchBtn: document.getElementById("searchBtn"),
  statusFilter: document.getElementById("statusFilter"),
  searchInput: document.getElementById("searchInput"),
  exportInvoicesBtn: document.getElementById("exportInvoicesBtn"),
  invoiceTableBody: document.getElementById("invoiceTableBody"),
  amountUsd: document.getElementById("amountUsd"),
  telegramUserId: document.getElementById("telegramUserId"),
  createNotice: document.getElementById("createNotice"),
  listNotice: document.getElementById("listNotice"),
  detailNotice: document.getElementById("detailNotice"),
  selectedRef: document.getElementById("selectedRef"),
  detailSummary: document.getElementById("detailSummary"),
  paymentsList: document.getElementById("paymentsList"),
  markPaidCurrency: document.getElementById("markPaidCurrency"),
  markPaidTxHash: document.getElementById("markPaidTxHash"),
  markPaidAmount: document.getElementById("markPaidAmount"),
  markPaidBtn: document.getElementById("markPaidBtn"),
  eventsList: document.getElementById("eventsList"),
  transactionsList: document.getElementById("transactionsList"),
  txSearchInput: document.getElementById("txSearchInput"),
  txStatusFilter: document.getElementById("txStatusFilter"),
  txSearchBtn: document.getElementById("txSearchBtn"),
  txResetBtn: document.getElementById("txResetBtn"),
  exportTxBtn: document.getElementById("exportTxBtn"),
  txRefInput: document.getElementById("txRefInput"),
  txLookupBtn: document.getElementById("txLookupBtn"),
  txDetailCard: document.getElementById("txDetailCard"),
  riskRefreshBtn: document.getElementById("riskRefreshBtn"),
  riskTotalBadge: document.getElementById("riskTotalBadge"),
  riskSummary: document.getElementById("riskSummary"),
  riskAlerts: document.getElementById("riskAlerts"),
  mInvoicesTotal: document.getElementById("mInvoicesTotal"),
  mInvoicesPending: document.getElementById("mInvoicesPending"),
  mVolumePaid: document.getElementById("mVolumePaid"),
  mTxConfirmed: document.getElementById("mTxConfirmed"),
  toast: document.getElementById("toast"),
};

const state = {
  invoices: [],
  selectedInvoiceRef: null,
  selectedInvoice: null,
  selectedTxRef: null,
  selectedTx: null,
  riskMonitor: null,
  events: [],
  transactions: [],
  txFilterActive: false,
  autoRefreshEnabled: false,
  autoRefreshTimer: null,
  refreshInFlight: false,
  toastTimer: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function short(value, len = 14) {
  const text = String(value || "");
  if (!text || text.length <= len) return text;
  return `${text.slice(0, len)}...`;
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
  if (!value) return "-";
  return new Date(value).toLocaleString("it-IT");
}

function statusBadge(status) {
  const normalized = String(status || "").toLowerCase();
  const label = normalized ? localizeStatus(normalized) : "n/d";
  return `<span class="badge ${normalized}">${escapeHtml(label)}</span>`;
}

function riskBadge(severity) {
  const normalized = String(severity || "medium").toLowerCase();
  const map = {
    critical: "critico",
    high: "alto",
    medium: "medio",
  };
  return `<span class="badge ${normalized}">${escapeHtml(map[normalized] || normalized)}</span>`;
}

function setNotice(el, message, type = "") {
  if (!message) {
    el.className = "notice hidden";
    el.textContent = "";
    return;
  }
  el.className = `notice ${type}`.trim();
  el.textContent = message;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 1700);
}

function setBusy(button, busy, busyText = "...") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
}

function parseAmount(value) {
  return Number(String(value || "").trim().replace(",", "."));
}

function getApiKey() {
  return els.apiKey.value.trim();
}

function persistApiKey() {
  const key = getApiKey();
  if (!key) return;
  window.localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

function restoreApiKey() {
  const saved = window.localStorage.getItem(API_KEY_STORAGE_KEY);
  if (!saved) return;
  els.apiKey.value = saved;
}

async function request(path, options = {}, requireKey = true) {
  const headers = { ...(options.headers || {}) };
  if (requireKey) {
    const key = getApiKey();
    if (!key) {
      throw new Error("Inserisci la chiave API admin");
    }
    headers["x-api-key"] = key;
  }
  if (options.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.message || `Errore HTTP ${response.status}`);
  }
  return payload;
}

function selectedCurrencies() {
  return [...document.querySelectorAll('.currency-item input[type="checkbox"]:checked')].map((el) => el.value);
}

function hasTxFilters() {
  const query = String(els.txSearchInput?.value || "").trim();
  const status = String(els.txStatusFilter?.value || "all");
  return Boolean(query) || status !== "all";
}

function updateAutoRefreshButton() {
  if (!els.autoRefreshBtn) return;
  els.autoRefreshBtn.textContent = `Aggiornamento automatico: ${state.autoRefreshEnabled ? "ON" : "OFF"}`;
  els.autoRefreshBtn.classList.toggle("btn-primary", state.autoRefreshEnabled);
  els.autoRefreshBtn.classList.toggle("btn-ghost", !state.autoRefreshEnabled);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!state.autoRefreshEnabled) return;
  if (document.hidden) return;

  state.autoRefreshTimer = setInterval(async () => {
    if (state.refreshInFlight) {
      return;
    }
    try {
      await refreshAll();
    } catch (_error) {
      // Retry on the next tick.
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

function toggleAutoRefresh() {
  state.autoRefreshEnabled = !state.autoRefreshEnabled;
  updateAutoRefreshButton();
  if (state.autoRefreshEnabled) {
    showToast("Aggiornamento automatico attivato");
    startAutoRefresh();
    return;
  }
  showToast("Aggiornamento automatico disattivato");
  stopAutoRefresh();
}

function renderMetrics(metrics) {
  if (!metrics) {
    els.mInvoicesTotal.textContent = "-";
    els.mInvoicesPending.textContent = "-";
    els.mVolumePaid.textContent = "-";
    els.mTxConfirmed.textContent = "-";
    return;
  }

  els.mInvoicesTotal.textContent = String(metrics.invoices.total || 0);
  els.mInvoicesPending.textContent = String(metrics.invoices.pending || 0);
  els.mVolumePaid.textContent = `${Number(metrics.volume.paidUsd || 0).toFixed(2)} USD`;
  els.mTxConfirmed.textContent = String(metrics.payments.confirmed || 0);
}

function renderInvoiceTable() {
  if (!state.invoices.length) {
    els.invoiceTableBody.innerHTML =
      '<tr><td colspan="8" style="color: var(--ink-soft)">Nessuna fattura trovata</td></tr>';
    return;
  }

  els.invoiceTableBody.innerHTML = state.invoices
    .map((invoice) => {
      const ref = invoice.shortId || invoice.id;
      const telegram = invoice.telegramUserId || "-";
      const txPreview = invoice.txHashPreview ? short(invoice.txHashPreview, 20) : "-";
      return `
        <tr>
          <td>
            <div class="ref">${escapeHtml(ref)}</div>
            <small class="mono" style="color: var(--ink-soft)">${escapeHtml(short(invoice.id, 18))}</small>
          </td>
          <td><strong>${Number(invoice.amountUsd).toFixed(2)} USD</strong></td>
          <td>${statusBadge(invoice.status)}</td>
          <td>${escapeHtml(formatDate(invoice.expiresAt))}</td>
          <td class="mono">${escapeHtml(telegram)}</td>
          <td>${escapeHtml(formatDate(invoice.updatedAt))}</td>
          <td>
            <div class="mono">${escapeHtml(txPreview)}</div>
            <div class="inline-actions" style="margin-top: 4px">
              <button class="btn btn-ghost" data-copy="${escapeHtml(invoice.txHashPreview || "")}" ${
                invoice.txHashPreview ? "" : "disabled"
              }>Copia</button>
            </div>
          </td>
          <td>
            <div class="inline-actions">
              <button class="btn btn-secondary" data-action="view" data-ref="${escapeHtml(ref)}">Dettagli</button>
              <button class="btn btn-ghost" data-copy="${escapeHtml(invoice.paymentUrl || "")}" ${
                invoice.paymentUrl ? "" : "disabled"
              }>Copia link</button>
              <button class="btn btn-ghost" data-open-url="${escapeHtml(invoice.paymentUrl || "")}" ${
                invoice.paymentUrl ? "" : "disabled"
              }>Apri</button>
              <button class="btn btn-danger" data-action="delete" data-ref="${escapeHtml(ref)}">Elimina</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function summaryItem(label, value, mono = false) {
  return `
    <div class="kv-item">
      <small>${escapeHtml(label)}</small>
      <strong class="${mono ? "mono" : ""}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderInvoiceDetails() {
  const invoice = state.selectedInvoice;
  if (!invoice) {
    els.selectedRef.textContent = "Nessuna selezione";
    els.detailSummary.innerHTML = "";
    els.paymentsList.innerHTML = '<div class="notice">Seleziona una fattura dalla tabella.</div>';
    els.markPaidCurrency.innerHTML = '<option value="">Seleziona valuta</option>';
    return;
  }

  const ref = invoice.shortId || invoice.id;
  els.selectedRef.textContent = ref;

  els.detailSummary.innerHTML = [
    summaryItem("Rif fattura", ref, true),
    summaryItem("UUID fattura", invoice.id, true),
    summaryItem("Stato", localizeStatus(invoice.status)),
    summaryItem("Importo", `${Number(invoice.amountUsd).toFixed(2)} USD`),
    summaryItem("Utente Telegram", invoice.telegramUserId || "-", true),
    summaryItem("Scadenza", formatDate(invoice.expiresAt)),
    summaryItem("Link", invoice.paymentUrl, true),
    summaryItem("Aggiornata", formatDate(invoice.updatedAt)),
  ].join("");

  const payments = invoice.payments || [];
  if (!payments.length) {
    els.paymentsList.innerHTML = '<div class="notice">Nessuna transazione collegata.</div>';
  } else {
    els.paymentsList.innerHTML = payments
      .map((payment) => {
        const txHash = payment.txHash || "-";
        const paidAmount =
          payment.paidAmountCrypto !== null && payment.paidAmountCrypto !== undefined
            ? `${Number(payment.paidAmountCrypto)} ${payment.currency}`
            : "-";
        const expectedText = `${String(payment.expectedAmountCrypto)} ${payment.currency}`;
        return `
          <article class="tx-item">
            <div class="tx-row">
              <strong class="ref mono">${escapeHtml(payment.shortId || payment.id)}</strong>
              ${statusBadge(payment.status)}
            </div>
            <div class="tx-row">
              <small>${escapeHtml(payment.currency)} · ${escapeHtml(payment.network)}</small>
              <small>${escapeHtml(formatDate(payment.updatedAt))}</small>
            </div>
            <div class="copy-line">
              <div class="copy-field">
                <small>Importo atteso</small>
                <strong class="mono">${escapeHtml(expectedText)}</strong>
              </div>
              <button class="btn btn-ghost" data-copy="${escapeHtml(String(payment.expectedAmountCrypto))}">Copia importo</button>
            </div>
            <div class="copy-line">
              <div class="copy-field">
                <small>Indirizzo wallet</small>
                <strong class="mono">${escapeHtml(payment.walletAddress)}</strong>
              </div>
              <div class="inline-actions">
                <button class="btn btn-ghost" data-copy="${escapeHtml(payment.walletAddress)}">Copia wallet</button>
                <button class="btn btn-secondary" data-open-url="${escapeHtml(payment.explorerAddressUrl || "")}" ${
                  payment.explorerAddressUrl ? "" : "disabled"
                }>Explorer indirizzo</button>
              </div>
            </div>
            <div class="copy-line">
              <div class="copy-field">
                <small>Hash tx</small>
                <strong class="mono">${escapeHtml(txHash)}</strong>
              </div>
              <div class="inline-actions">
                <button class="btn btn-ghost" data-copy="${escapeHtml(txHash)}" ${txHash === "-" ? "disabled" : ""}>Copia tx</button>
                <button class="btn btn-secondary" data-open-url="${escapeHtml(payment.explorerTxUrl || "")}" ${
                  payment.explorerTxUrl ? "" : "disabled"
                }>Explorer tx</button>
              </div>
            </div>
            <div class="tx-row">
              <small>Importo pagato: ${escapeHtml(paidAmount)}</small>
              <small>Conferme: ${escapeHtml(String(payment.confirmations || 0))}</small>
            </div>
          </article>
        `;
      })
      .join("");
  }

  els.markPaidCurrency.innerHTML = payments
    .map((payment) => `<option value="${escapeHtml(payment.currency)}">${escapeHtml(payment.currency)}</option>`)
    .join("");
}

function renderEvents() {
  if (!state.events.length) {
    els.eventsList.innerHTML = '<div class="notice">Nessun evento disponibile.</div>';
    return;
  }

  els.eventsList.innerHTML = state.events
    .map((event) => {
      const payloadPreview = event.payload ? JSON.stringify(event.payload).slice(0, 180) : "-";
      const entity = event.entityShortId || event.entityId || "-";
      return `
        <article class="log-item">
          <div class="log-row">
            <strong>${escapeHtml(event.action)}</strong>
            <small>${escapeHtml(formatDate(event.createdAt))}</small>
          </div>
          <div class="log-row">
            <small>${escapeHtml(event.entityType)}: <span class="mono">${escapeHtml(entity)}</span></small>
          </div>
          <div class="log-row">
            <small>${escapeHtml(payloadPreview)}</small>
          </div>
        </article>
      `;
    })
    .join("");
}
function txInlineSummary(tx) {
  const hash = tx.txHash || "-";
  return `
    <article class="tx-item">
      <div class="tx-row">
        <strong class="mono">${escapeHtml(tx.shortId || tx.id)}</strong>
        ${statusBadge(tx.status)}
      </div>
      <div class="tx-row">
        <small>Fattura: <span class="mono">${escapeHtml(tx.invoiceShortId || tx.invoiceId)}</span></small>
        <small>${escapeHtml(formatDate(tx.updatedAt))}</small>
      </div>
      <div class="tx-row">
        <small>${escapeHtml(tx.currency)} ${escapeHtml(tx.network)} | Atteso ${escapeHtml(
          String(tx.expectedAmountCrypto),
        )}</small>
        <small>Pagato ${escapeHtml(
          tx.paidAmountCrypto !== null && tx.paidAmountCrypto !== undefined
            ? `${tx.paidAmountCrypto} ${tx.currency}`
            : "-",
        )}</small>
      </div>
      <div class="copy-line">
        <div class="copy-field">
          <small>Hash tx</small>
          <strong class="mono">${escapeHtml(hash)}</strong>
        </div>
        <div class="inline-actions">
          <button class="btn btn-ghost" data-copy="${escapeHtml(hash)}" ${hash === "-" ? "disabled" : ""}>Copia tx</button>
          <button class="btn btn-secondary" data-open-url="${escapeHtml(tx.explorerTxUrl || "")}" ${
            tx.explorerTxUrl ? "" : "disabled"
          }>Explorer</button>
          <button class="btn btn-secondary" data-tx-ref="${escapeHtml(tx.shortId || tx.id)}">Dettaglio</button>
        </div>
      </div>
    </article>
  `;
}

function renderTransactions() {
  if (!state.transactions.length) {
    els.transactionsList.innerHTML = '<div class="notice">Nessuna transazione disponibile.</div>';
    return;
  }

  els.transactionsList.innerHTML = state.transactions.map((tx) => txInlineSummary(tx)).join("");
}

function renderTxDetail() {
  if (!state.selectedTx) {
    els.txDetailCard.innerHTML = '<div class="notice">Inserisci riferimento/hash tx oppure clicca "Dettaglio" nel feed.</div>';
    return;
  }

  const tx = state.selectedTx;
  const hash = tx.txHash || "-";
  const paid =
    tx.paidAmountCrypto !== null && tx.paidAmountCrypto !== undefined
      ? `${tx.paidAmountCrypto} ${tx.currency}`
      : "-";

  els.txDetailCard.innerHTML = `
    <article class="tx-item">
      <div class="tx-row">
        <strong class="mono">${escapeHtml(tx.shortId || tx.id)}</strong>
        ${statusBadge(tx.status)}
      </div>
      <div class="tx-row">
        <small>Fattura: <span class="mono">${escapeHtml(tx.invoiceShortId || tx.invoiceId)}</span></small>
        <small>${escapeHtml(formatDate(tx.updatedAt))}</small>
      </div>
      <div class="copy-line">
        <div class="copy-field">
          <small>ID tecnico</small>
          <strong class="mono">${escapeHtml(tx.id)}</strong>
        </div>
        <button class="btn btn-ghost" data-copy="${escapeHtml(tx.id)}">Copia ID</button>
      </div>
      <div class="copy-line">
        <div class="copy-field">
          <small>Valuta / rete</small>
          <strong>${escapeHtml(tx.currency)} / ${escapeHtml(tx.network)}</strong>
        </div>
        <button class="btn btn-ghost" data-copy="${escapeHtml(tx.currency)} ${escapeHtml(tx.network)}">Copia</button>
      </div>
      <div class="copy-line">
        <div class="copy-field">
          <small>Indirizzo wallet</small>
          <strong class="mono">${escapeHtml(tx.walletAddress)}</strong>
        </div>
        <div class="inline-actions">
          <button class="btn btn-ghost" data-copy="${escapeHtml(tx.walletAddress)}">Copia wallet</button>
          <button class="btn btn-secondary" data-open-url="${escapeHtml(tx.explorerAddressUrl || "")}" ${
            tx.explorerAddressUrl ? "" : "disabled"
          }>Explorer indirizzo</button>
        </div>
      </div>
      <div class="copy-line">
        <div class="copy-field">
          <small>Hash tx</small>
          <strong class="mono">${escapeHtml(hash)}</strong>
        </div>
        <div class="inline-actions">
          <button class="btn btn-ghost" data-copy="${escapeHtml(hash)}" ${hash === "-" ? "disabled" : ""}>Copia tx</button>
          <button class="btn btn-secondary" data-open-url="${escapeHtml(tx.explorerTxUrl || "")}" ${
            tx.explorerTxUrl ? "" : "disabled"
          }>Explorer tx</button>
        </div>
      </div>
      <div class="tx-row">
        <small>Atteso: ${escapeHtml(String(tx.expectedAmountCrypto))} ${escapeHtml(tx.currency)}</small>
        <small>Pagato: ${escapeHtml(paid)}</small>
      </div>
      <div class="tx-row">
        <small>Conferme: ${escapeHtml(String(tx.confirmations || 0))}</small>
        <small>Stato fattura: ${escapeHtml(localizeStatus(tx.invoiceStatus || "-"))}</small>
      </div>
      <div class="inline-actions" style="margin-top: 8px">
        <button class="btn btn-secondary" data-action="open-invoice-from-tx" data-ref="${escapeHtml(
          tx.invoiceShortId || tx.invoiceId,
        )}">Apri fattura</button>
      </div>
    </article>
  `;
}

function renderRiskMonitor() {
  const risk = state.riskMonitor;
  if (!risk) {
    els.riskTotalBadge.textContent = "0 avvisi";
    els.riskSummary.innerHTML = "";
    els.riskAlerts.innerHTML = '<div class="notice">Nessun dato rischi disponibile.</div>';
    return;
  }

  const summary = risk.summary || {};
  const total = Number(summary.total || 0);
  const critical = Number(summary.critical || 0);
  const high = Number(summary.high || 0);
  const medium = Number(summary.medium || 0);
  els.riskTotalBadge.textContent = `${total} avvisi`;

  els.riskSummary.innerHTML = [
    summaryItem("Critici", String(critical)),
    summaryItem("Alti", String(high)),
    summaryItem("Medi", String(medium)),
    summaryItem("Mostrate", String(summary.displayed || 0)),
    summaryItem("Generato il", formatDate(risk.generatedAt)),
  ].join("");

  const alerts = Array.isArray(risk.alerts) ? risk.alerts : [];
  if (!alerts.length) {
    els.riskAlerts.innerHTML =
      '<div class="notice ok">Nessun avviso attivo. Stato operativo pulito.</div>';
    return;
  }

  els.riskAlerts.innerHTML = alerts
    .map((alert) => {
      const invoiceRef = alert.invoiceRef || "";
      const txRef = alert.txRef || "";
      const txHash = alert.txHash || "";
      const detailsPreview = alert.details
        ? JSON.stringify(alert.details).slice(0, 220)
        : "";
      return `
        <article class="tx-item">
          <div class="tx-row">
            <strong>${escapeHtml(alert.title || alert.code || "Avviso")}</strong>
            ${riskBadge(alert.severity)}
          </div>
          <div class="tx-row">
            <small class="mono">${escapeHtml(alert.code || "SCONOSCIUTO")}</small>
            <small>${escapeHtml(formatDate(alert.updatedAt))}</small>
          </div>
          <div class="tx-row">
            <small>${escapeHtml(alert.description || "-")}</small>
          </div>
          <div class="tx-row">
            <small>Entita: <span class="mono">${escapeHtml(alert.entityRef || "-")}</span></small>
          </div>
          ${
            detailsPreview
              ? `<div class="tx-row"><small>${escapeHtml(detailsPreview)}</small></div>`
              : ""
          }
          <div class="inline-actions" style="margin-top: 8px">
            <button class="btn btn-secondary" data-risk-open-invoice="${escapeHtml(invoiceRef)}" ${
              invoiceRef ? "" : "disabled"
            }>Apri fattura</button>
            <button class="btn btn-secondary" data-risk-open-tx="${escapeHtml(txRef)}" ${
              txRef ? "" : "disabled"
            }>Apri tx</button>
            <button class="btn btn-ghost" data-copy="${escapeHtml(txHash)}" ${
              txHash ? "" : "disabled"
            }>Copia hash</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function toCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(toCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(toCsvCell).join(","));
  }
  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function exportInvoicesCsv() {
  if (!state.invoices.length) {
    throw new Error("Nessuna fattura da esportare");
  }

  const rows = state.invoices.map((invoice) => [
    invoice.shortId || "",
    invoice.id || "",
    Number(invoice.amountUsd || 0).toFixed(2),
    invoice.status || "",
    invoice.telegramUserId || "",
    invoice.paymentUrl || "",
    invoice.expiresAt || "",
    invoice.updatedAt || "",
    invoice.txHashPreview || "",
    invoice.txShortIdPreview || "",
  ]);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadCsv(
    `invoices-${stamp}.csv`,
    [
      "invoice_short_id",
      "invoice_id",
      "amount_usd",
      "status",
      "telegram_user_id",
      "payment_url",
      "expires_at",
      "updated_at",
      "tx_hash_preview",
      "tx_short_id_preview",
    ],
    rows,
  );
}

function exportTransactionsCsv() {
  if (!state.transactions.length) {
    throw new Error("Nessuna transazione da esportare");
  }

  const rows = state.transactions.map((tx) => [
    tx.shortId || "",
    tx.id || "",
    tx.invoiceShortId || "",
    tx.invoiceId || "",
    tx.currency || "",
    tx.network || "",
    tx.status || "",
    tx.walletAddress || "",
    tx.expectedAmountCrypto ?? "",
    tx.paidAmountCrypto ?? "",
    tx.confirmations ?? "",
    tx.txHash || "",
    tx.explorerTxUrl || "",
    tx.updatedAt || "",
  ]);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadCsv(
    `transactions-${stamp}.csv`,
    [
      "tx_short_id",
      "tx_id",
      "invoice_short_id",
      "invoice_id",
      "currency",
      "network",
      "status",
      "wallet_address",
      "expected_amount",
      "paid_amount",
      "confirmations",
      "tx_hash",
      "explorer_tx_url",
      "updated_at",
    ],
    rows,
  );
}

async function loadDashboard() {
  const data = await request("/api/admin/dashboard?events_limit=30&tx_limit=40&risk_limit=100");
  renderMetrics(data.metrics);
  state.riskMonitor = data.riskMonitor || null;
  renderRiskMonitor();
  if (!state.selectedInvoice && !hasTxFilters()) {
    state.events = data.recentEvents || [];
    state.transactions = data.recentTransactions || [];
    renderEvents();
    renderTransactions();
  }
}

async function loadRiskMonitor() {
  const data = await request("/api/admin/risk-monitor?limit=120");
  state.riskMonitor = data.riskMonitor || null;
  renderRiskMonitor();
}

async function loadInvoices() {
  const search = encodeURIComponent(els.searchInput.value.trim());
  const status = encodeURIComponent(els.statusFilter.value);
  const data = await request(`/api/admin/invoices?status=${status}&search=${search}&limit=180`);
  state.invoices = data.invoices || [];
  renderInvoiceTable();
}

async function loadTransactionsFeed() {
  const search = encodeURIComponent(String(els.txSearchInput?.value || "").trim());
  const status = encodeURIComponent(String(els.txStatusFilter?.value || "all"));
  const data = await request(`/api/admin/transactions?limit=100&search=${search}&status=${status}`);
  state.txFilterActive = hasTxFilters();
  state.transactions = data.transactions || [];
  renderTransactions();
}
async function loadInvoiceDetails(invoiceRef) {
  const safeRef = encodeURIComponent(invoiceRef);
  const data = await request(`/api/admin/invoices/${safeRef}`);
  state.selectedInvoice = data.invoice;
  state.selectedInvoiceRef = data.invoice?.shortId || data.invoice?.id || invoiceRef;
  state.events = data.events || [];
  state.transactions = data.transactions || [];
  renderInvoiceDetails();
  renderEvents();
  renderTransactions();
}

async function loadTransactionDetail(txRef, syncInput = true) {
  const safeRef = String(txRef || "").trim();
  if (!safeRef) {
    throw new Error("Inserisci riferimento TX o hash tx");
  }

  const data = await request(`/api/admin/transactions/${encodeURIComponent(safeRef)}`);
  state.selectedTx = data.transaction;
  state.selectedTxRef = data.transaction?.shortId || data.transaction?.id || safeRef;
  if (syncInput && els.txRefInput) {
    els.txRefInput.value = state.selectedTxRef;
  }
  renderTxDetail();
}

async function refreshAll() {
  if (state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    await Promise.all([loadDashboard(), loadInvoices()]);
    if (state.selectedInvoiceRef) {
      await loadInvoiceDetails(state.selectedInvoiceRef);
    } else if (hasTxFilters()) {
      await loadTransactionsFeed();
    }
    if (state.selectedTxRef) {
      await loadTransactionDetail(state.selectedTxRef, false);
    }
  } finally {
    state.refreshInFlight = false;
  }
}

async function createInvoice() {
  const amountUsd = parseAmount(els.amountUsd.value);
  const telegramUserId = els.telegramUserId.value.trim();
  const allowedCurrencies = selectedCurrencies();

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("Importo USD non valido");
  }
  if (!allowedCurrencies.length) {
    throw new Error("Seleziona almeno una valuta");
  }

  setBusy(els.createBtn, true, "Creazione...");
  try {
    const data = await request("/api/invoices", {
      method: "POST",
      body: JSON.stringify({
        amount_usd: amountUsd,
        telegram_user_id: telegramUserId || null,
        allowed_currencies: allowedCurrencies,
      }),
    });

    const invoice = data.invoice;
    setNotice(
      els.createNotice,
      `Fattura creata\nRif: ${invoice.shortId}\nID: ${invoice.id}\nLink: ${invoice.paymentUrl}`,
      "ok",
    );
    await refreshAll();
    await loadInvoiceDetails(invoice.shortId || invoice.id);
  } finally {
    setBusy(els.createBtn, false);
  }
}

async function verifyNow() {
  setBusy(els.verifyBtn, true, "Verifica...");
  try {
    const data = await request("/api/payments/verify-now", { method: "POST" });
    const summary = data.summary;
    setNotice(
      els.createNotice,
      `Verifica completata\nControllate: ${summary.checked}\nPagate: ${summary.paid}\nErrori: ${summary.errors.length}`,
      summary.errors.length ? "warn" : "ok",
    );
    await refreshAll();
  } finally {
    setBusy(els.verifyBtn, false);
  }
}

async function deleteAllInvoices() {
  const phrase = String(window.prompt("Per confermare scrivi ELIMINA_TUTTO") || "")
    .trim()
    .toUpperCase();
  if (phrase !== "ELIMINA_TUTTO" && phrase !== "DELETE_ALL") {
    return;
  }

  setBusy(els.deleteAllBtn, true, "Elimino...");
  try {
    const data = await request("/api/invoices/delete-all", {
      method: "POST",
      body: JSON.stringify({ confirm: "ELIMINA_TUTTO" }),
    });

    setNotice(
      els.createNotice,
      `Eliminazione completata\nFatture: ${data.summary.deletedInvoices}\nPagamenti: ${data.summary.deletedPayments}`,
      "warn",
    );
    state.selectedInvoice = null;
    state.selectedInvoiceRef = null;
    state.selectedTx = null;
    state.selectedTxRef = null;
    renderInvoiceDetails();
    renderTxDetail();
    await refreshAll();
  } finally {
    setBusy(els.deleteAllBtn, false);
  }
}

async function deleteOneInvoice(invoiceRef) {
  const confirmDelete = window.confirm(`Eliminare la fattura ${invoiceRef}?`);
  if (!confirmDelete) return;

  await request(`/api/admin/invoices/${encodeURIComponent(invoiceRef)}`, {
    method: "DELETE",
  });

  if (state.selectedInvoiceRef === invoiceRef) {
    state.selectedInvoice = null;
    state.selectedInvoiceRef = null;
    renderInvoiceDetails();
  }

  setNotice(els.listNotice, `Fattura ${invoiceRef} eliminata`, "warn");
  await refreshAll();
}

async function markPaid() {
  if (!state.selectedInvoiceRef) {
    throw new Error("Seleziona prima una fattura");
  }
  const currency = els.markPaidCurrency.value;
  if (!currency) {
    throw new Error("Seleziona valuta");
  }

  const txHash = els.markPaidTxHash.value.trim() || null;
  const parsedAmount = parseAmount(els.markPaidAmount.value);
  const paidAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : null;
  if (!txHash && paidAmount === null) {
    throw new Error("Inserisci hash tx o importo pagato per confermare manualmente.");
  }

  setBusy(els.markPaidBtn, true, "Aggiorno...");
  try {
    const data = await request(`/api/invoices/${encodeURIComponent(state.selectedInvoiceRef)}/mark-paid`, {
      method: "POST",
      body: JSON.stringify({
        currency,
        tx_hash: txHash,
        confirmations: 1,
        paid_amount_crypto: paidAmount,
      }),
    });

    if (data.changed) {
      setNotice(
        els.detailNotice,
        `Pagamento registrato\nFattura: ${data.invoice.shortId || data.invoice.id}\nStato: ${localizeStatus(data.invoice.status)}`,
        "ok",
      );
    } else {
      setNotice(els.detailNotice, `Nessuna modifica\nMotivo: ${data.reason || "n/d"}`, "warn");
    }

    els.markPaidTxHash.value = "";
    els.markPaidAmount.value = "";
    await refreshAll();
    await loadInvoiceDetails(state.selectedInvoiceRef);
  } finally {
    setBusy(els.markPaidBtn, false);
  }
}

async function copyText(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copiato");
  } catch (_error) {
    showToast("Copia non riuscita");
  }
}

function openUrl(url) {
  const value = String(url || "").trim();
  if (!value) return;
  window.open(value, "_blank", "noopener,noreferrer");
}
els.connectBtn.addEventListener("click", async () => {
  setBusy(els.connectBtn, true, "Connessione...");
  try {
    persistApiKey();
    setNotice(els.listNotice, "", "");
    setNotice(els.createNotice, "", "");
    setNotice(els.detailNotice, "", "");
    await refreshAll();
    showToast("Connesso");
    startAutoRefresh();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  } finally {
    setBusy(els.connectBtn, false);
  }
});

els.refreshBtn.addEventListener("click", async () => {
  setBusy(els.refreshBtn, true, "Aggiorno...");
  try {
    await refreshAll();
    showToast("Aggiornato");
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  } finally {
    setBusy(els.refreshBtn, false);
  }
});

els.autoRefreshBtn.addEventListener("click", () => {
  toggleAutoRefresh();
});

els.searchBtn.addEventListener("click", async () => {
  setBusy(els.searchBtn, true, "Cerco...");
  try {
    await loadInvoices();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  } finally {
    setBusy(els.searchBtn, false);
  }
});

els.statusFilter.addEventListener("change", async () => {
  try {
    await loadInvoices();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.searchInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  try {
    await loadInvoices();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.txSearchBtn.addEventListener("click", async () => {
  setBusy(els.txSearchBtn, true, "Filtro...");
  try {
    await loadTransactionsFeed();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  } finally {
    setBusy(els.txSearchBtn, false);
  }
});

els.txStatusFilter.addEventListener("change", async () => {
  try {
    await loadTransactionsFeed();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.txSearchInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  try {
    await loadTransactionsFeed();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.txResetBtn.addEventListener("click", async () => {
  els.txSearchInput.value = "";
  els.txStatusFilter.value = "all";
  state.txFilterActive = false;
  try {
    await loadDashboard();
    showToast("Filtri tx resettati");
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.txLookupBtn.addEventListener("click", async () => {
  setBusy(els.txLookupBtn, true, "Carico...");
  try {
    await loadTransactionDetail(els.txRefInput.value.trim(), false);
    showToast("Dettaglio tx caricato");
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  } finally {
    setBusy(els.txLookupBtn, false);
  }
});

els.txRefInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  try {
    await loadTransactionDetail(els.txRefInput.value.trim(), false);
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.exportInvoicesBtn.addEventListener("click", () => {
  try {
    exportInvoicesCsv();
    showToast("CSV fatture esportato");
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.exportTxBtn.addEventListener("click", () => {
  try {
    exportTransactionsCsv();
    showToast("CSV transazioni esportato");
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.riskRefreshBtn.addEventListener("click", async () => {
  setBusy(els.riskRefreshBtn, true, "Aggiorno...");
  try {
    await loadRiskMonitor();
    showToast("Monitor rischi aggiornato");
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  } finally {
    setBusy(els.riskRefreshBtn, false);
  }
});

els.createBtn.addEventListener("click", async () => {
  try {
    await createInvoice();
  } catch (error) {
    setNotice(els.createNotice, error.message, "error");
  }
});

els.verifyBtn.addEventListener("click", async () => {
  try {
    await verifyNow();
  } catch (error) {
    setNotice(els.createNotice, error.message, "error");
  }
});

els.deleteAllBtn.addEventListener("click", async () => {
  try {
    await deleteAllInvoices();
  } catch (error) {
    setNotice(els.createNotice, error.message, "error");
  }
});

els.markPaidBtn.addEventListener("click", async () => {
  try {
    await markPaid();
  } catch (error) {
    setNotice(els.detailNotice, error.message, "error");
  }
});

els.invoiceTableBody.addEventListener("click", async (event) => {
  const openButton = event.target.closest("button[data-open-url]");
  if (openButton && !openButton.disabled) {
    openUrl(openButton.dataset.openUrl);
    return;
  }

  const copyButton = event.target.closest("button[data-copy]");
  if (copyButton && !copyButton.disabled) {
    await copyText(copyButton.dataset.copy);
    return;
  }

  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const ref = button.dataset.ref;
  const action = button.dataset.action;

  try {
    if (action === "view") {
      await loadInvoiceDetails(ref);
      return;
    }
    if (action === "delete") {
      await deleteOneInvoice(ref);
    }
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

els.paymentsList.addEventListener("click", async (event) => {
  const openBtn = event.target.closest("button[data-open-url]");
  if (openBtn && !openBtn.disabled) {
    openUrl(openBtn.dataset.openUrl);
    return;
  }

  const button = event.target.closest("button[data-copy]");
  if (!button || button.disabled) return;
  await copyText(button.dataset.copy);
});

els.transactionsList.addEventListener("click", async (event) => {
  const openBtn = event.target.closest("button[data-open-url]");
  if (openBtn && !openBtn.disabled) {
    openUrl(openBtn.dataset.openUrl);
    return;
  }

  const txDetailBtn = event.target.closest("button[data-tx-ref]");
  if (txDetailBtn && !txDetailBtn.disabled) {
    try {
      await loadTransactionDetail(txDetailBtn.dataset.txRef);
    } catch (error) {
      setNotice(els.listNotice, error.message, "error");
    }
    return;
  }

  const button = event.target.closest("button[data-copy]");
  if (!button || button.disabled) return;
  await copyText(button.dataset.copy);
});

els.txDetailCard.addEventListener("click", async (event) => {
  const openBtn = event.target.closest("button[data-open-url]");
  if (openBtn && !openBtn.disabled) {
    openUrl(openBtn.dataset.openUrl);
    return;
  }

  const invoiceBtn = event.target.closest("button[data-action='open-invoice-from-tx']");
  if (invoiceBtn && !invoiceBtn.disabled) {
    try {
      await loadInvoiceDetails(invoiceBtn.dataset.ref);
      showToast("Dettaglio fattura caricato");
    } catch (error) {
      setNotice(els.listNotice, error.message, "error");
    }
    return;
  }

  const copyBtn = event.target.closest("button[data-copy]");
  if (!copyBtn || copyBtn.disabled) return;
  await copyText(copyBtn.dataset.copy);
});

els.riskAlerts.addEventListener("click", async (event) => {
  const invoiceBtn = event.target.closest("button[data-risk-open-invoice]");
  if (invoiceBtn && !invoiceBtn.disabled) {
    try {
      await loadInvoiceDetails(invoiceBtn.dataset.riskOpenInvoice);
      showToast("Fattura aperta dal monitor rischi");
    } catch (error) {
      setNotice(els.listNotice, error.message, "error");
    }
    return;
  }

  const txBtn = event.target.closest("button[data-risk-open-tx]");
  if (txBtn && !txBtn.disabled) {
    try {
      await loadTransactionDetail(txBtn.dataset.riskOpenTx);
      showToast("Tx aperta dal monitor rischi");
    } catch (error) {
      setNotice(els.listNotice, error.message, "error");
    }
    return;
  }

  const copyBtn = event.target.closest("button[data-copy]");
  if (!copyBtn || copyBtn.disabled) return;
  await copyText(copyBtn.dataset.copy);
});

els.apiKey.addEventListener("blur", persistApiKey);
els.apiKey.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  try {
    persistApiKey();
    await refreshAll();
    showToast("Connesso");
    startAutoRefresh();
  } catch (error) {
    setNotice(els.listNotice, error.message, "error");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAutoRefresh();
    return;
  }
  startAutoRefresh();
});

window.addEventListener("beforeunload", () => {
  stopAutoRefresh();
});

restoreApiKey();
updateAutoRefreshButton();
renderInvoiceTable();
renderInvoiceDetails();
renderEvents();
renderTransactions();
renderTxDetail();
renderRiskMonitor();
