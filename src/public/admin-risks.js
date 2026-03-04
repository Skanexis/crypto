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
    riskHistoryList: document.getElementById("riskHistoryList"),
    riskSeverityFilter: document.getElementById("riskSeverityFilter"),
    riskStateFilter: document.getElementById("riskStateFilter"),
    riskCodeFilter: document.getElementById("riskCodeFilter"),
    riskSourceFilter: document.getElementById("riskSourceFilter"),
    riskApplyFiltersBtn: document.getElementById("riskApplyFiltersBtn"),
    riskResetFiltersBtn: document.getElementById("riskResetFiltersBtn"),
    riskExportCsvBtn: document.getElementById("riskExportCsvBtn"),
    riskEventsList: document.getElementById("riskEventsList"),
  };

  const state = {
    riskMonitor: null,
    riskHistory: [],
    riskAlertHistory: [],
  };

  function currentFilters() {
    return {
      severity: String(els.riskSeverityFilter?.value || "all"),
      state: String(els.riskStateFilter?.value || "all"),
      code: String(els.riskCodeFilter?.value || "").trim(),
      source: String(els.riskSourceFilter?.value || "").trim(),
    };
  }

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

  function historyTone(entry) {
    const stateKey = String(entry?.state || "").toLowerCase();
    if (stateKey === "active") {
      const summary = entry?.summary || {};
      if (Number(summary.critical || 0) > 0) return "danger";
      if (Number(summary.high || 0) > 0) return "warn";
      return "system";
    }
    return "paid";
  }

  function historyLabel(entry) {
    const stateKey = String(entry?.state || "").toLowerCase();
    return stateKey === "active" ? "Snapshot rischi" : "Rischi rientrati";
  }

  function renderRiskHistory() {
    if (!els.riskHistoryList) return;
    if (!state.riskHistory.length) {
      els.riskHistoryList.innerHTML =
        '<div class="card-line"><small class="muted">Nessuno storico rischio salvato.</small></div>';
      return;
    }

    els.riskHistoryList.innerHTML = state.riskHistory
      .map((entry) => {
        const summary = entry.summary || {};
        const alerts = Array.isArray(entry.alerts) ? entry.alerts : [];
        const alertBlocks = alerts.length
          ? alerts
              .map((alert) => {
                const invoiceRef = alert.invoiceRef || "";
                const txRef = alert.txRef || "";
                const invoiceAction = invoiceRef
                  ? `<a class="btn btn-secondary" href="/admin/invoices?ref=${encodeURIComponent(invoiceRef)}">Fattura</a>`
                  : "";
                const txAction = txRef
                  ? `<a class="btn btn-secondary" href="/admin/transactions?tx=${encodeURIComponent(txRef)}">Tx</a>`
                  : "";
                return `
                  <article class="tx-item">
                    <div class="row">
                      <strong>${A.escapeHtml(alert.title || alert.code || "Alert")}</strong>
                      ${A.riskBadge(alert.severity)}
                    </div>
                    <div class="row">
                      <small class="mono">${A.escapeHtml(alert.code || "-")}</small>
                      <small>${A.escapeHtml(A.formatDate(alert.updatedAt))}</small>
                    </div>
                    <div class="row">
                      <small>${A.escapeHtml(alert.description || "-")}</small>
                    </div>
                    <div class="inline-actions">
                      ${invoiceAction}
                      ${txAction}
                    </div>
                  </article>
                `;
              })
              .join("")
          : '<div class="card-line"><small class="muted">Nessun alert attivo nel snapshot.</small></div>';

        return `
          <details class="log-item log-expand">
            <summary>
              <div class="log-summary-main">
                <div class="inline-actions">
                  <span class="log-action-chip ${A.escapeHtml(historyTone(entry))}">${A.escapeHtml(
          historyLabel(entry),
        )}</span>
                  <strong>${A.escapeHtml(String(entry.source || "system"))}</strong>
                </div>
                <small>#${A.escapeHtml(String(entry.id || "-"))}</small>
              </div>
              <div class="log-summary-meta">
                <span>${A.escapeHtml(A.formatDate(entry.createdAt))}</span>
                <span>Totale: ${A.escapeHtml(String(Number(summary.total || 0)))}</span>
                <span>Critici: ${A.escapeHtml(String(Number(summary.critical || 0)))}</span>
                <span>Alti: ${A.escapeHtml(String(Number(summary.high || 0)))}</span>
                <span>Medi: ${A.escapeHtml(String(Number(summary.medium || 0)))}</span>
              </div>
            </summary>
            <div class="log-grid">
              <div class="log-kv"><small>Stato</small><strong>${A.escapeHtml(
                String(entry.state || "-"),
              )}</strong></div>
              <div class="log-kv"><small>Generato il</small><strong>${A.escapeHtml(
                A.formatDate(entry.generatedAt),
              )}</strong></div>
              <div class="log-kv"><small>Visualizzati</small><strong>${A.escapeHtml(
                String(Number(summary.displayed || 0)),
              )}</strong></div>
              <div class="log-kv"><small>Codici</small><strong>${A.escapeHtml(
                Object.keys(summary.byCode || {}).join(", ") || "n/d",
              )}</strong></div>
            </div>
            <div class="log-raw">
              <small>Alert salvati</small>
              <div class="tx-list">${alertBlocks}</div>
            </div>
          </details>
        `;
      })
      .join("");
  }

  function eventTone(entry) {
    const stateKey = String(entry?.state || "").toLowerCase();
    if (stateKey === "resolved") {
      return "paid";
    }
    const severity = String(entry?.severity || "").toLowerCase();
    if (severity === "critical") return "danger";
    if (severity === "high" || severity === "medium") return "warn";
    return "system";
  }

  function eventLabel(entry) {
    const stateKey = String(entry?.state || "").toLowerCase();
    return stateKey === "resolved" ? "Rischio chiuso" : "Rischio aperto";
  }

  function renderRiskAlertEvents() {
    if (!els.riskEventsList) return;
    if (!state.riskAlertHistory.length) {
      els.riskEventsList.innerHTML =
        '<div class="card-line"><small class="muted">Nessun evento rischio per i filtri correnti.</small></div>';
      return;
    }

    els.riskEventsList.innerHTML = state.riskAlertHistory
      .map((entry) => {
        const detailsJson =
          entry.details && Object.keys(entry.details).length > 0
            ? JSON.stringify(entry.details, null, 2)
            : "Nessun dettaglio";
        const invoiceAction = entry.invoiceRef
          ? `<a class="btn btn-secondary" href="/admin/invoices?ref=${encodeURIComponent(
              entry.invoiceRef,
            )}">Apri fattura</a>`
          : "";
        const txAction = entry.txRef
          ? `<a class="btn btn-secondary" href="/admin/transactions?tx=${encodeURIComponent(
              entry.txRef,
            )}">Apri tx</a>`
          : "";

        return `
          <details class="log-item log-expand">
            <summary>
              <div class="log-summary-main">
                <div class="inline-actions">
                  <span class="log-action-chip ${A.escapeHtml(eventTone(entry))}">${A.escapeHtml(
          eventLabel(entry),
        )}</span>
                  <strong>${A.escapeHtml(entry.title || entry.code || "Rischio")}</strong>
                  ${A.riskBadge(entry.severity)}
                </div>
                <small>#${A.escapeHtml(String(entry.id || "-"))}</small>
              </div>
              <div class="log-summary-meta">
                <span>${A.escapeHtml(A.formatDate(entry.createdAt))}</span>
                <span>Codice: <span class="mono">${A.escapeHtml(entry.code || "-")}</span></span>
                <span>Source: <span class="mono">${A.escapeHtml(entry.source || "-")}</span></span>
                <span>Stato: ${A.escapeHtml(entry.state || "-")}</span>
              </div>
            </summary>
            <div class="log-grid">
              <div class="log-kv"><small>Entita</small><strong>${A.escapeHtml(
                entry.entityType || "risk",
              )}</strong></div>
              <div class="log-kv"><small>Rif entita</small><strong class="mono">${A.escapeHtml(
                entry.entityRef || "-",
              )}</strong></div>
              <div class="log-kv"><small>Fattura</small><strong class="mono">${A.escapeHtml(
                entry.invoiceRef || "-",
              )}</strong></div>
              <div class="log-kv"><small>Tx</small><strong class="mono">${A.escapeHtml(
                entry.txRef || "-",
              )}</strong></div>
              <div class="log-kv"><small>Hash tx</small><strong class="mono">${A.escapeHtml(
                entry.txHash || "-",
              )}</strong></div>
              <div class="log-kv"><small>Aggiornato alert</small><strong>${A.escapeHtml(
                A.formatDate(entry.updatedAt),
              )}</strong></div>
            </div>
            <div class="row">
              <small>${A.escapeHtml(entry.description || "-")}</small>
            </div>
            <div class="inline-actions" style="margin-top: 8px">
              ${invoiceAction}
              ${txAction}
              <button class="btn btn-ghost" data-copy="${A.escapeHtml(entry.txHash || "")}" ${
                entry.txHash ? "" : "disabled"
              }>Copia hash</button>
            </div>
            <div class="log-raw">
              <small>Dettagli</small>
              <pre>${A.escapeHtml(detailsJson)}</pre>
            </div>
          </details>
        `;
      })
      .join("");
  }

  function exportRiskEventsCsv() {
    if (!state.riskAlertHistory.length) {
      throw new Error("Nessun evento rischio da esportare");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    A.downloadCsv(
      `risk-events-${stamp}.csv`,
      [
        "event_id",
        "created_at",
        "state",
        "severity",
        "code",
        "title",
        "description",
        "source",
        "entity_type",
        "entity_ref",
        "invoice_ref",
        "tx_ref",
        "tx_hash",
        "updated_at",
        "details_json",
        "fingerprint",
      ],
      state.riskAlertHistory.map((entry) => [
        entry.id || "",
        entry.createdAt || "",
        entry.state || "",
        entry.severity || "",
        entry.code || "",
        entry.title || "",
        entry.description || "",
        entry.source || "",
        entry.entityType || "",
        entry.entityRef || "",
        entry.invoiceRef || "",
        entry.txRef || "",
        entry.txHash || "",
        entry.updatedAt || "",
        JSON.stringify(entry.details || {}),
        entry.fingerprint || "",
      ]),
    );
  }

  async function loadMetrics() {
    const data = await A.request("/api/admin/dashboard?events_limit=1&tx_limit=1&risk_limit=1");
    A.renderMetrics(data.metrics);
  }

  async function loadRiskMonitor({ persist = false } = {}) {
    const filters = currentFilters();
    const params = new URLSearchParams({
      limit: "220",
      history_limit: "40",
      alert_limit: "180",
      severity: filters.severity,
      state: filters.state,
    });
    if (filters.code) {
      params.set("code", filters.code);
    }
    if (filters.source) {
      params.set("alert_source", filters.source);
    }
    if (persist) {
      params.set("persist", "1");
      params.set("source", "admin-risks-page");
    }
    const data = await A.request(`/api/admin/risk-monitor?${params.toString()}`);
    state.riskMonitor = data.riskMonitor || null;
    state.riskHistory = data.history || [];
    state.riskAlertHistory = data.alertHistory || [];
    renderRiskMonitor();
    renderRiskHistory();
    renderRiskAlertEvents();
  }

  async function refreshPage(options = {}) {
    await Promise.all([loadMetrics(), loadRiskMonitor(options)]);
  }

  els.riskRefreshBtn?.addEventListener("click", async () => {
    A.setBusy(els.riskRefreshBtn, true, "Aggiorno...");
    try {
      await refreshPage({ persist: true });
      A.showToast("Monitor rischi aggiornato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    } finally {
      A.setBusy(els.riskRefreshBtn, false);
    }
  });

  els.riskApplyFiltersBtn?.addEventListener("click", async () => {
    A.setBusy(els.riskApplyFiltersBtn, true, "Filtro...");
    try {
      await refreshPage({ persist: false });
      A.showToast("Filtri rischio applicati");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    } finally {
      A.setBusy(els.riskApplyFiltersBtn, false);
    }
  });

  els.riskResetFiltersBtn?.addEventListener("click", async () => {
    if (els.riskSeverityFilter) els.riskSeverityFilter.value = "all";
    if (els.riskStateFilter) els.riskStateFilter.value = "all";
    if (els.riskCodeFilter) els.riskCodeFilter.value = "";
    if (els.riskSourceFilter) els.riskSourceFilter.value = "";
    try {
      await refreshPage({ persist: false });
      A.showToast("Filtri rischio azzerati");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.riskExportCsvBtn?.addEventListener("click", () => {
    try {
      exportRiskEventsCsv();
      A.showToast("CSV rischi esportato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.riskAlerts?.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("button[data-copy]");
    if (copyBtn && !copyBtn.disabled) {
      await A.copyText(copyBtn.dataset.copy);
    }
  });

  els.riskEventsList?.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("button[data-copy]");
    if (copyBtn && !copyBtn.disabled) {
      await A.copyText(copyBtn.dataset.copy);
    }
  });

  A.initShell({
    page: "risks",
    onRefresh: () => refreshPage({ persist: false }),
    autoRefreshIntervalMs: 20000,
  });

  refreshPage({ persist: true }).catch((error) => {
    A.setNotice(els.headerNotice, error.message, "error");
  });
})();
