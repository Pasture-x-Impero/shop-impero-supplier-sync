# shop-impero-supplier-sync

Daglig synk av innkjøpspriser og lagerantall fra leverandører til shop.impero.no,
kjørt fra GitHub Actions. Butikken (en Lovable app) leser kun fra sin egen Supabase
database. Dette repoet har ingen Supabase nøkkel: alt skrives via Edge Functions i
Lovable prosjektet, autentisert med én smal delt hemmelighet.

Leverandører:

- **TD Synnex** (Digital Bridge API, OAuth2) daglig, aktiv
- **ALSO Norge** (prisfil som ZIP, sesjon cookie) daglig, for tiden disabled
- **isicom.no** (PrestaShop, sesjon cookie) kun manuell

I tillegg berikes hvert produkt med kort navn og strukturerte specs fra Icecat sin
åpne katalog, med Power/Komplett/Dustin som fallback for navn og bilde når Icecat
ikke fører produktet. Se `CLAUDE.md` for hele arkitekturen, kontraktene mot Edge
Functions og tekniske lærdommer.

Konkurrent prisingen (utsalgspris basert på Power/Dustin/Komplett/Eplehuset) ligger i
et eget, privat repo og er ikke en del av dette.

## Arkitektur

```
shop-impero-supplier-sync
│
├── tdsynnex-sync.yml (daglig kl. 06:00) → TD Synnex Digital Bridge API
│     Kun MPN er som allerede finnes i butikkens katalog (hentet via
│     price-sync-mpns), ikke hele produsentkataloger.
│
├── also-sync.yml (daglig kl. 06:00) → ALSO Norge (HTTPS ZIP nedlasting)
│     ⏸️ DISABLED. Automatisk fornyelse av sesjon cookie (2FA) er ikke løst.
│
├── isicom-sync.yml (kun manuell) → isicom.no
│
├── session-renewal.yml (hvert 6. time)
│     ⏸️ DISABLED. Skulle fornye ALSO/isicom cookies automatisk.
│
└── POST → price-sync (Supabase Edge Function i Lovable prosjektet)
        header: x-price-sync-secret
        Edge Function kjører med service role internt og gjør alt databasearbeid.
```

## Oppsett

### 1. Klon og installer

```bash
git clone https://github.com/Pasture-x-Impero/shop-impero-supplier-sync.git
cd shop-impero-supplier-sync
npm install
```

Krever Node 22 eller nyere (koden kjøres med `--experimental-strip-types`, ingen
byggesteg).

### 2. GitHub Secrets

**Settings → Secrets and variables → Actions**:

| Secret | Brukes av | Beskrivelse |
|---|---|---|
| `PRICE_SYNC_SECRET` | Alle workflows | Delt hemmelighet med Edge Functions i Lovable prosjektet. Må være identisk der og her. |
| `TDSYNNEX_CLIENT_ID` / `TDSYNNEX_CLIENT_SECRET` | `tdsynnex-sync.yml` | TD Synnex Digital Bridge OAuth2 klient (API Credential center) |
| `ALSO_SESSION_COOKIE` | `also-sync.yml` (disabled) | ALSO innkjøpsportal sesjon cookie |
| `ALSO_USERNAME` / `ALSO_PASSWORD` / `ALSO_TOTP_SECRET` | `session-renewal.yml` (disabled) | Automatisk cookie fornyelse, ikke i drift |
| `ISICOM_SESSION_COOKIE` | `isicom-sync.yml` | isicom.no PrestaShop sesjon cookie |
| `GH_TOKEN_SECRETS_WRITE` | `session-renewal.yml` (disabled) | Fine grained PAT med `secrets:write`, scopet til kun dette repoet |
| `SLACK_WEBHOOK_URL` | Alle workflows | Valgfritt Slack varsel ved feil |

### 3. Sesjon cookies (manuelt)

**ALSO** (kun når `also-sync.yml` er skrudd på igjen):
1. Logg inn på [www.also.com](https://www.also.com)
2. DevTools → Application → Cookies
3. Kopier alle cookies for `also.com` og `weblogin.also.com`
4. Lim inn som `ALSO_SESSION_COOKIE` (format: `navn=verdi; navn2=verdi2`)

**isicom.no** (valgfritt):
1. Logg inn på [www.isicom.no](https://www.isicom.no)
2. Kopier `PHPSESSID` og `PrestaShop-{hash}` cookies
3. Lim inn som `ISICOM_SESSION_COOKIE`

**TD Synnex Digital Bridge:**
1. Gå til [developer.api.tdsynnex.com/eu](https://developer.api.tdsynnex.com/eu)
2. Logg inn med PartnerFirst brukeren
3. API tilgang må være aktivert av TD Synnex på reseller kontoen først
4. "API Credential center" → "+ Add Client" (Production, ingen IP range nødvendig)
5. Lagre som `TDSYNNEX_CLIENT_ID` og `TDSYNNEX_CLIENT_SECRET`

### 4. Lokal kjøring

```bash
export PRICE_SYNC_SECRET="..."
export TDSYNNEX_CLIENT_ID="..."
export TDSYNNEX_CLIENT_SECRET="..."

node --experimental-strip-types src/sync.ts tdsynnex   # Kun TD Synnex, kjente MPN er
node --experimental-strip-types src/sync.ts also       # Kun ALSO (krever ALSO_SESSION_COOKIE)
node --experimental-strip-types src/sync.ts isicom     # Kun isicom.no
npm run sync                                           # ALSO + TD Synnex (delta)

# Dry run: hent og print rådata uten å skrive noe
npm run sync:also
npm run sync:tdsynnex

# Diagnose av Icecat berikelse for ett produkt, skriver aldri til DB eller cache
node --experimental-strip-types src/sync.ts icecat-debug <mpn> [produsent] [ean]

npm test         # 30 tester (node:test)
npm run typecheck
```

## GitHub Actions

| Workflow | Trigger | Status | Hva den gjør |
|---|---|---|---|
| `tdsynnex-sync.yml` | Daglig kl. 06:00 | ✅ Aktiv | TD Synnex innkjøpspriser og lager, kun kjente MPN er. Kjører Icecat bildeimport som eget steg etterpå. |
| `also-sync.yml` | Daglig kl. 06:00 | ⏸️ Disabled | ALSO innkjøpspriser |
| `isicom-sync.yml` | Kun manuell | ✅ Aktiv | isicom.no innkjøpspriser |
| `session-renewal.yml` | Hvert 6. time | ⏸️ Disabled | Automatisk cookie fornyelse |

Manuell kjøring: **Actions → velg workflow → Run workflow**. `tdsynnex-sync.yml` har
flere debug moduser i `workflow_dispatch` (se `CLAUDE.md`).

`data/icecat-cache.json` er en git committed cache over Icecat oppslag. Workflowene
committer den automatisk tilbake til `main` når den endrer seg (`github-actions[bot]`).

## Supabase tabeller (eies av Lovable)

| Tabell | Rolle |
|---|---|
| `products` | Kuratert produktkatalog. Matches på `mpn`. Ukjente MPN er fra kjente produsenter auto opprettes skjult. |
| `producers` / `product_categories` | Setter `producer_id`/`category_id` på auto opprettede produkter. |
| `suppliers` | Rader for Also, TD Synnex, Isicom. |
| `product_supplier_prices` | Innkjøpspris, lagerantall og `is_preferred` per produkt per leverandør. Hovedmålet for synken. |
| `price_history` | Én rad ved faktisk endring i innkjøpspris. |
| `price_imports` / `sync_log` | Kjørelogg per leverandør og per kjøring. |
