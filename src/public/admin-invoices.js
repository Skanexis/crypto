(() => {
  const A = window.AdminCommon;
  if (!A) return;

  const els = {
    headerNotice: document.getElementById("headerNotice"),
    statusFilter: document.getElementById("statusFilter"),
    searchInput: document.getElementById("searchInput"),
    searchBtn: document.getElementById("searchBtn"),
    exportInvoicesBtn: document.getElementById("exportInvoicesBtn"),
    invoiceTableBody: document.getElementById("invoiceTableBody"),
    listNotice: document.getElementById("listNotice"),
    selectedRef: document.getElementById("selectedRef"),
    detailSummary: document.getElementById("detailSummary"),
    paymentsList: document.getElementById("paymentsList"),
    invoiceEventsList: document.getElementById("invoiceEventsList"),
    markPaidCurrency: document.getElementById("markPaidCurrency"),
    markPaidTxHash: document.getElementById("markPaidTxHash"),
    markPaidAmount: document.getElementById("markPaidAmount"),
    markPaidBtn: document.getElementById("markPaidBtn"),
    detailNotice: document.getElementById("detailNotice"),
  };

  const state = {
    invoices: [],
    selectedInvoiceRef: null,
    selectedInvoice: null,
    selectedEvents: [],
  };

  function summaryItem(label, value, mono = false) {
    return `
      <div class="kv-item">
        <small>${A.escapeHtml(label)}</small>
        <strong class="${mono ? "mono" : ""}">${A.escapeHtml(value)}</strong>
      </div>
    `;
  }

  function renderTable() {
    if (!els.invoiceTableBody) return;
    if (!state.invoices.length) {
      els.invoiceTableBody.innerHTML =
        '<tr><td class="table-empty" colspan="7">Nessuna fattura trovata</td></tr>';
      return;
    }

    els.invoiceTableBody.innerHTML = state.invoices
      .map((invoice) => {
        const ref = invoice.shortId || invoice.id;
        const txHash = invoice.txHashPreview || "";
        const txShort = invoice.txShortIdPreview || "";
        const txCell = txHash ? `${A.shortText(txHash, 18)} ${txShort ? `(${txShort})` : ""}` : "-";
        const link = invoice.paymentUrl || "";
        return `
          <tr>
            <td>
              <div class="ref mono">${A.escapeHtml(ref)}</div>
              <small class="muted mono">${A.escapeHtml(A.shortText(invoice.id, 16))}</small>
            </td>
            <td><strong>${Number(invoice.amountUsd || 0).toFixed(2)} USD</strong></td>
            <td>${A.statusBadge(invoice.status)}</td>
            <td>${A.escapeHtml(A.formatDate(invoice.expiresAt))}</td>
            <td class="mono">${A.escapeHtml(invoice.telegramUserId || "-")}</td>
            <td>
              <div class="mono">${A.escapeHtml(txCell)}</div>
              <div class="inline-actions">
                <button class="btn btn-ghost" data-copy="${A.escapeHtml(txHash)}" ${txHash ? "" : "disabled"}>Copia</button>
              </div>
            </td>
            <td>
              <div class="inline-actions">
                <button class="btn btn-secondary" data-action="view" data-ref="${A.escapeHtml(ref)}">Dettagli</button>
                <button class="btn btn-ghost" data-copy="${A.escapeHtml(link)}" ${link ? "" : "disabled"}>Copia link</button>
                <button class="btn btn-ghost" data-open-url="${A.escapeHtml(link)}" ${link ? "" : "disabled"}>Apri</button>
                <button class="btn btn-danger" data-action="delete" data-ref="${A.escapeHtml(ref)}">Elimina</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderInvoiceDetails() {
    if (!state.selectedInvoice) {
      if (els.selectedRef) els.selectedRef.textContent = "Nessuna selezione";
      if (els.detailSummary) els.detailSummary.innerHTML = "";
      if (els.paymentsList) {
        els.paymentsList.innerHTML =
          '<div class="card-line"><small class="muted">Seleziona una fattura dalla tabella.</small></div>';
      }
      if (els.invoiceEventsList) {
        els.invoiceEventsList.innerHTML =
          '<div class="card-line"><small class="muted">Nessun evento disponibile.</small></div>';
      }
      if (els.markPaidCurrency) {
        els.markPaidCurrency.innerHTML = '<option value="">Seleziona valuta</option>';
      }
      return;
    }

    const invoice = state.selectedInvoice;
    const ref = invoice.shortId || invoice.id;
    if (els.selectedRef) els.selectedRef.textContent = ref;

    if (els.detailSummary) {
      els.detailSummary.innerHTML = [
        summaryItem("Rif fattura", ref, true),
        summaryItem("UUID fattura", invoice.id, true),
        summaryItem("Stato", A.localizeStatus(invoice.status)),
        summaryItem("Importo", `${Number(invoice.amountUsd || 0).toFixed(2)} USD`),
        summaryItem("Scadenza", A.formatDate(invoice.expiresAt)),
        summaryItem("Telegram", invoice.telegramUserId || "-", true),
        summaryItem("Link pagamento", invoice.paymentUrl || "-", true),
        summaryItem("Aggiornata", A.formatDate(invoice.updatedAt)),
      ].join("");
    }

    const payments = invoice.payments || [];
    if (els.paymentsList) {
      if (!payments.length) {
        els.paymentsList.innerHTML =
          '<div class="card-line"><small class="muted">Nessun pagamento collegato.</small></div>';
      } else {
        els.paymentsList.innerHTML = payments
          .map((payment) => {
            const txHash = payment.txHash || "-";
            const paidAmount =
              payment.paidAmountCrypto !== null && payment.paidAmountCrypto !== undefined
                ? `${payment.paidAmountCrypto} ${payment.currency}`
                : "-";
            return `
              <article class="tx-item">
                <div class="row">
                  <strong class="mono">${A.escapeHtml(payment.shortId || payment.id)}</strong>
                  ${A.statusBadge(payment.status)}
                </div>
                <div class="row">
                  <small>${A.escapeHtml(payment.currency)} ${A.escapeHtml(payment.network)}</small>
                  <small>${A.escapeHtml(A.formatDate(payment.updatedAt))}</small>
                </div>
                <div class="copy-line">
                  <div class="copy-field">
                    <small>Importo atteso</small>
                    <strong class="mono">${A.escapeHtml(String(payment.expectedAmountCrypto))} ${A.escapeHtml(
              payment.currency,
            )}</strong>
                  </div>
                  <div class="inline-actions">
                    <button class="btn btn-ghost" data-copy="${A.escapeHtml(String(payment.expectedAmountCrypto))}">Copia importo</button>
                  </div>
                </div>
                <div class="copy-line">
                  <div class="copy-field">
                    <small>Wallet</small>
                    <strong class="mono">${A.escapeHtml(payment.walletAddress)}</strong>
                  </div>
                  <div class="inline-actions">
                    <button class="btn btn-ghost" data-copy="${A.escapeHtml(payment.walletAddress)}">Copia wallet</button>
                    <button class="btn btn-secondary" data-open-url="${A.escapeHtml(payment.explorerAddressUrl || "")}" ${payment.explorerAddressUrl ? "" : "disabled"}>Explorer indirizzo</button>
                  </div>
                </div>
                <div class="copy-line">
                  <div class="copy-field">
                    <small>Hash tx</small>
                    <strong class="mono">${A.escapeHtml(txHash)}</strong>
                  </div>
                  <div class="inline-actions">
                    <button class="btn btn-ghost" data-copy="${A.escapeHtml(txHash)}" ${txHash === "-" ? "disabled" : ""}>Copia tx</button>
                    <button class="btn btn-secondary" data-open-url="${A.escapeHtml(payment.explorerTxUrl || "")}" ${payment.explorerTxUrl ? "" : "disabled"}>Explorer tx</button>
                    <a class="btn btn-ghost" href="/admin/transactions?tx=${encodeURIComponent(
                      payment.shortId || payment.id,
                    )}">Apri tx</a>
                  </div>
                </div>
                <div class="row">
                  <small>Pagato: ${A.escapeHtml(paidAmount)}</small>
                  <small>Conferme: ${A.escapeHtml(String(payment.confirmations || 0))}</small>
                </div>
              </article>
            `;
          })
          .join("");
      }
    }

    if (els.markPaidCurrency) {
      els.markPaidCurrency.innerHTML = payments.length
        ? payments
            .map((payment) => {
              return `<option value="${A.escapeHtml(payment.currency)}">${A.escapeHtml(payment.currency)}</option>`;
            })
            .join("")
        : '<option value="">Seleziona valuta</option>';
    }

    if (els.invoiceEventsList) {
      if (!state.selectedEvents.length) {
        els.invoiceEventsList.innerHTML =
          '<div class="card-line"><small class="muted">Nessun evento associato.</small></div>';
      } else {
        els.invoiceEventsList.innerHTML = state.selectedEvents
          .map((event) => {
            const entityRef = event.entityShortId || event.entityId || "-";
            const payload = event.payload ? JSON.stringify(event.payload) : "-";
            return `
              <article class="log-item">
                <div class="row">
                  <strong>${A.escapeHtml(event.action || "-")}</strong>
                  <small>${A.escapeHtml(A.formatDate(event.createdAt))}</small>
                </div>
                <div class="row">
                  <small>${A.escapeHtml(event.entityType || "-")} <span class="mono">${A.escapeHtml(
              entityRef,
            )}</span></small>
                </div>
                <div class="row">
                  <small>${A.escapeHtml(A.shortText(payload, 220))}</small>
                </div>
              </article>
            `;
          })
          .join("");
      }
    }
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
      invoice.txShortIdPreview || "",
      invoice.txHashPreview || "",
    ]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    A.downloadCsv(
      `fatture-${stamp}.csv`,
      [
        "invoice_short_id",
        "invoice_id",
        "amount_usd",
        "status",
        "telegram_user_id",
        "payment_url",
        "expires_at",
        "updated_at",
        "tx_short_id_preview",
        "tx_hash_preview",
      ],
      rows,
    );
  }

  async function loadMetrics() {
    const data = await A.request("/api/admin/dashboard?events_limit=1&tx_limit=1&risk_limit=1");
    A.renderMetrics(data.metrics);
  }

  async function loadInvoices() {
    const status = encodeURIComponent(String(els.statusFilter?.value || "all"));
    const search = encodeURIComponent(String(els.searchInput?.value || "").trim());
    const data = await A.request(`/api/admin/invoices?status=${status}&search=${search}&limit=180`);
    state.invoices = data.invoices || [];
    renderTable();
  }

  async function loadInvoiceDetails(invoiceRef) {
    const data = await A.request(`/api/admin/invoices/${encodeURIComponent(invoiceRef)}`);
    state.selectedInvoice = data.invoice || null;
    state.selectedEvents = data.events || [];
    state.selectedInvoiceRef = state.selectedInvoice?.shortId || state.selectedInvoice?.id || invoiceRef;
    renderInvoiceDetails();
  }

  async function refreshPage() {
    await Promise.all([loadMetrics(), loadInvoices()]);
    if (state.selectedInvoiceRef) {
      try {
        await loadInvoiceDetails(state.selectedInvoiceRef);
      } catch (error) {
        state.selectedInvoice = null;
        state.selectedEvents = [];
        state.selectedInvoiceRef = null;
        renderInvoiceDetails();
        throw error;
      }
    }
  }

  async function deleteOneInvoice(invoiceRef) {
    const confirmed = window.confirm(`Eliminare la fattura ${invoiceRef}?`);
    if (!confirmed) return;

    await A.request(`/api/admin/invoices/${encodeURIComponent(invoiceRef)}`, {
      method: "DELETE",
    });

    if (state.selectedInvoiceRef && state.selectedInvoiceRef === invoiceRef) {
      state.selectedInvoice = null;
      state.selectedEvents = [];
      state.selectedInvoiceRef = null;
      renderInvoiceDetails();
    }

    A.setNotice(els.listNotice, `Fattura ${invoiceRef} eliminata`, "warn");
    await refreshPage();
  }

  async function markPaid() {
    if (!state.selectedInvoiceRef) {
      throw new Error("Seleziona prima una fattura");
    }
    const currency = String(els.markPaidCurrency?.value || "").trim();
    if (!currency) {
      throw new Error("Seleziona valuta");
    }
    const txHash = String(els.markPaidTxHash?.value || "").trim() || null;
    const parsedAmount = A.parseAmount(els.markPaidAmount?.value);
    const paidAmount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : null;
    if (!txHash && paidAmount === null) {
      throw new Error("Inserisci hash tx o importo pagato.");
    }

    A.setBusy(els.markPaidBtn, true, "Aggiorno...");
    try {
      const data = await A.request(`/api/invoices/${encodeURIComponent(state.selectedInvoiceRef)}/mark-paid`, {
        method: "POST",
        body: JSON.stringify({
          currency,
          tx_hash: txHash,
          confirmations: 1,
          paid_amount_crypto: paidAmount,
        }),
      });

      if (data.changed) {
        A.setNotice(
          els.detailNotice,
          `Pagamento registrato\nFattura: ${data.invoice.shortId || data.invoice.id}\nStato: ${A.localizeStatus(
            data.invoice.status,
          )}`,
          "ok",
        );
      } else {
        A.setNotice(els.detailNotice, `Nessuna modifica\nMotivo: ${data.reason || "-"}`, "warn");
      }

      if (els.markPaidTxHash) els.markPaidTxHash.value = "";
      if (els.markPaidAmount) els.markPaidAmount.value = "";
      await refreshPage();
      await loadInvoiceDetails(state.selectedInvoiceRef);
    } finally {
      A.setBusy(els.markPaidBtn, false);
    }
  }

  els.searchBtn?.addEventListener("click", async () => {
    A.setBusy(els.searchBtn, true, "Cerco...");
    try {
      await loadInvoices();
      A.showToast("Filtro applicato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    } finally {
      A.setBusy(els.searchBtn, false);
    }
  });

  els.statusFilter?.addEventListener("change", async () => {
    try {
      await loadInvoices();
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.searchInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    try {
      await loadInvoices();
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.exportInvoicesBtn?.addEventListener("click", () => {
    try {
      exportInvoicesCsv();
      A.showToast("CSV fatture esportato");
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.markPaidBtn?.addEventListener("click", async () => {
    try {
      await markPaid();
    } catch (error) {
      A.setNotice(els.detailNotice, error.message, "error");
    }
  });

  els.invoiceTableBody?.addEventListener("click", async (event) => {
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

    const actionBtn = event.target.closest("button[data-action]");
    if (!actionBtn || actionBtn.disabled) return;
    const action = actionBtn.dataset.action;
    const ref = actionBtn.dataset.ref;
    try {
      if (action === "view") {
        await loadInvoiceDetails(ref);
      } else if (action === "delete") {
        await deleteOneInvoice(ref);
      }
    } catch (error) {
      A.setNotice(els.listNotice, error.message, "error");
    }
  });

  els.paymentsList?.addEventListener("click", async (event) => {
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
    page: "invoices",
    onRefresh: refreshPage,
    autoRefreshIntervalMs: 15000,
  });

  refreshPage()
    .then(async () => {
      const refFromQuery = A.readQuery("ref");
      if (refFromQuery) {
        try {
          await loadInvoiceDetails(refFromQuery);
        } catch (error) {
          A.setNotice(els.listNotice, error.message, "error");
        }
      }
    })
    .catch((error) => {
      A.setNotice(els.headerNotice, error.message, "error");
    });
})();
