const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const tempDbPath = path.join(process.cwd(), "data", `full-check-${runId}.db`);

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = tempDbPath;
process.env.APP_BASE_URL = "https://payments.example.test";
process.env.ADMIN_API_KEY = "full-check-admin-key";
process.env.PAYMENT_WEBHOOK_HMAC_SECRET = "full-check-webhook-secret";
process.env.USDT_WALLET_ADDRESS = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
process.env.BTC_WALLET_ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
process.env.ETH_WALLET_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
process.env.USDT_NETWORK = "TRC20";
process.env.BTC_NETWORK = "BTC";
process.env.ETH_NETWORK = "ERC20";
process.env.AUTO_VERIFY_PAYMENTS = "false";
process.env.PROVIDER_MAX_RETRIES = "1";
process.env.PROVIDER_REQUEST_TIMEOUT_MS = "5000";
process.env.STATIC_RATES_USD_JSON = JSON.stringify({
  USDT: 1,
  BTC: 65000,
  ETH: 3200,
});

const app = require("../src/app");
const { db } = require("../src/db");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}. actual=${actual} expected=${expected}`);
  }
}

function logStep(index, message) {
  console.log(`[${String(index).padStart(2, "0")}] ${message}`);
}

function hmacSignature(bodyText) {
  const digest = crypto
    .createHmac("sha256", process.env.PAYMENT_WEBHOOK_HMAC_SECRET)
    .update(bodyText)
    .digest("hex");
  return `sha256=${digest}`;
}

async function run() {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on("error", reject);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(pathname, options = {}) {
    const method = options.method || "GET";
    const headers = { ...(options.headers || {}) };
    let bodyText = undefined;
    if (options.body !== undefined) {
      bodyText = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
    }

    if (options.auth === true) {
      headers["x-api-key"] = process.env.ADMIN_API_KEY;
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: bodyText,
    });

    const rawText = await response.text();
    let json = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch (_error) {
      json = null;
    }

    return {
      status: response.status,
      headers: response.headers,
      text: rawText,
      json,
    };
  }

  try {
    let step = 1;

    logStep(step++, "Health endpoint");
    {
      const res = await request("/api/health");
      assertEq(res.status, 200, "health status");
      assert(res.json && res.json.ok === true, "health payload missing ok=true");
    }

    logStep(step++, "Rates endpoint");
    {
      const res = await request("/api/rates");
      assertEq(res.status, 200, "rates status");
      assert(res.json && res.json.ratesUsd, "rates payload missing ratesUsd");
      assert(Number(res.json.ratesUsd.USDT) > 0, "USDT rate invalid");
      assert(Number(res.json.ratesUsd.BTC) > 0, "BTC rate invalid");
      assert(Number(res.json.ratesUsd.ETH) > 0, "ETH rate invalid");
    }

    logStep(step++, "Static and admin pages");
    {
      const dashboardHtml = await request("/admin/dashboard");
      const invoicesHtml = await request("/admin/invoices");
      const txHtml = await request("/admin/transactions");
      const risksHtml = await request("/admin/risks");
      const adminCss = await request("/static/admin-glass.css");
      const checkoutCss = await request("/static/checkout-glass.css");

      assertEq(dashboardHtml.status, 200, "dashboard page status");
      assertEq(invoicesHtml.status, 200, "invoices page status");
      assertEq(txHtml.status, 200, "transactions page status");
      assertEq(risksHtml.status, 200, "risks page status");
      assertEq(adminCss.status, 200, "admin css status");
      assertEq(checkoutCss.status, 200, "checkout css status");

      assert(
        dashboardHtml.text.includes("/static/admin-dashboard.js"),
        "dashboard page missing admin-dashboard.js",
      );
      assert(
        invoicesHtml.text.includes("/static/admin-invoices.js"),
        "invoices page missing admin-invoices.js",
      );
      assert(
        txHtml.text.includes("/static/admin-transactions.js"),
        "transactions page missing admin-transactions.js",
      );
      assert(
        risksHtml.text.includes("/static/admin-risks.js"),
        "risks page missing admin-risks.js",
      );
      assert(
        adminCss.text.includes(".admin-shell"),
        "admin css seems broken: .admin-shell not found",
      );
      assert(
        checkoutCss.text.includes(".checkout-shell"),
        "checkout css seems broken: .checkout-shell not found",
      );
    }

    logStep(step++, "Auth guard for admin APIs");
    {
      const unauthorized = await request("/api/admin/dashboard");
      assertEq(unauthorized.status, 401, "unauthorized dashboard should be 401");
    }

    logStep(step++, "Create invoice validation");
    {
      const invalid = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 0,
          allowed_currencies: ["USDT"],
        },
      });
      assertEq(invalid.status, 400, "invalid invoice create status");
    }

    logStep(step++, "Create 2 invoices and verify unique expected amounts");
    let inv1;
    let inv2;
    {
      const create1 = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 100,
          telegram_user_id: "123456789",
          allowed_currencies: ["USDT", "BTC", "ETH"],
        },
      });
      assertEq(create1.status, 201, "create invoice 1 status");
      inv1 = create1.json.invoice;
      assert(inv1 && inv1.shortId && inv1.token, "invoice1 payload invalid");
      assertEq(inv1.status, "pending", "invoice1 should be pending");
      assertEq(inv1.payments.length, 3, "invoice1 payment count");
      assert(
        String(inv1.paymentUrl || "").startsWith("https://payments.example.test/pay/"),
        "invoice1 paymentUrl base mismatch",
      );

      const create2 = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 100,
          allowed_currencies: ["USDT", "BTC", "ETH"],
        },
      });
      assertEq(create2.status, 201, "create invoice 2 status");
      inv2 = create2.json.invoice;
      assert(inv2 && inv2.shortId, "invoice2 payload invalid");

      const byCurrency = (invoice, code) =>
        Number(invoice.payments.find((p) => p.currency === code).expectedAmountCrypto);
      assert(
        byCurrency(inv1, "USDT") !== byCurrency(inv2, "USDT"),
        "USDT expected amounts should be unique across open invoices",
      );
      assert(
        byCurrency(inv1, "BTC") !== byCurrency(inv2, "BTC"),
        "BTC expected amounts should be unique across open invoices",
      );
      assert(
        byCurrency(inv1, "ETH") !== byCurrency(inv2, "ETH"),
        "ETH expected amounts should be unique across open invoices",
      );
    }

    logStep(step++, "Public invoice endpoints and checkout page");
    {
      const pubInvoice = await request(`/api/invoices/${encodeURIComponent(inv1.token)}`);
      assertEq(pubInvoice.status, 200, "public invoice status");
      assert(pubInvoice.json && pubInvoice.json.invoice, "public invoice missing payload");
      assertEq(pubInvoice.json.invoice.shortId, inv1.shortId, "public invoice shortId mismatch");

      for (const payment of pubInvoice.json.invoice.payments || []) {
        assert(
          String(payment.qrDataUrl || "").startsWith("data:image/png;base64,"),
          `payment ${payment.currency} missing qrDataUrl`,
        );
      }

      const payPage = await request(`/pay/${encodeURIComponent(inv1.token)}`);
      assertEq(payPage.status, 200, "checkout page status");
      assert(payPage.text.includes('id="walletCards"'), "checkout page missing walletCards");
    }

    logStep(step++, "Manual mark-paid validation");
    {
      const withoutHashOrAmount = await request(
        `/api/invoices/${encodeURIComponent(inv1.shortId)}/mark-paid`,
        {
          method: "POST",
          auth: true,
          body: { currency: "ETH" },
        },
      );
      assertEq(withoutHashOrAmount.status, 400, "mark-paid without hash/amount should fail");

      const invalidHash = await request(
        `/api/invoices/${encodeURIComponent(inv1.shortId)}/mark-paid`,
        {
          method: "POST",
          auth: true,
          body: {
            currency: "ETH",
            tx_hash: "12345",
            confirmations: 1,
            paid_amount_crypto: 1,
          },
        },
      );
      assertEq(invalidHash.status, 400, "mark-paid invalid tx hash should fail");
    }

    logStep(step++, "Manual mark-paid success and idempotency");
    const txHash1 = `0x${"1".repeat(64)}`;
    {
      const inv1EthExpected = Number(
        inv1.payments.find((payment) => payment.currency === "ETH").expectedAmountCrypto,
      );
      const markPaid = await request(
        `/api/invoices/${encodeURIComponent(inv1.shortId)}/mark-paid`,
        {
          method: "POST",
          auth: true,
          body: {
            currency: "ETH",
            tx_hash: txHash1,
            confirmations: 3,
            paid_amount_crypto: inv1EthExpected,
          },
        },
      );
      assertEq(markPaid.status, 200, "mark-paid status");
      assert(markPaid.json.changed === true, "mark-paid should change invoice");
      assertEq(markPaid.json.invoice.status, "paid", "invoice should become paid");

      const markPaidAgain = await request(
        `/api/invoices/${encodeURIComponent(inv1.shortId)}/mark-paid`,
        {
          method: "POST",
          auth: true,
          body: {
            currency: "ETH",
            tx_hash: txHash1,
            confirmations: 3,
            paid_amount_crypto: inv1EthExpected,
          },
        },
      );
      assertEq(markPaidAgain.status, 200, "second mark-paid status");
      assert(markPaidAgain.json.changed === false, "second mark-paid should be idempotent");
      assertEq(
        markPaidAgain.json.reason,
        "invoice_not_pending",
        "second mark-paid reason mismatch",
      );
    }

    logStep(step++, "Duplicate tx-hash protection");
    {
      const create = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 25,
          allowed_currencies: ["ETH"],
        },
      });
      assertEq(create.status, 201, "create duplicate-hash invoice status");
      const invoice = create.json.invoice;
      const expectedAmount = Number(invoice.payments[0].expectedAmountCrypto);

      const duplicateHash = await request(
        `/api/invoices/${encodeURIComponent(invoice.shortId)}/mark-paid`,
        {
          method: "POST",
          auth: true,
          body: {
            currency: "ETH",
            tx_hash: txHash1.toUpperCase(),
            confirmations: 4,
            paid_amount_crypto: expectedAmount,
          },
        },
      );
      assertEq(duplicateHash.status, 200, "duplicate hash status");
      assert(duplicateHash.json.changed === false, "duplicate hash should not change");
      assertEq(
        duplicateHash.json.reason,
        "tx_hash_already_used",
        "duplicate hash reason mismatch",
      );
    }

    logStep(step++, "Webhook signature and processing");
    const webhookInvoice = {};
    {
      const create = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 51,
          allowed_currencies: ["ETH"],
        },
      });
      assertEq(create.status, 201, "create webhook invoice status");
      webhookInvoice.id = create.json.invoice.id;
      webhookInvoice.shortId = create.json.invoice.shortId;
      webhookInvoice.token = create.json.invoice.token;

      const invalidSig = await request("/api/payments/webhook", {
        method: "POST",
        headers: {
          "x-webhook-signature": "sha256=00",
        },
        body: {
          invoiceId: webhookInvoice.id,
          currency: "ETH",
          status: "confirmed",
          txHash: `0x${"2".repeat(64)}`,
          confirmations: 4,
          amount: 0.01,
        },
      });
      assertEq(invalidSig.status, 401, "invalid webhook signature should be 401");

      const pendingPayload = JSON.stringify({
        invoiceId: webhookInvoice.id,
        currency: "ETH",
        status: "pending",
        txHash: `0x${"2".repeat(64)}`,
        confirmations: 1,
        amount: 0.01,
      });
      const pendingRes = await request("/api/payments/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": hmacSignature(pendingPayload),
        },
        body: pendingPayload,
      });
      assertEq(pendingRes.status, 200, "pending webhook status");
      assert(
        pendingRes.json.result && pendingRes.json.result.processed === false,
        "pending webhook should not process payment",
      );

      const confirmPayload = JSON.stringify({
        invoiceId: webhookInvoice.id,
        currency: "ETH",
        status: "confirmed",
        txHash: `0x${"3".repeat(64)}`,
        confirmations: 5,
        amount: 0.01,
      });
      const confirmRes = await request("/api/payments/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": hmacSignature(confirmPayload),
        },
        body: confirmPayload,
      });
      assertEq(confirmRes.status, 200, "confirmed webhook status");
      assert(
        confirmRes.json.result && confirmRes.json.result.processed === true,
        "confirmed webhook should process payment",
      );

      const statusRes = await request(
        `/api/invoices/id/${encodeURIComponent(webhookInvoice.shortId)}/status`,
        {
          auth: true,
        },
      );
      assertEq(statusRes.status, 200, "status by ref endpoint");
      assertEq(statusRes.json.status.status, "paid", "webhook invoice should be paid");
    }

    logStep(step++, "Transaction lookup by short ID and hash");
    let txShortRef = "";
    {
      const list = await request("/api/admin/transactions?limit=200", { auth: true });
      assertEq(list.status, 200, "transactions list status");
      assert(Array.isArray(list.json.transactions), "transactions list missing array");
      const tx = list.json.transactions.find((item) => String(item.txHash || "").endsWith("3333"));
      assert(tx, "cannot find webhook transaction in list");
      txShortRef = tx.shortId;

      const byShort = await request(`/api/admin/transactions/${encodeURIComponent(txShortRef)}`, {
        auth: true,
      });
      assertEq(byShort.status, 200, "tx detail by short ref");
      assertEq(byShort.json.transaction.shortId, txShortRef, "tx short ref mismatch");

      const byHash = await request(`/api/admin/transactions/${encodeURIComponent(tx.txHash)}`, {
        auth: true,
      });
      assertEq(byHash.status, 200, "tx detail by hash");
      assertEq(byHash.json.transaction.txHash, tx.txHash, "tx hash mismatch");
    }

    logStep(step++, "Admin invoice details endpoint");
    {
      const details = await request(`/api/admin/invoices/${encodeURIComponent(webhookInvoice.shortId)}`, {
        auth: true,
      });
      assertEq(details.status, 200, "admin invoice details status");
      assert(details.json.invoice, "invoice details missing invoice");
      assert(Array.isArray(details.json.events), "invoice details missing events array");
      assert(Array.isArray(details.json.transactions), "invoice details missing transactions array");
    }

    logStep(step++, "Concurrent mark-paid safety (same invoice, two requests)");
    {
      const create = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 39,
          allowed_currencies: ["ETH"],
        },
      });
      assertEq(create.status, 201, "create concurrent invoice status");
      const invoice = create.json.invoice;
      const expectedAmount = Number(invoice.payments[0].expectedAmountCrypto);
      const path = `/api/invoices/${encodeURIComponent(invoice.shortId)}/mark-paid`;

      const [a, b] = await Promise.all([
        request(path, {
          method: "POST",
          auth: true,
          body: {
            currency: "ETH",
            tx_hash: `0x${"4".repeat(64)}`,
            confirmations: 3,
            paid_amount_crypto: expectedAmount,
          },
        }),
        request(path, {
          method: "POST",
          auth: true,
          body: {
            currency: "ETH",
            tx_hash: `0x${"5".repeat(64)}`,
            confirmations: 3,
            paid_amount_crypto: expectedAmount,
          },
        }),
      ]);

      const changedCount = [a, b].filter((res) => res.status === 200 && res.json && res.json.changed).length;
      assertEq(changedCount, 1, "exactly one concurrent mark-paid should apply");
    }

    logStep(step++, "Delete one invoice by short ref");
    {
      const deleteRes = await request(`/api/admin/invoices/${encodeURIComponent(inv2.shortId)}`, {
        method: "DELETE",
        auth: true,
      });
      assertEq(deleteRes.status, 200, "delete invoice by ref status");
      assert(deleteRes.json.ok === true, "delete invoice response should be ok=true");

      const deletedStatus = await request(
        `/api/invoices/id/${encodeURIComponent(inv2.shortId)}/status`,
        { auth: true },
      );
      assertEq(deletedStatus.status, 404, "deleted invoice status endpoint should return 404");
    }

    logStep(step++, "Expired invoice behavior (pay page and API)");
    {
      const create = await request("/api/invoices", {
        method: "POST",
        auth: true,
        body: {
          amount_usd: 77,
          allowed_currencies: ["USDT"],
        },
      });
      assertEq(create.status, 201, "create expiring invoice status");
      const invoice = create.json.invoice;

      db.prepare("UPDATE invoices SET expires_at = ?, status = 'pending', updated_at = ? WHERE id = ?").run(
        new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        new Date().toISOString(),
        invoice.id,
      );
      db.prepare(
        "UPDATE payments SET status = 'awaiting_payment', tx_hash = NULL, paid_amount_crypto = NULL, confirmations = 0, updated_at = ? WHERE invoice_id = ?",
      ).run(new Date().toISOString(), invoice.id);

      const payPage = await request(`/pay/${encodeURIComponent(invoice.token)}`);
      assertEq(payPage.status, 410, "expired pay page should return 410");

      const pubApi = await request(`/api/invoices/${encodeURIComponent(invoice.token)}`);
      assertEq(pubApi.status, 410, "expired invoice API should return 410");

      const markPaidExpired = await request(
        `/api/invoices/${encodeURIComponent(invoice.shortId)}/mark-paid`,
        {
          method: "POST",
          auth: true,
          body: {
            currency: "USDT",
            tx_hash: `${"a".repeat(64)}`,
            confirmations: 20,
            paid_amount_crypto: 10,
          },
        },
      );
      assertEq(markPaidExpired.status, 200, "mark-paid expired should return 200");
      assert(markPaidExpired.json.changed === false, "expired invoice should not be marked paid");
      assertEq(markPaidExpired.json.reason, "invoice_expired", "expired reason mismatch");
    }

    logStep(step++, "Risk monitor and verify-now endpoints");
    {
      const risk = await request("/api/admin/risk-monitor?limit=120", { auth: true });
      assertEq(risk.status, 200, "risk monitor status");
      assert(risk.json.riskMonitor, "risk monitor payload missing");
      assert(
        typeof risk.json.riskMonitor.summary.total === "number",
        "risk monitor summary.total is not numeric",
      );

      const verifyNow = await request("/api/payments/verify-now", {
        method: "POST",
        auth: true,
      });
      assertEq(verifyNow.status, 200, "verify-now status");
      assert(verifyNow.json.ok === true, "verify-now should return ok=true");
      assert(verifyNow.json.summary, "verify-now summary missing");
      assert(Array.isArray(verifyNow.json.summary.results), "verify-now results missing");
      assertEq(verifyNow.json.summary.results.length, 3, "verify-now should include 3 providers");
    }

    logStep(step++, "Delete-all protection and execution");
    {
      const badConfirm = await request("/api/invoices/delete-all", {
        method: "POST",
        auth: true,
        body: { confirm: "WRONG" },
      });
      assertEq(badConfirm.status, 400, "delete-all bad confirmation should be 400");

      const goodConfirm = await request("/api/invoices/delete-all", {
        method: "POST",
        auth: true,
        body: { confirm: "ELIMINA_TUTTO" },
      });
      assertEq(goodConfirm.status, 200, "delete-all good confirmation status");
      assert(goodConfirm.json.ok === true, "delete-all should return ok=true");
      assert(Number(goodConfirm.json.summary.deletedInvoices) >= 1, "delete-all should delete invoices");

      const invoicesAfter = await request("/api/admin/invoices?status=all&limit=50", { auth: true });
      assertEq(invoicesAfter.status, 200, "invoices list after delete-all status");
      assertEq(
        Array.isArray(invoicesAfter.json.invoices) ? invoicesAfter.json.invoices.length : -1,
        0,
        "invoices should be empty after delete-all",
      );

      const pendingAfter = await request("/api/invoices/pending?limit=20", { auth: true });
      assertEq(pendingAfter.status, 200, "pending list status");
      assertEq(
        Array.isArray(pendingAfter.json.invoices) ? pendingAfter.json.invoices.length : -1,
        0,
        "pending invoices should be empty after delete-all",
      );
    }

    console.log("FULL_CHECK_PASSED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run()
  .catch((error) => {
    console.error("FULL_CHECK_FAILED:", error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      db.close();
    } catch (_error) {
      // ignore
    }
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${tempDbPath}${suffix}`;
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    } catch (_error) {
      // ignore cleanup errors
    }
  });
