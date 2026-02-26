# Specifica Tecnica - Bot Telegram per Fatture Crypto

## 1. Obiettivo del progetto
Realizzare un sistema semplice ma affidabile per creare e gestire fatture in USD con pagamento in criptovaluta (USDT, BTC, ETH), composto da:
- Bot Telegram (interazione con admin e utente finale)
- Backend API HTTPS
- Pagina web di pagamento mobile-first

Il sistema deve generare automaticamente il controvalore crypto da importo USD e fornire un link di pagamento condivisibile.

## 2. Lingua e localizzazione
- Tutti i testi del bot, pannello admin e pagina pagamento devono essere in italiano.
- Formato importi: standard internazionale (es. `100.00 USD`).
- Formato data/ora: fuso configurabile (default UTC, opzionale Europe/Rome).

## 3. Ruoli utente
### 3.1 Admin
- Crea fatture (importo in USD obbligatorio).
- Seleziona valuta accettata: USDT, BTC, ETH (una o piu opzioni).
- Opzionalmente inserisce `telegram_user_id` del cliente.
- Ottiene link di pagamento e stato fattura.

### 3.2 Cliente
- Riceve link fattura per il pagamento.
- Se avvia il bot con `/start`, riceve notifica di fattura non pagata (se associato via `telegram_user_id`) e relativo link.

## 4. Flusso UX principale
1. Admin crea una fattura indicando:
   - importo USD (obbligatorio)
   - valuta/e crypto ammesse (USDT/BTC/ETH)
   - `telegram_user_id` (opzionale)
2. Il sistema calcola il prezzo in crypto in tempo reale da feed di cambio.
3. Viene creata una pagina pagamento con URL unico (token sicuro).
4. Il bot restituisce all'admin il link della fattura.
5. Se il cliente scrive `/start` al bot (anche prima interazione), il bot cerca fatture aperte associate al suo `telegram_user_id` e invia messaggio con link.
6. Cliente apre la pagina, sceglie crypto, paga all'indirizzo mostrato.
7. Il sistema verifica la transazione (polling/webhook provider) e aggiorna stato:
   - `pending` -> `paid` (o `expired`/`failed`)
8. Bot invia conferma pagamento (admin e, opzionale, cliente).

## 5. Requisiti funzionali
### 5.1 Gestione fatture
- Creazione fattura con importo in USD.
- Conversione automatica USD -> crypto supportata.
- Salvataggio tasso di cambio usato al momento creazione.
- Generazione URL univoco e non predicibile.
- Stati fattura: `draft`, `pending`, `paid`, `expired`, `cancelled`.
- Possibilita di impostare scadenza (es. 15-60 minuti).

### 5.2 Bot Telegram
- Comandi minimi:
  - `/start`
  - `/help`
  - `/my_invoices` (opzionale)
- Messaggi automatici:
  - link fattura appena creata (admin)
  - promemoria fattura non pagata (utente associato)
  - conferma pagamento ricevuto
- Supporto primo avvio utente: se c'e una fattura aperta associata, mostrarla subito.

### 5.3 Pagamenti crypto
- Valute supportate:
  - USDT (specificare rete: es. TRC20 o ERC20)
  - BTC
  - ETH
- Generazione indirizzo wallet per pagamento (provider o wallet interno).
- Verifica transazioni on-chain con conferme minime configurabili.
- Tolleranza importo (underpayment/overpayment) gestita con regole chiare.

### 5.4 Pagina pagamento (UI)
- Design pulito, moderno, mobile-first.
- Mostrare chiaramente:
  - importo USD
  - equivalente in crypto
  - timer di scadenza
  - indirizzo wallet e QR code
  - stato pagamento in tempo reale
- UX smartphone prioritaria:
  - pulsanti grandi
  - copia indirizzo con 1 tap
  - layout responsive su schermi piccoli

## 6. Requisiti tecnici
### 6.1 HTTPS e infrastruttura
- Tutti i servizi pubblici devono funzionare su HTTPS.
- Certificato SSL valido (Let's Encrypt o equivalente).
- Webhook Telegram configurato su endpoint HTTPS.

### 6.2 Architettura suggerita (semplice)
- `Bot Service`: gestione comandi Telegram.
- `API Service`: creazione fatture, stato, conversioni, callback provider.
- `Web Frontend`: pagina pagamento.
- `DB`: persistenza utenti, fatture, transazioni, log eventi.
- `Rate Provider`: servizio per cambio USD/crypto.

### 6.3 Database (minimo)
- `users`:
  - id
  - telegram_user_id (unique)
  - username
  - created_at
- `invoices`:
  - id
  - public_token (unique)
  - amount_usd
  - allowed_currencies
  - exchange_snapshot
  - status
  - expires_at
  - telegram_user_id (nullable)
  - created_by_admin_id
  - created_at / updated_at
- `payments`:
  - id
  - invoice_id
  - currency
  - network
  - wallet_address
  - expected_amount_crypto
  - tx_hash
  - confirmations
  - status
  - created_at / updated_at

## 7. API minima (esempio)
- `POST /api/invoices` -> crea fattura
- `GET /api/invoices/{token}` -> dettaglio pubblico fattura
- `GET /api/invoices/{id}/status` -> stato fattura
- `POST /api/payments/webhook` -> callback provider blockchain
- `GET /api/rates` -> tassi correnti (interno/admin)

## 8. Sicurezza
- Token link fattura lungo e non sequenziale.
- Rate limiting su endpoint pubblici e webhook.
- Validazione input lato server.
- Firma e verifica richieste webhook (se supportata dal provider).
- Logging eventi critici: creazione fattura, cambio stato, callback ricevute.

## 9. Requisiti non funzionali
- Sistema semplice da mantenere.
- Tempo risposta API target: < 500 ms (esclusi provider esterni).
- Disponibilita base: 99%.
- Codice modulare per aggiungere valute/reti in futuro.

## 10. Criteri di accettazione (MVP)
- Admin puo creare fattura in USD e ottenere link funzionante.
- Pagina pagamento e accessibile da smartphone e desktop.
- Conversione USD -> USDT/BTC/ETH visibile e coerente col rate provider.
- Utente con `telegram_user_id` associato riceve fattura non pagata al primo `/start`.
- Dopo pagamento confermato, stato passa a `paid` e bot invia notifica.
- Tutti i testi visibili all'utente sono in italiano.

## 11. Stack consigliato (MVP rapido)
- Backend: Node.js (NestJS/Express) oppure Python (FastAPI)
- Bot: Telegram Bot API (webhook)
- Frontend pagina pagamento: HTML/CSS/JS o framework leggero (es. Next.js/Vite)
- DB: PostgreSQL
- Deploy: VPS con Nginx reverse proxy + SSL

## 12. Fasi di sviluppo
1. Setup progetto, DB, HTTPS e webhook Telegram.
2. Modulo creazione fattura + conversione tassi.
3. Pagina pagamento responsive con QR e stato.
4. Verifica transazioni e aggiornamento stati.
5. Notifiche bot (`/start`, promemoria, conferma pagamento).
6. Test end-to-end e rilascio MVP.
