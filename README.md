# Servizio Bot Telegram + Fatture Crypto (MVP)

Sistema completo in Node.js che permette di:
- creare fatture in USD
- pagare in USDT/BTC/ETH
- mostrare pagina pagamento responsive
- gestire notifiche Telegram con `/start`, `/my_invoices`, `/new_invoice`

## Funzioni principali
- Bot Telegram via webhook HTTPS
- API admin per creazione/stato fatture
- Pagina pagamento mobile-first con QR code
- Conversione USD -> crypto tramite CoinGecko
- Verifica on-chain automatica:
  - `ETH` via Etherscan API V2
  - `USDT (TRC20)` via TronGrid API
  - `BTC` via Blockstream API
- Verifica pagamenti via webhook provider (HMAC)
- Endpoint manuale `mark-paid` e endpoint `verify-now`

## Installazione
```bash
npm install
cp .env.example .env
```

Compila `.env` con:
- `ADMIN_API_KEY`
- wallet reali per `USDT/BTC/ETH`
- `TELEGRAM_BOT_TOKEN` (se usi il bot)
- `APP_BASE_URL` pubblico HTTPS in produzione
- `ETHERSCAN_API_KEY` per verifiche ETH
- `TRON_API_KEY` (consigliato) per verifiche USDT TRC20
- endpoint BTC Blockstream configurato in `BTC_API_URL`

Nota: Etherscan V2 richiede API key valida per interrogare `txlist`.
Il sistema aggiunge un micro-offset all'importo crypto per rendere univoco ogni invoice anche con wallet condiviso.

## Avvio
```bash
npm start
```

Controllo rapido integrita payment-flow:
```bash
npm run self-check
```

Controllo completo end-to-end:
```bash
npm run full-check
```

Server:
- Home admin UI: `http://localhost:3000/admin`
- Pagina pagamento: `http://localhost:3000/pay/{token}`
- Health: `http://localhost:3000/api/health`

## Configurare webhook Telegram
1. Imposta `TELEGRAM_BOT_TOKEN`, `APP_BASE_URL`, `TELEGRAM_WEBHOOK_SECRET`.
2. Avvia server.
3. Esegui:
```bash
npm run set:webhook
```

In alternativa:
```bash
curl -X POST http://localhost:3000/telegram/set-webhook \
  -H "x-api-key: <ADMIN_API_KEY>"
```

## Comandi bot
- `/start`: mostra fatture aperte associate al tuo `telegram_user_id`
- `/my_invoices`: elenco fatture aperte
- `/help`: aiuto
- `/admin`: apre menu admin con pulsanti UX
- `/new_invoice <importo_usd> [telegram_user_id] [valute]` (admin, rapido)
- `/invoice_status <invoice_id>` (admin)
- `/pending_invoices` (admin)
- `/verify_now` (admin, trigger verifica on-chain)
- `/risk_monitor` (admin, riepilogo monitor rischi)
- `/delete_all_invoices` (admin, richiede conferma)

Esempio:
```text
/new_invoice 100 123456789 USDT,BTC,ETH
```

Nel menu admin Telegram:
- `➕ Nuova fattura` avvia wizard guidato
- `📌 Stato fattura` richiede riferimento invoice e mostra stato
- `🔎 Dettagli fattura` mostra fattura + transazioni + eventi
- `🛰 Verifica pagamenti` lancia verifica on-chain manuale
- `🚨 Monitor rischi` mostra criticita correnti
- `🧹 Elimina tutte` richiede conferma testuale `ELIMINA TUTTO`

## API principali

### Creazione fattura (admin)
`POST /api/invoices`
Headers:
- `x-api-key: <ADMIN_API_KEY>`

Body esempio:
```json
{
  "amount_usd": 120.50,
  "telegram_user_id": "123456789",
  "allowed_currencies": ["USDT", "BTC", "ETH"]
}
```

### Dettaglio pubblico fattura
`GET /api/invoices/:token`

### Stato fattura per ID (admin)
`GET /api/invoices/id/:invoiceId/status`

### Ultime fatture pendenti (admin)
`GET /api/invoices/pending?limit=20`

### Conferma manuale pagamento (admin)
`POST /api/invoices/:invoiceId/mark-paid`

Body esempio:
```json
{
  "currency": "BTC",
  "tx_hash": "0xabc123",
  "confirmations": 1
}
```

### Trigger manuale verifica on-chain (admin)
`POST /api/payments/verify-now`

Headers:
- `x-api-key: <ADMIN_API_KEY>`

Risposta: summary con `checked`, `paid`, `errors`.

### Eliminazione massiva fatture (admin)
`POST /api/invoices/delete-all`

Headers:
- `x-api-key: <ADMIN_API_KEY>`

Body:
```json
{
  "confirm": "DELETE_ALL"
}
```

Risposta: summary con numero di invoice/payment eliminate.

## Hardening pagamenti
- Matching importi in modalita stretta (default):
  - `STRICT_AMOUNT_MATCH=true` (richiede importo crypto esatto)
- Matching importo con doppia soglia:
  - `PAYMENT_AMOUNT_TOLERANCE_PCT` (underpayment)
  - `PAYMENT_AMOUNT_MAX_OVER_PCT` (overpayment massimo accettato)
- Grace period on-chain dopo scadenza:
  - `PAYMENT_LATE_GRACE_MINUTES`
- Nessun pre-match prima creazione invoice (default):
  - `PAYMENT_EARLY_MATCH_GRACE_SECONDS=0`
- Retry automatico provider:
  - `PROVIDER_MAX_RETRIES`
- Alert Telegram admin:
  - `VERIFIER_ALERTS_ENABLED`
  - `RISK_ALERTS_ENABLED`
  - `RISK_ALERT_INTERVAL_SECONDS`
- Importi invoice resi univoci (wallet condiviso):
  - `UNIQUE_AMOUNT_MAX_BUMPS`

### Webhook provider pagamento
`POST /api/payments/webhook`

Header opzionale:
- `x-webhook-signature: sha256=<hmac_hex>`

Body esempio:
```json
{
  "invoiceId": "uuid-fattura",
  "currency": "ETH",
  "status": "confirmed",
  "txHash": "0x...",
  "confirmations": 6,
  "amount": 0.123
}
```

## Deploy produzione
- Metti il servizio dietro Nginx/Caddy con HTTPS.
- Usa `APP_BASE_URL` con dominio reale HTTPS.
- Proteggi `ADMIN_API_KEY`.
- Imposta rate-limit/firewall lato reverse proxy.
- Imposta API key reali per Etherscan/TronGrid.
- Verifica che `BTC_API_URL` punti al provider corretto (mainnet/testnet).

## Limiti MVP
- Verifica automatica implementata per `ETH`, `USDT TRC20`, `BTC`.
