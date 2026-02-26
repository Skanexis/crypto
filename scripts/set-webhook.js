const { setWebhook } = require("../src/services/telegram.service");

async function main() {
  const result = await setWebhook();
  console.log("Webhook configurato:", result);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
