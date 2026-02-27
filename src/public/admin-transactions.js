(() => {
  const A = window.AdminCommon;
  if (!A) return;

  const els = {
    headerNotice: document.getElementById("headerNotice"),
    listNotice: document.getElementById("listNotice"),
    transactionsList: document.getElementById("transactionsList"),
    txSearchInput: document.getElementById("txSearchInput"),
    txStatusFilter: document.getElementById("txStatusFilter"),
    txSearchBtn: document.getElementById("txSearchBtn"),
    txResetBtn: document.getElementById("txResetBtn"),
    exportTxBtn: document.getElementById("exportTxBtn"),
    txRefInput: document.getElementById("txRefInput"),
    txLookupBtn: document.getElementById("txLookupBtn"),
    txDetailCard: document.getElementById("txDetailCard"),
    selectedTxRef: document.getElementById("selectedTxRef"),
    eventsList: document.getElementById("eventsList"),
  };

  const state = {
    transactions: [],
    events: [],
    selectedTxRef: null,
    selectedTx: null,
  };

  function hasFilters() {
    const search = String(els.txSearchInput?.value || "").trim();
    const status = String(els.txStatusFilter?.value || "all");
    return Boolean(search) || status !== "all";
  }

  function renderTransactions() {
    if (!els.transactionsList) return;
    if (!state.transactions.length) {
      els.transactionsList.innerHTML =
        '<div class="card-line"><small class="muted">Nessuna transazione disponibile.</small></div>';
      return;
    }

    els.transactionsList.innerHTML = state.transactions
      .map((tx) => {
        const txRef = tx.shortId || tx.id;
        const invoiceRef = tx.invoiceShortId || tx.invoiceId;
        const hash = tx.txHash || "-";
        const paid =
          tx.paidAmountCrypto !== null && tx.paidAmountCrypto !== undefined
            ? `${tx.paidAmountCrypto} ${tx.currency}`
            : "-";
        return `
          <article class="tx-item">
            <div class="row">
              <strong class="mono">${A.escapeHtml(txRef)}</strong>
              ${A.statusBadge(tx.status)}
            </div>
            <div class="row">
              <small>${A.escapeHtml(tx.currency)} ${A.escapeHtml(tx.network)}</small>
              <small>${A.escapeHtml(A.formatDate(tx.updatedAt))}</small>
            </div>
            <div class="row">
              <small>Fattura: <span class="mono">${A.escapeHtml(invoiceRef)}</span></small>
              <small>Conferme: ${A.escapeHtml(String(tx.confirmations || 0))}</small>
            </div>
            <div class="row">
              <small>Atteso: ${A.escapeHtml(String(tx.expectedAmountCrypto))} ${A.escapeHtml(tx.currency)}</small>
              <small>Pagato: ${A.escapeHtml(paid)}</small>
            </div>
            <div class="copy-line">
              <div class="copy-field">
                <small>Hash tx</small>
                <strong class="mono">${A.escapeHtml(hash)}</strong>
              </div>
              <div class="inline-actions">
                <button class="btn btn-ghost" data-copy="${A.escapeHtml(hash)}" ${hash === "-" ? "disabled" : ""}>Copia tx</button>
                <button class="btn btn-secondary" data-open-url="${A.escapeHtml(tx.explorerTxUrl || "")}" ${tx.explorerTxUrl ? "" : "disabled"}>Explorer tx</button>
                <button class="btn btn-secondary" data-tx-ref="${A.escapeHtml(txRef)}">Dettaglio</button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderEvents() {
    if (!els.eventsList) return;
    if (!state.events.length) {
      els.eventsList.innerHTML =
        '<div class="card-line"><small class="muted">Nessun evento disponibile.</small></div>';
      return;
    }

    els.eventsList.innerHTML = state.events
      .map((event) => {
        const payloadPreview = event.payload ? JSON.stringify(event.payload) : "-";
        const entity = event.entityShortId || event.entityId || "-";
        return `
          <article class="log-item">
            <div class="row">
              <strong>${A.escapeHtml(event.action || "-")}</strong>
              <small>${A.escapeHtml(A.formatDate(event.createdAt))}</small>
            </div>
            <div class="row">
              <small>${A.escapeHtml(event.entityType || "-")} <span class="mono">${A.escapeHtml(entity)}</span></small>
            </div>
            <div class="row">
              <small>${A.escapeHtml(A.shortText(payloadPreview, 180))}</small>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderTxDetail() {
    if (!els.txDetailCard || !els.selectedTxRef) return;
    if (!state.selectedTx) {
      els.selectedTxRef.textContent = "Nessuna selezione";
      els.txDetailCard.innerHTML =
        '<div class="card-line"><small class="muted">Apri una transazione per vedere i dettagli.</small></div>';
      return;
    }

    const tx = state.selectedTx;
    const txRef = tx.shortId || tx.id;
    const invoiceRef = tx.invoiceShortId || tx.invoiceId;
    const hash = tx.txHash || "-";
    const paid =
      tx.paidAmountCrypto !== null && tx.paidAmountCrypto !== undefined
        ? `${tx.paidAmountCrypto} ${tx.currency}`
        : "-";
    els.selectedTxRef.textContent = txRef;
    els.txDetailCard.innerHTML = `
      <article class="tx-item">
        <div class="row">
          <strong class="mono">${A.escapeHtml(txRef)}</strong>
          ${A.statusBadge(tx.status)}
        </div>
        <div class="mini-stat-grid">
          <article class="mini-stat">
            <small>Fattura</small>
            <strong class="mono">${A.escapeHtml(invoiceRef)}</strong>
          </article>
          <article class="mini-stat">
            <small>Importo atteso</small>
            <strong>${A.escapeHtml(String(tx.expectedAmountCrypto))} ${A.escapeHtml(tx.currency)}</strong>
          </article>
          <article class="mini-stat">
            <small>Importo pagato</small>
            <strong>${A.escapeHtml(paid)}</strong>
          </article>
          <article class="mini-stat">
            <small>Conferme</small>
            <strong>${A.escapeHtml(String(tx.confirmations || 0))}</strong>
          </article>
          <article class="mini-stat">
            <small>Rete</small>
            <strong>${A.escapeHtml(tx.network || "-")}</strong>
          </article>
          <article class="mini-stat">
            <small>Aggiornata</small>
            <strong>${A.escapeHtml(A.formatDate(tx.updatedAt))}</strong>
          </article>
        </div>
        <div class="copy-line">
          <div class="copy-field">
            <small>Wallet destinazione</small>
            <strong class="mono">${A.escapeHtml(tx.walletAddress || "-")}</strong>
          </div>
          <div class="inline-actions">
            <button class="btn btn-ghost" data-copy="${A.escapeHtml(tx.walletAddress || "")}" ${tx.walletAddress ? "" : "disabled"}>Copia wallet</button>
            <button class="btn btn-secondary" data-open-url="${A.escapeHtml(tx.explorerAddressUrl || "")}" ${tx.explorerAddressUrl ? "" : "disabled"}>Explorer indirizzo</button>
          </div>
        </div>
        <div class="copy-line">
          <div class="copy-field">
            <small>Hash transazione</small>
            <strong class="mono">${A.escapeHtml(hash)}</strong>
          </div>
          <div class="inline-actions">
            <button class="btn btn-ghost" data-copy="${A.escapeHtml(hash)}" ${hash === "-" ? "disabled" : ""}>Copia hash</button>
            <button class="btn btn-secondary" data-open-url="${A.escapeHtml(tx.explorerTxUrl || "")}" ${tx.explorerTxUrl ? "" : "disabled"}>Explorer tx</button>
            <a class="btn btn-primary" href="/admin/invoices?ref=${encodeURIComponent(invoiceRef)}">Apri fattura</a>
          </div>
        </div>
      </article>
    `;
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
    A.downloadCsv(
      `transazioni-${stamp}.csv`,
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

  async function loadMetrics() {
    const data = await A.request("/api/admin/dashboard?events_limit=1&tx_limit=1&risk_limit=1");
    A.renderMetrics(data.metrics);
  }

  async function loadTransactions() {
    const search = encodeURIComponent(String(els.txSearchInput?.value || "").trim());
    const status = encodeURIComponent(String(els.txStatusFilter?.value || "all"));
    const data = await A.request(`/api/admin/transactions?limit=200&search=${search}&status=${status}`);
    state.transactions = data.transactions || [];
    renderTransactions();
  }

  async function loadEvents() {
    const data = await A.request("/api/admin/events?limit=120");
    state.events = data.events || [];
    renderEvents();
  }

  async function loadTransactionDetail(txRef, syncInput = true) {
    const normalizedRef = String(txRef || "").trim();
    if (!normalizedRef) {
      throw new Error("Inserisci riferimento TX o hash tx");
    }
    const data = await A.request(`/api/admin/transactions/${encodeURIComponent(normalizedRef)}`);
    state.selectedTx = data.transaction || null;
    state.selectedTxRef = state.selectedTx?.shortId || state.selectedTx?.id || normalizedRef;
    if (syncInput && els.txRefInput) {
      els.txRefInput.value = state.selectedTxRef;
    }
    renderTxDetail();
  }

  async function refreshPage() {
    await Promise.all([loadMetrics(), loadTransactions(), loadEvents()]);
    if (state.selectedTxRef) {
      await loadTransactionDetail(state.selectedTxRef, false);
    } else if (!hasFilters()) {
      const txFromDashboard = await A.request("/api/admin/dashboard?events_limit=8&tx_limit=20&risk_limit=1");
      state.transactions = txFromDashboard.recentTransactions || state.transactions;
      renderTransactions();
    }
  }

  els.txSearchBtn?.addEventListener("click", async () => {
    A.setBusy(els.txSearchBtn, true, "Filtro...");
    try {
      await loadTransactions();
      A.showToast("Filtro transazioni applicato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    } finally {
      A.setBusy(els.txSearchBtn, false);
    }
  });

  els.txStatusFilter?.addEventListener("change", async () => {
    try {
      await loadTransactions();
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.txSearchInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    try {
      await loadTransactions();
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.txResetBtn?.addEventListener("click", async () => {
    if (els.txSearchInput) els.txSearchInput.value = "";
    if (els.txStatusFilter) els.txStatusFilter.value = "all";
    try {
      await refreshPage();
      A.showToast("Filtri transazioni azzerati");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.txLookupBtn?.addEventListener("click", async () => {
    A.setBusy(els.txLookupBtn, true, "Carico...");
    try {
      await loadTransactionDetail(els.txRefInput?.value);
      A.showToast("Dettaglio tx caricato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    } finally {
      A.setBusy(els.txLookupBtn, false);
    }
  });

  els.txRefInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    try {
      await loadTransactionDetail(els.txRefInput?.value);
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.exportTxBtn?.addEventListener("click", () => {
    try {
      exportTransactionsCsv();
      A.showToast("CSV transazioni esportato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.transactionsList?.addEventListener("click", async (event) => {
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
    const detailBtn = event.target.closest("button[data-tx-ref]");
    if (detailBtn && !detailBtn.disabled) {
      try {
        await loadTransactionDetail(detailBtn.dataset.txRef);
      } catch (error) {
        A.setNotice(els.listNotice, error.message, "error");
      }
    }
  });

  els.txDetailCard?.addEventListener("click", async (event) => {
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

  A.initShell({
    page: "transactions",
    onRefresh: refreshPage,
    autoRefreshIntervalMs: 15000,
  });

  renderTxDetail();

  refreshPage()
    .then(async () => {
      const txFromQuery = A.readQuery("tx");
      if (txFromQuery) {
        try {
          await loadTransactionDetail(txFromQuery);
        } catch (error) {
          A.setNotice(els.listNotice, error.message, "error");
        }
      }
    })
    .catch((error) => {
      A.setNotice(els.headerNotice, error.message, "error");
    });
})();
