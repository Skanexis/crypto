(() => {
  const A = window.AdminCommon;
  if (!A) return;

  const els = {
    headerNotice: document.getElementById("headerNotice"),
    listNotice: document.getElementById("listNotice"),
    riskRefreshBtn: document.getElementById("riskRefreshBtn"),
    riskTotalBadge: document.getElementById("riskTotalBadge"),
    riskSummaryGrid: document.getElementById("riskSummaryGrid"),
    riskCodesList: document.getElementById("riskCodesList"),
    riskAlerts: document.getElementById("riskAlerts"),
  };

  const state = {
    riskMonitor: null,
  };

  function renderRiskMonitor() {
    if (!els.riskSummaryGrid || !els.riskCodesList || !els.riskAlerts || !els.riskTotalBadge) return;

    if (!state.riskMonitor) {
      els.riskTotalBadge.textContent = "0 avvisi";
      els.riskSummaryGrid.innerHTML = "";
      els.riskCodesList.innerHTML =
        '<div class="card-line"><small class="muted">Nessun dato disponibile.</small></div>';
      els.riskAlerts.innerHTML =
        '<div class="card-line"><small class="muted">Nessun alert disponibile.</small></div>';
      return;
    }

    const summary = state.riskMonitor.summary || {};
    const alerts = state.riskMonitor.alerts || [];
    const generatedAt = state.riskMonitor.generatedAt || null;
    els.riskTotalBadge.textContent = `${Number(summary.total || 0)} avvisi`;
    els.riskSummaryGrid.innerHTML = `
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
      <article class="risk-box">
        <small>Visualizzati</small>
        <strong>${Number(summary.displayed || 0)}</strong>
      </article>
      <article class="risk-box">
        <small>Totale rilevati</small>
        <strong>${Number(summary.total || 0)}</strong>
      </article>
      <article class="risk-box">
        <small>Ultimo aggiornamento</small>
        <strong>${A.escapeHtml(generatedAt ? A.formatDate(generatedAt) : "-")}</strong>
      </article>
    `;

    const byCodeEntries = Object.entries(summary.byCode || {}).sort((a, b) => b[1] - a[1]);
    if (!byCodeEntries.length) {
      els.riskCodesList.innerHTML =
        '<div class="card-line"><small class="muted">Nessun codice rischio attivo.</small></div>';
    } else {
      els.riskCodesList.innerHTML = byCodeEntries
        .map(([code, total]) => {
          return `
            <article class="card-line">
              <div class="row">
                <strong class="mono">${A.escapeHtml(code)}</strong>
                <small>${Number(total)} occorrenze</small>
              </div>
            </article>
          `;
        })
        .join("");
    }

    if (!alerts.length) {
      els.riskAlerts.innerHTML =
        '<div class="card-line"><small class="muted">Nessun alert attivo.</small></div>';
      return;
    }

    els.riskAlerts.innerHTML = alerts
      .map((alert) => {
        const invoiceRef = alert.invoiceRef || "";
        const txRef = alert.txRef || "";
        const txHash = alert.txHash || "";
        const invoiceAction = invoiceRef
          ? `<a class="btn btn-secondary" href="/admin/invoices?ref=${encodeURIComponent(invoiceRef)}">Apri fattura</a>`
          : '<button class="btn btn-secondary" disabled>Apri fattura</button>';
        const txAction = txRef
          ? `<a class="btn btn-secondary" href="/admin/transactions?tx=${encodeURIComponent(txRef)}">Apri tx</a>`
          : '<button class="btn btn-secondary" disabled>Apri tx</button>';
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
            <div class="row">
              <small>Entita: ${A.escapeHtml(alert.entityType || "-")} <span class="mono">${A.escapeHtml(
          alert.entityRef || "-",
        )}</span></small>
            </div>
            <div class="inline-actions">
              ${invoiceAction}
              ${txAction}
              <button class="btn btn-ghost" data-copy="${A.escapeHtml(txHash)}" ${txHash ? "" : "disabled"}>Copia hash</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  async function loadMetrics() {
    const data = await A.request("/api/admin/dashboard?events_limit=1&tx_limit=1&risk_limit=1");
    A.renderMetrics(data.metrics);
  }

  async function loadRiskMonitor() {
    const data = await A.request("/api/admin/risk-monitor?limit=220");
    state.riskMonitor = data.riskMonitor || null;
    renderRiskMonitor();
  }

  async function refreshPage() {
    await Promise.all([loadMetrics(), loadRiskMonitor()]);
  }

  els.riskRefreshBtn?.addEventListener("click", async () => {
    A.setBusy(els.riskRefreshBtn, true, "Aggiorno...");
    try {
      await refreshPage();
      A.showToast("Monitor rischi aggiornato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    } finally {
      A.setBusy(els.riskRefreshBtn, false);
    }
  });

  els.riskAlerts?.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("button[data-copy]");
    if (copyBtn && !copyBtn.disabled) {
      await A.copyText(copyBtn.dataset.copy);
    }
  });

  A.initShell({
    page: "risks",
    onRefresh: refreshPage,
    autoRefreshIntervalMs: 20000,
  });

  refreshPage().catch((error) => {
    A.setNotice(els.headerNotice, error.message, "error");
  });
})();
