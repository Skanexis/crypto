const fs = require("fs");
const http = require("http");
const https = require("https");
const app = require("./app");
const config = require("./config");
const { expireDueInvoices, getRiskMonitor } = require("./services/invoices.service");
const { runPaymentVerifierJob } = require("./services/payment-verifier.service");
const {
  notifyVerifierSummary,
  notifyRiskMonitorSummary,
} = require("./services/notifications.service");

let server;

if (config.ssl.certPath && config.ssl.keyPath) {
  const cert = fs.readFileSync(config.ssl.certPath);
  const key = fs.readFileSync(config.ssl.keyPath);
  server = https.createServer({ cert, key }, app);
} else {
  server = http.createServer(app);
}

server.listen(config.port, () => {
  const protocol = config.ssl.certPath && config.ssl.keyPath ? "https" : "http";
  console.log(`[server] ${protocol}://localhost:${config.port}`);
  console.log(`[server] APP_BASE_URL=${config.appBaseUrl}`);
});

setInterval(() => {
  try {
    const count = expireDueInvoices();
    if (count > 0) {
      console.log(`[jobs] fatture scadute aggiornate: ${count}`);
    }
  } catch (error) {
    console.error("[jobs] errore scadenza fatture:", error.message);
  }
}, 60 * 1000);

setInterval(async () => {
  try {
    const summary = await runPaymentVerifierJob();
    if (summary && (summary.paid > 0 || summary.errors.length > 0)) {
      console.log(
        `[jobs] verify payments checked=${summary.checked} paid=${summary.paid} errors=${summary.errors.length}`,
      );
      if (summary.errors.length > 0) {
        console.log(`[jobs] verify errors: ${summary.errors.slice(0, 3).join(" | ")}`);
      }
    }
    if (summary && config.verifierAlertsEnabled) {
      await notifyVerifierSummary(summary, {
        source: "job-auto",
      });
    }
  } catch (error) {
    console.error("[jobs] errore verifica pagamenti:", error.message);
  }
}, Math.max(10, Number(config.verifyIntervalSeconds || 45)) * 1000);

setInterval(async () => {
  try {
    if (!config.riskAlertsEnabled) {
      return;
    }
    const monitor = getRiskMonitor({ limit: 100 });
    await notifyRiskMonitorSummary(monitor, {
      source: "job-risk",
    });
  } catch (error) {
    console.error("[jobs] errore monitor rischi:", error.message);
  }
}, Math.max(30, Number(config.riskAlertIntervalSeconds || 180)) * 1000);
