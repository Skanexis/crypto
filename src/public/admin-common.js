(() => {
  const API_KEY_STORAGE_KEY = "enterprise_payments_admin_api_key";
  const AUTO_REFRESH_STORAGE_KEY = "enterprise_payments_admin_auto_refresh";
  const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 15000;

  const state = {
    autoRefreshEnabled: false,
    autoRefreshTimer: null,
    refreshInFlight: false,
    toastTimer: null,
    onRefresh: null,
    autoRefreshIntervalMs: DEFAULT_AUTO_REFRESH_INTERVAL_MS,
  };

  const els = {
    apiKey: document.getElementById("apiKey"),
    connectBtn: document.getElementById("connectBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    autoRefreshBtn: document.getElementById("autoRefreshBtn"),
    toast: document.getElementById("toast"),
    headerNotice: document.getElementById("headerNotice"),
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

  function statusBadge(status) {
    const normalized = String(status || "").toLowerCase();
    const safeClass = /^[a-z_]+$/.test(normalized) ? normalized : "pending";
    return `<span class="status-badge ${safeClass}">${escapeHtml(localizeStatus(normalized))}</span>`;
  }

  function riskBadge(severity) {
    const normalized = String(severity || "medium").toLowerCase();
    const map = {
      critical: "critico",
      high: "alto",
      medium: "medio",
    };
    const safeClass = ["critical", "high", "medium"].includes(normalized)
      ? normalized
      : "medium";
    return `<span class="risk-badge ${safeClass}">${escapeHtml(map[safeClass])}</span>`;
  }

  function formatDate(value) {
    if (!value) return "-";
    return new Date(value).toLocaleString("it-IT");
  }

  function parseAmount(value) {
    return Number(String(value || "").trim().replace(",", "."));
  }

  function shortText(value, len = 16) {
    const text = String(value || "");
    if (!text || text.length <= len) return text;
    return `${text.slice(0, len)}...`;
  }

  function setNotice(el, message, type = "") {
    if (!el) return;
    if (!message) {
      el.className = "notice hidden";
      el.textContent = "";
      return;
    }
    el.className = `notice ${type}`.trim();
    el.textContent = message;
  }

  function showToast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.classList.add("hidden");
    }, 1700);
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

  function getApiKey() {
    return String(els.apiKey?.value || "").trim();
  }

  function persistApiKey() {
    const key = getApiKey();
    if (!key) return;
    window.localStorage.setItem(API_KEY_STORAGE_KEY, key);
  }

  function restoreApiKey() {
    const saved = window.localStorage.getItem(API_KEY_STORAGE_KEY);
    if (!saved || !els.apiKey) return;
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

  function renderMetrics(metrics) {
    if (!metrics) return;
    const total = document.getElementById("mInvoicesTotal");
    const pending = document.getElementById("mInvoicesPending");
    const volume = document.getElementById("mVolumePaid");
    const txConfirmed = document.getElementById("mTxConfirmed");

    if (total) total.textContent = String(metrics.invoices?.total || 0);
    if (pending) pending.textContent = String(metrics.invoices?.pending || 0);
    if (volume) volume.textContent = `${Number(metrics.volume?.paidUsd || 0).toFixed(2)} USD`;
    if (txConfirmed) txConfirmed.textContent = String(metrics.payments?.confirmed || 0);
  }

  function setActiveNav(pageKey) {
    document.querySelectorAll("[data-nav]").forEach((link) => {
      link.classList.toggle("active", link.dataset.nav === pageKey);
    });
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

  async function runRefresh() {
    if (!state.onRefresh) return;
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    try {
      await state.onRefresh();
    } finally {
      state.refreshInFlight = false;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (!state.autoRefreshEnabled || !state.onRefresh || document.hidden) {
      return;
    }
    state.autoRefreshTimer = setInterval(async () => {
      try {
        await runRefresh();
      } catch (_error) {
        // retry next tick
      }
    }, state.autoRefreshIntervalMs);
  }

  function toggleAutoRefresh() {
    state.autoRefreshEnabled = !state.autoRefreshEnabled;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, state.autoRefreshEnabled ? "1" : "0");
    updateAutoRefreshButton();
    if (state.autoRefreshEnabled) {
      showToast("Aggiornamento automatico attivato");
      startAutoRefresh();
      return;
    }
    showToast("Aggiornamento automatico disattivato");
    stopAutoRefresh();
  }

  function readQuery(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function toCsvCell(value) {
    const text = String(value ?? "");
    if (!/[\",\n\r]/.test(text)) return text;
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

  async function copyText(value, successMessage = "Copiato") {
    const text = String(value || "").trim();
    if (!text || text === "-") return false;
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage);
      return true;
    } catch (_error) {
      showToast("Copia non riuscita");
      return false;
    }
  }

  function openUrl(url) {
    const value = String(url || "").trim();
    if (!value) return;
    window.open(value, "_blank", "noopener,noreferrer");
  }

  function initShell({ page, onRefresh, autoRefreshIntervalMs = DEFAULT_AUTO_REFRESH_INTERVAL_MS }) {
    state.onRefresh = onRefresh;
    state.autoRefreshIntervalMs = autoRefreshIntervalMs;

    setActiveNav(page);
    restoreApiKey();

    const savedAuto = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    state.autoRefreshEnabled = savedAuto === "1";
    updateAutoRefreshButton();

    if (els.apiKey) {
      els.apiKey.addEventListener("blur", persistApiKey);
      els.apiKey.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        try {
          persistApiKey();
          setNotice(els.headerNotice, "", "");
          await runRefresh();
          showToast("Connesso");
          startAutoRefresh();
        } catch (error) {
          setNotice(els.headerNotice, error.message, "error");
        }
      });
    }

    if (els.connectBtn) {
      els.connectBtn.addEventListener("click", async () => {
        setBusy(els.connectBtn, true, "Connessione...");
        try {
          persistApiKey();
          setNotice(els.headerNotice, "", "");
          await runRefresh();
          showToast("Connesso");
          startAutoRefresh();
        } catch (error) {
          setNotice(els.headerNotice, error.message, "error");
        } finally {
          setBusy(els.connectBtn, false);
        }
      });
    }

    if (els.refreshBtn) {
      els.refreshBtn.addEventListener("click", async () => {
        setBusy(els.refreshBtn, true, "Aggiorno...");
        try {
          await runRefresh();
          showToast("Aggiornato");
        } catch (error) {
          setNotice(els.headerNotice, error.message, "error");
        } finally {
          setBusy(els.refreshBtn, false);
        }
      });
    }

    if (els.autoRefreshBtn) {
      els.autoRefreshBtn.addEventListener("click", () => {
        toggleAutoRefresh();
      });
    }

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

    if (state.autoRefreshEnabled) {
      startAutoRefresh();
    }
  }

  window.AdminCommon = {
    request,
    escapeHtml,
    localizeStatus,
    statusBadge,
    riskBadge,
    formatDate,
    parseAmount,
    shortText,
    setNotice,
    showToast,
    setBusy,
    getApiKey,
    renderMetrics,
    initShell,
    readQuery,
    downloadCsv,
    copyText,
    openUrl,
  };
})();
