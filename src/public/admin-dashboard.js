(() => {
  const A = window.AdminCommon;
  if (!A) return;

  const els = {
    headerNotice: document.getElementById("headerNotice"),
    amountUsd: document.getElementById("amountUsd"),
    telegramUserId: document.getElementById("telegramUserId"),
    createBtn: document.getElementById("createBtn"),
    verifyBtn: document.getElementById("verifyBtn"),
    deleteAllBtn: document.getElementById("deleteAllBtn"),
    createNotice: document.getElementById("createNotice"),
    pendingInvoicesList: document.getElementById("pendingInvoicesList"),
    recentTransactionsList: document.getElementById("recentTransactionsList"),
    riskGeneratedAt: document.getElementById("riskGeneratedAt"),
    riskMiniSummary: document.getElementById("riskMiniSummary"),
    riskTopAlerts: document.getElementById("riskTopAlerts"),
  };

  const state = {
    pendingInvoices: [],
    recentTransactions: [],
    riskMonitor: null,
  };

  function selectedCurrencies() {
    return [...document.querySelectorAll('.currency-item input[type="checkbox"]:checked')].map(
      (element) => element.value,
    );
  }

  function renderPendingInvoices() {
    if (!els.pendingInvoicesList) return;
    if (!state.pendingInvoices.length) {
      els.pendingInvoicesList.innerHTML =
        '<div class="card-line"><small class="muted">Nessuna fattura in attesa.</small></div>';
      return;
    }

    els.pendingInvoicesList.innerHTML = state.pendingInvoices
      .map((invoice) => {
        const ref = invoice.shortId || invoice.id;
        const link = invoice.paymentUrl || "";
        return `
          <article class="tx-item">
            <div class="row">
              <strong class="ref mono">${A.escapeHtml(ref)}</strong>
              ${A.statusBadge(invoice.status)}
            </div>
            <div class="row">
              <small>Importo: ${Number(invoice.amountUsd || 0).toFixed(2)} USD</small>
              <small>Scadenza: ${A.escapeHtml(A.formatDate(invoice.expiresAt))}</small>
            </div>
            <div class="row">
              <small>Telegram: <span class="mono">${A.escapeHtml(invoice.telegramUserId || "-")}</span></small>
              <small>Aggiornata: ${A.escapeHtml(A.formatDate(invoice.updatedAt))}</small>
            </div>
            <div class="inline-actions">
              <button class="btn btn-secondary" data-open-invoice="${A.escapeHtml(ref)}">Dettagli</button>
              <button class="btn btn-ghost" data-copy="${A.escapeHtml(link)}" ${link ? "" : "disabled"}>Copia link</button>
              <button class="btn btn-ghost" data-open-url="${A.escapeHtml(link)}" ${link ? "" : "disabled"}>Apri link</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderRecentTransactions() {
    if (!els.recentTransactionsList) return;
    if (!state.recentTransactions.length) {
      els.recentTransactionsList.innerHTML =
        '<div class="card-line"><small class="muted">Nessuna transazione recente.</small></div>';
      return;
    }

    els.recentTransactionsList.innerHTML = state.recentTransactions
      .map((tx) => {
        const txRef = tx.shortId || tx.id;
        const invoiceRef = tx.invoiceShortId || tx.invoiceId;
        const hash = tx.txHash || "-";
        return `
          <article class="tx-item">
            <div class="row">
              <strong class="mono">${A.escapeHtml(txRef)}</strong>
              ${A.statusBadge(tx.status)}
            </div>
            <div class="row">
              <small>${A.escapeHtml(tx.currency)} ${A.escapeHtml(tx.network)}</small>
              <small>Conferme: ${A.escapeHtml(String(tx.confirmations || 0))}</small>
            </div>
            <div class="row">
              <small>Fattura: <span class="mono">${A.escapeHtml(invoiceRef)}</span></small>
              <small>${A.escapeHtml(A.formatDate(tx.updatedAt))}</small>
            </div>
            <div class="copy-line">
              <div class="copy-field">
                <small>Hash tx</small>
                <strong class="mono">${A.escapeHtml(hash)}</strong>
              </div>
              <div class="inline-actions">
                <button class="btn btn-ghost" data-copy="${A.escapeHtml(hash)}" ${hash === "-" ? "disabled" : ""}>Copia tx</button>
                <button class="btn btn-secondary" data-open-url="${A.escapeHtml(tx.explorerTxUrl || "")}" ${tx.explorerTxUrl ? "" : "disabled"}>Explorer</button>
                <a class="btn btn-ghost" href="/admin/transactions?tx=${encodeURIComponent(txRef)}">Dettagli</a>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderRiskSnapshot() {
    if (!els.riskMiniSummary || !els.riskTopAlerts || !els.riskGeneratedAt) return;
    const monitor = state.riskMonitor;
    if (!monitor) {
      els.riskGeneratedAt.textContent = "-";
      els.riskMiniSummary.innerHTML = "";
      els.riskTopAlerts.innerHTML =
        '<div class="card-line"><small class="muted">Monitor rischi non disponibile.</small></div>';
      return;
    }

    const summary = monitor.summary || {};
    els.riskGeneratedAt.textContent = `Aggiornato: ${A.formatDate(monitor.generatedAt)}`;
    els.riskMiniSummary.innerHTML = `
      <article class="risk-box critical">
        <small>Critici</small>
        <strong>${Number(summary.critical || 0)}</strong>
      </article>
      <article class="risk-box high">
        <small>Alti</small>
        <strong>${Number(summary.high || 0)}</strong>
      </article>
      <article class="risk-box medium">
        <small>Medi</small>
        <strong>${Number(summary.medium || 0)}</strong>
      </article>
    `;

    const alerts = (monitor.alerts || []).slice(0, 4);
    if (!alerts.length) {
      els.riskTopAlerts.innerHTML =
        '<div class="card-line"><small class="muted">Nessun alert attivo.</small></div>';
      return;
    }

    els.riskTopAlerts.innerHTML = alerts
      .map((alert) => {
        const invoiceRef = alert.invoiceRef || "";
        const txRef = alert.txRef || "";
        const txHash = alert.txHash || "";
        const invoiceAction = invoiceRef
          ? `<a class="btn btn-ghost" href="/admin/invoices?ref=${encodeURIComponent(invoiceRef)}">Fattura</a>`
          : '<button class="btn btn-ghost" disabled>Fattura</button>';
        const txAction = txRef
          ? `<a class="btn btn-ghost" href="/admin/transactions?tx=${encodeURIComponent(txRef)}">Tx</a>`
          : '<button class="btn btn-ghost" disabled>Tx</button>';
        return `
          <article class="tx-item">
            <div class="row">
              <strong>${A.escapeHtml(alert.title || "Alert")}</strong>
              ${A.riskBadge(alert.severity)}
            </div>
            <div class="row">
              <small>${A.escapeHtml(alert.description || "-")}</small>
            </div>
            <div class="row">
              <small>Codice: <span class="mono">${A.escapeHtml(alert.code || "-")}</span></small>
              <small>${A.escapeHtml(A.formatDate(alert.updatedAt))}</small>
            </div>
            <div class="inline-actions">
              <a class="btn btn-secondary" href="/admin/risks">Apri monitor</a>
              ${invoiceAction}
              ${txAction}
              <button class="btn btn-ghost" data-copy="${A.escapeHtml(txHash)}" ${txHash ? "" : "disabled"}>Copia hash</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  async function loadDashboard() {
    const data = await A.request("/api/admin/dashboard?events_limit=8&tx_limit=18&risk_limit=40");
    A.renderMetrics(data.metrics);
    state.recentTransactions = data.recentTransactions || [];
    state.riskMonitor = data.riskMonitor || null;
    renderRecentTransactions();
    renderRiskSnapshot();
  }

  async function loadPendingInvoices() {
    const data = await A.request("/api/invoices/pending?limit=10");
    state.pendingInvoices = data.invoices || [];
    renderPendingInvoices();
  }

  async function refreshPage() {
    await Promise.all([loadDashboard(), loadPendingInvoices()]);
  }

  async function createInvoice() {
    const amountUsd = A.parseAmount(els.amountUsd?.value);
    const telegramUserId = String(els.telegramUserId?.value || "").trim();
    const allowedCurrencies = selectedCurrencies();

    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error("Importo USD non valido");
    }
    if (!allowedCurrencies.length) {
      throw new Error("Seleziona almeno una valuta");
    }

    A.setBusy(els.createBtn, true, "Creazione...");
    try {
      const data = await A.request("/api/invoices", {
        method: "POST",
        body: JSON.stringify({
          amount_usd: amountUsd,
          telegram_user_id: telegramUserId || null,
          allowed_currencies: allowedCurrencies,
        }),
      });

      const invoice = data.invoice;
      A.setNotice(
        els.createNotice,
        `Fattura creata\nRif: ${invoice.shortId}\nLink: ${invoice.paymentUrl}`,
        "ok",
      );
      await refreshPage();
    } finally {
      A.setBusy(els.createBtn, false);
    }
  }

  async function verifyNow() {
    A.setBusy(els.verifyBtn, true, "Verifica...");
    try {
      const data = await A.request("/api/payments/verify-now", { method: "POST" });
      const summary = data.summary || {};
      const errors = Array.isArray(summary.errors) ? summary.errors.length : 0;
      A.setNotice(
        els.createNotice,
        `Verifica completata\nControllate: ${Number(summary.checked || 0)}\nPagate: ${Number(summary.paid || 0)}\nErrori: ${errors}`,
        errors ? "warn" : "ok",
      );
      await refreshPage();
    } finally {
      A.setBusy(els.verifyBtn, false);
    }
  }

  async function deleteAllInvoices() {
    const phrase = String(window.prompt("Per confermare scrivi ELIMINA_TUTTO") || "")
      .trim()
      .toUpperCase();
    if (phrase !== "ELIMINA_TUTTO" && phrase !== "DELETE_ALL") {
      return;
    }

    A.setBusy(els.deleteAllBtn, true, "Elimino...");
    try {
      const data = await A.request("/api/invoices/delete-all", {
        method: "POST",
        body: JSON.stringify({ confirm: "ELIMINA_TUTTO" }),
      });
      const summary = data.summary || {};
      A.setNotice(
        els.createNotice,
        `Eliminazione completata\nFatture: ${Number(summary.deletedInvoices || 0)}\nPagamenti: ${Number(summary.deletedPayments || 0)}`,
        "warn",
      );
      await refreshPage();
    } finally {
      A.setBusy(els.deleteAllBtn, false);
    }
  }

  els.createBtn?.addEventListener("click", async () => {
    try {
      await createInvoice();
      A.showToast("Fattura creata");
    } catch (error) {
      A.setNotice(els.createNotice, error.message, "error");
    }
  });

  els.verifyBtn?.addEventListener("click", async () => {
    try {
      await verifyNow();
      A.showToast("Verifica completata");
    } catch (error) {
      A.setNotice(els.createNotice, error.message, "error");
    }
  });

  els.deleteAllBtn?.addEventListener("click", async () => {
    try {
      await deleteAllInvoices();
    } catch (error) {
      A.setNotice(els.createNotice, error.message, "error");
    }
  });

  els.pendingInvoicesList?.addEventListener("click", async (event) => {
    const openUrlBtn = event.target.closest("button[data-open-url]");
    if (openUrlBtn && !openUrlBtn.disabled) {
      A.openUrl(openUrlBtn.dataset.openUrl);
      return;
    }

    const copyBtn = event.target.closest("button[data-copy]");
    if (copyBtn && !copyBtn.disabled) {
      await A.copyText(copyBtn.dataset.copy);
      return;
    }

    const openInvoiceBtn = event.target.closest("button[data-open-invoice]");
    if (openInvoiceBtn && !openInvoiceBtn.disabled) {
      const ref = openInvoiceBtn.dataset.openInvoice;
      window.location.href = `/admin/invoices?ref=${encodeURIComponent(ref)}`;
    }
  });

  els.recentTransactionsList?.addEventListener("click", async (event) => {
    const openUrlBtn = event.target.closest("button[data-open-url]");
    if (openUrlBtn && !openUrlBtn.disabled) {
      A.openUrl(openUrlBtn.dataset.openUrl);
      return;
    }
    const copyBtn = event.target.closest("button[data-copy]");
    if (copyBtn && !copyBtn.disabled) {
      await A.copyText(copyBtn.dataset.copy);
    }
  });

  els.riskTopAlerts?.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("button[data-copy]");
    if (copyBtn && !copyBtn.disabled) {
      await A.copyText(copyBtn.dataset.copy);
    }
  });

  A.initShell({
    page: "dashboard",
    onRefresh: refreshPage,
    autoRefreshIntervalMs: 15000,
  });

  refreshPage().catch((error) => {
    A.setNotice(els.headerNotice, error.message, "error");
  });
})();
