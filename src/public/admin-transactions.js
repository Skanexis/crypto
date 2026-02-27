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

  function toTs(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function txStatusRank(status) {
    const key = String(status || "").toLowerCase();
    if (key === "confirmed") return 5;
    if (key === "pending_confirmation") return 4;
    if (key === "awaiting_payment") return 3;
    if (key === "cancelled") return 2;
    if (key === "expired") return 1;
    return 0;
  }

  function normalizeTxHash(hash) {
    const text = String(hash || "").trim();
    if (!text || text === "-") return "";
    return text.toLowerCase();
  }

  function dedupeTransactions(items) {
    const map = new Map();
    for (const tx of items || []) {
      const normalizedHash = normalizeTxHash(tx.txHash);
      const key = normalizedHash
        ? `hash:${normalizedHash}`
        : tx.shortId
          ? `short:${String(tx.shortId).toUpperCase()}`
          : tx.id
            ? `id:${tx.id}`
            : `row:${Math.random().toString(16).slice(2)}`;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          ...tx,
          __duplicates: 1,
        });
        continue;
      }

      const existingScore =
        toTs(existing.updatedAt) * 100 + Number(existing.confirmations || 0) * 10 + txStatusRank(existing.status);
      const incomingScore =
        toTs(tx.updatedAt) * 100 + Number(tx.confirmations || 0) * 10 + txStatusRank(tx.status);

      const next = incomingScore >= existingScore ? { ...tx } : { ...existing };
      next.__duplicates = Number(existing.__duplicates || 1) + 1;
      map.set(key, next);
    }

    return [...map.values()].sort((a, b) => toTs(b.updatedAt) - toTs(a.updatedAt));
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
        const duplicateBadge =
          Number(tx.__duplicates || 1) > 1
            ? `<span class="pill pill-warn">Duplicata x${Number(tx.__duplicates)}</span>`
            : "";
        return `
          <article class="tx-item">
            <div class="row">
              <div class="inline-actions">
                <strong class="mono">${A.escapeHtml(txRef)}</strong>
                ${duplicateBadge}
              </div>
              <div class="inline-actions">
                ${A.statusBadge(tx.status)}
              </div>
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

  function actionLabel(action) {
    const key = String(action || "").toLowerCase();
    const map = {
      created: "Creazione",
      paid: "Pagamento confermato",
      confirmed: "Transazione confermata",
      expired: "Scadenza",
      deleted: "Eliminazione fattura",
      bulk_deleted: "Eliminazione massiva",
      run: "Esecuzione job",
      run_skipped: "Job saltato",
      verified: "Verifica",
    };
    return map[key] || key || "Evento";
  }

  function actionTone(action) {
    const key = String(action || "").toLowerCase();
    if (key === "created") return "created";
    if (key === "paid" || key === "confirmed") return "paid";
    if (key === "deleted" || key === "bulk_deleted") return "danger";
    if (key === "expired" || key === "cancelled" || key === "run_skipped") return "warn";
    if (key === "run" || key === "verified") return "system";
    return "neutral";
  }

  function entityLabel(entityType) {
    const key = String(entityType || "").toLowerCase();
    const map = {
      invoice: "Fattura",
      payment: "Transazione",
      system: "Sistema",
    };
    return map[key] || key || "Entita";
  }

  function pickFirst(values) {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return value;
    }
    return null;
  }

  function pickFromArray(value) {
    if (!Array.isArray(value)) return null;
    return pickFirst(value);
  }

  function formatAmount(value, currency) {
    if (value === null || value === undefined || value === "") return "n/d";
    const num = Number(value);
    if (!Number.isFinite(num)) return "n/d";
    const fixed = Math.abs(num) >= 1 ? num.toFixed(8).replace(/\.?0+$/, "") : String(num);
    const curr = String(currency || "").trim();
    return curr ? `${fixed} ${curr}` : fixed;
  }

  function parseEventFacts(event) {
    const payload =
      event && typeof event.payload === "object" && event.payload !== null ? event.payload : {};

    const entityRef = pickFirst([event.entityShortId, event.entityId, payload.entityRef, "n/d"]);
    const invoiceRef = pickFirst([
      event.invoiceShortId,
      payload.invoiceShortId,
      payload.primaryInvoiceShortId,
      pickFromArray(payload.invoiceShortIds),
      pickFromArray(payload.invoiceRefs),
      payload.invoiceRef,
      payload.invoiceId,
      "n/d",
    ]);
    const txRef = pickFirst([
      event.txShortId,
      payload.paymentShortId,
      payload.primaryPaymentShortId,
      pickFromArray(payload.paymentShortIds),
      pickFromArray(payload.paymentRefs),
      payload.txShortId,
      payload.txRef,
      event.txId,
      "n/d",
    ]);
    const txHash = pickFirst([
      event.txHash,
      payload.txHash,
      payload.primaryTxHash,
      pickFromArray(payload.txHashes),
      payload.tx_hash,
      payload.hash,
      "n/d",
    ]);
    const fromWallet = pickFirst([
      payload.from,
      payload.fromAddress,
      payload.sender,
      payload.walletFrom,
      "n/d",
    ]);
    const toWallet = pickFirst([
      payload.to,
      payload.walletAddress,
      payload.wallet_address,
      payload.address,
      payload.recipient,
      event.walletAddress,
      "n/d",
    ]);
    const currency = pickFirst([event.currency, payload.currency, payload.asset, ""]);
    const source = pickFirst([
      payload.source,
      payload.provider,
      payload.channel,
      payload.origin,
      "n/d",
    ]);
    const actor = pickFirst([
      payload.by,
      payload.createdByAdminId,
      payload.actor,
      payload.adminId,
      payload.telegramUserId,
      event.createdByAdminId,
      event.telegramUserId,
      "n/d",
    ]);
    const statusBefore = pickFirst([
      payload.statusBefore,
      payload.deletedStatusBefore,
      payload.previousStatus,
      "n/d",
    ]);
    const statusAfter = pickFirst([
      payload.status,
      payload.newStatus,
      event.txStatus,
      event.invoiceStatus,
      "n/d",
    ]);
    const amountUsd = pickFirst([payload.amountUsd, event.amountUsd, null]);
    const amountCrypto = pickFirst([
      payload.paidAmountCrypto,
      event.paidAmountCrypto,
      payload.expectedAmountCrypto,
      event.expectedAmountCrypto,
      null,
    ]);
    const confirmations = pickFirst([
      payload.confirmations,
      event.confirmations,
      null,
    ]);

    return {
      id: event.id,
      action: actionLabel(event.action),
      actionRaw: event.action || "n/d",
      actionTone: actionTone(event.action),
      when: A.formatDate(event.createdAt),
      entityType: entityLabel(event.entityType),
      entityRef: String(entityRef || "n/d"),
      invoiceRef: String(invoiceRef || "n/d"),
      txRef: String(txRef || "n/d"),
      txHash: String(txHash || "n/d"),
      fromWallet: String(fromWallet || "n/d"),
      toWallet: String(toWallet || "n/d"),
      source: String(source || "n/d"),
      actor: String(actor || "n/d"),
      statusBefore: A.localizeStatus(statusBefore),
      statusAfter: A.localizeStatus(statusAfter),
      amountUsd:
        amountUsd !== null && amountUsd !== undefined ? `${Number(amountUsd).toFixed(2)} USD` : "n/d",
      amountCrypto: formatAmount(amountCrypto, currency),
      currency: currency || "n/d",
      confirmations:
        confirmations !== null && confirmations !== undefined && Number.isFinite(Number(confirmations))
          ? String(Number(confirmations))
          : "n/d",
      payload,
    };
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
        const facts = parseEventFacts(event);
        const payloadJson =
          facts.payload && Object.keys(facts.payload).length > 0
            ? JSON.stringify(facts.payload, null, 2)
            : "Nessun payload";
        return `
          <details class="log-item log-expand">
            <summary>
                <div class="log-summary-main">
                <div class="inline-actions">
                  <span class="log-action-chip ${A.escapeHtml(facts.actionTone)}">${A.escapeHtml(
          facts.action,
        )}</span>
                  <strong>${A.escapeHtml(facts.entityType)}</strong>
                </div>
                <small>#${A.escapeHtml(String(facts.id))}</small>
              </div>
              <div class="log-summary-meta">
                <span>${A.escapeHtml(facts.entityType)}: <span class="mono">${A.escapeHtml(
          facts.entityRef,
        )}</span></span>
                <span>Inv: <span class="mono">${A.escapeHtml(facts.invoiceRef)}</span></span>
                <span>Tx: <span class="mono">${A.escapeHtml(facts.txRef)}</span></span>
                <span>${A.escapeHtml(facts.when)}</span>
              </div>
            </summary>
            <div class="log-grid">
              <div class="log-kv"><small>Azione tecnica</small><strong>${A.escapeHtml(
                facts.actionRaw,
              )}</strong></div>
              <div class="log-kv"><small>Entita</small><strong>${A.escapeHtml(
                facts.entityType,
              )}</strong></div>
              <div class="log-kv"><small>Rif entita</small><strong class="mono">${A.escapeHtml(
                facts.entityRef,
              )}</strong></div>
              <div class="log-kv"><small>Fattura</small><strong class="mono">${A.escapeHtml(
                facts.invoiceRef,
              )}</strong></div>
              <div class="log-kv"><small>Transazione</small><strong class="mono">${A.escapeHtml(
                facts.txRef,
              )}</strong></div>
              <div class="log-kv"><small>Hash tx</small><strong class="mono">${A.escapeHtml(
                facts.txHash,
              )}</strong></div>
              <div class="log-kv"><small>Da</small><strong class="mono">${A.escapeHtml(
                facts.fromWallet,
              )}</strong></div>
              <div class="log-kv"><small>A</small><strong class="mono">${A.escapeHtml(
                facts.toWallet,
              )}</strong></div>
              <div class="log-kv"><small>Importo USD</small><strong>${A.escapeHtml(
                facts.amountUsd,
              )}</strong></div>
              <div class="log-kv"><small>Importo crypto</small><strong>${A.escapeHtml(
                facts.amountCrypto,
              )}</strong></div>
              <div class="log-kv"><small>Conferme</small><strong>${A.escapeHtml(
                facts.confirmations,
              )}</strong></div>
              <div class="log-kv"><small>Valuta</small><strong>${A.escapeHtml(
                facts.currency,
              )}</strong></div>
              <div class="log-kv"><small>Stato prima</small><strong>${A.escapeHtml(
                facts.statusBefore,
              )}</strong></div>
              <div class="log-kv"><small>Stato dopo</small><strong>${A.escapeHtml(
                facts.statusAfter,
              )}</strong></div>
              <div class="log-kv"><small>Fonte</small><strong>${A.escapeHtml(
                facts.source,
              )}</strong></div>
              <div class="log-kv"><small>Operatore</small><strong>${A.escapeHtml(
                facts.actor,
              )}</strong></div>
            </div>
            <div class="log-raw">
              <small>Payload grezzo</small>
              <pre>${A.escapeHtml(payloadJson)}</pre>
            </div>
          </details>
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
    state.transactions = dedupeTransactions(data.transactions || []);
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
      state.transactions = dedupeTransactions(txFromDashboard.recentTransactions || state.transactions);
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
