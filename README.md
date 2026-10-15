# iCount

Klein Astro-programma op Cloudflare Workers dat de winst van 4 BV's en alle rekeningsaldi optelt.

- **Winst** komt uit Billit: verkoopfacturen min verkoopcreditnota's, min aankoopfacturen plus aankoopcreditnota's (excl. btw), per kalenderjaar.
- **Rekeningsaldi**: Billit heeft geen API voor het saldo zelf. Je vult per rekening één keer een saldo op een datum in (bv. van een uittreksel) met het IBAN; iCount telt de Billit-banktransacties na die datum erbij.
- Billit-resultaten worden 15 minuten bewaard in KV; "Vernieuwen uit Billit" haalt ze opnieuw op.
- Een BV zonder Billit-sleutel valt terug op handmatig ingevulde winst.

## Billit-sleutel instellen

Eén API-sleutel (Billit > Profiel > API) voor alle 4 de BV's, plus per BV de PartyID:

    npx wrangler secret put BILLIT_KEY
    npx wrangler secret put BILLIT_PARTYID_1
    npx wrangler secret put BILLIT_PARTYID_2
    npx wrangler secret put BILLIT_PARTYID_3
    npx wrangler secret put BILLIT_PARTYID_4

De PartyID's van je bedrijven zie je op `/billit-test` (onder `account`) nadat `BILLIT_KEY` is gezet.
Heeft een BV toch een eigen sleutel, gebruik dan `BILLIT_KEY_n`.

Testen tegen de Billit-sandbox: zet `BILLIT_BASE=https://api.sandbox.billit.be`.

Controle: `/billit-test` toont per BV twee ruwe records uit Billit.

## Lokaal draaien

    npm install
    npm run dev          # zet sleutels lokaal in .dev.vars

## Online zetten

Draait op https://icount.ibite.be (custom domain in `wrangler.jsonc`).
Cloudflare Workers Builds bouwt bij elke push naar `main`:
build `npm run build`, deploy `npx wrangler deploy --config dist/server/wrangler.json`.

Handmatig kan ook:

    npx wrangler login
    npm run deploy

De KV-namespaces `icount` en `icount-session` staan in `wrangler.jsonc`. Toegang loopt via Cloudflare Access (app "iCount").

## Beveiliging

    npx wrangler secret put WACHTWOORD

Of zet Cloudflare Access voor de worker.
