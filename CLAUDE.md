# shop-impero-supplier-sync — Claude Code kontekst

> Dette repoet er **offentlig**. Ikke skriv kundenumre, kontaktpersoner, e-poster,
> hemmeligheter eller intern driftshistorikk hit. Teknisk arkitektur, kontrakter og
> lærdommer hører hjemme her, alt annet i det private søsterrepoet.

## Hva er dette?

GitHub Actions workflows som daglig synkroniserer innkjøpspriser og lagerantall fra
leverandører (TD Synnex, ALSO, isicom.no) til shop.impero.no sin Supabase database,
og beriker produktene med kort navn, strukturerte specs og bilde via Icecat med
Power/Komplett/Dustin som fallback.

shop.impero.no er en Lovable app (prosjekt `impero-shop`). Appen leser kun fra
Supabase. Ingen leverandørkoblinger i appen.

**Konkurrent prisingen** (utsalgspris basert på Power/Dustin/Komplett/Eplehuset) ligger
i et eget privat repo. `src/fetchers/power.ts`, `komplett.ts` og `dustin.ts` finnes her
kun fordi navn og bilde fallbacken i `src/enrichment/competitor-name.ts` bruker dem.

## Filoversikt

- `src/sync.ts` — hovedorkestrering. Modus som første argument, se "Kjørekommandoer".
- `src/supabase.ts` — POST er priser til `price-sync` Edge Function i batcher, og henter
  kjente MPN er fra `price-sync-mpns`. Ingen Supabase nøkkel her.
- `src/types.ts` — `SupplierProduct` og andre delte typer.
- `src/fetchers/tdsynnex.ts` — TD Synnex Digital Bridge API (OAuth2 client_credentials).
- `src/fetchers/also.ts` — ALSO prisfil (ZIP nedlasting + tab parsing).
- `src/fetchers/isicom.ts` — isicom.no PrestaShop scraping, laveste prioritet.
- `src/fetchers/power.ts` / `komplett.ts` / `dustin.ts` — kun brukt av navn/bilde
  fallbacken, se "Icecat berikelse".
- `src/enrichment/` — Icecat klient, normalisering, cache og konkurrent fallback.
- `src/utils/renew-also-session.ts` / `renew-isicom-session.ts` — Playwright cookie
  fornyelse. `github-secrets.ts` oppdaterer GitHub Secrets trygt (execFile, ikke shell).
- `data/icecat-cache.json` — git committed cache, se "Icecat berikelse".
- `.github/workflows/` — `tdsynnex-sync.yml` (daglig), `also-sync.yml` (daglig,
  disabled), `isicom-sync.yml` (manuell), `session-renewal.yml` (disabled).

## Teknisk arkitektur

```
tdsynnex-sync.yml / also-sync.yml / isicom-sync.yml
│
├── TD Synnex: OAuth2 client_credentials
│   POST https://api.tdsynnex.com/eu/auth/token
│   POST https://api.tdsynnex.com/eu/resellers/v2/products/catalogue
│   Kun MPN er som allerede finnes i `products` (via price-sync-mpns).
│
├── ALSO: Keycloak sesjon cookie, HTTPS nedlasting av pricelist-1.txt.zip
│   (tab separert, UTF-8). ALSO sender alltid hele katalogen, ingen delta.
│   Filtreres til kjente MPN er før sending.
│
├── isicom.no: PrestaShop sesjon cookie, HTML scraping.
│
└── POST → price-sync (Supabase Edge Function, Lovable Cloud)
        header: x-price-sync-secret (PRICE_SYNC_SECRET)
        Edge Function kjører med service role internt.
```

### Skjemaet eies av Lovable, ikke av dette repoet

Dette repoet har aldri en Supabase nøkkel. `service_role` er en plattformhemmelighet i
Lovable Cloud. All databaselogikk ligger i `supabase/functions/price-sync/index.ts` i
`impero-shop` prosjektet. Trengs en endring i logikk eller skjema, be Lovable agenten
for `impero-shop` om det. Ikke forsøk SQL direkte.

Edge Functions dette repoet snakker med:

| Funksjon | Retning | Bruk |
|---|---|---|
| `price-sync` | skriv | Priser, lager, navn, specs, bilde per leverandør |
| `price-sync-mpns` | les | MPN ene til alle produkter i `products` (paginert forbi 1000) |
| `import-icecat-images` | skriv | Kalles som eget steg i `tdsynnex-sync.yml` etter synken |

### Tabeller `price-sync` skriver til

| Tabell | Bruk |
|---|---|
| `products` | Matches på `mpn`. Ingen match + kjent produsent → nytt skjult produkt (`is_visible=false`, kategori "Ikke kategorisert"). **Derfor må alle leverandørspørringer være MPN scopet**, ellers opprettes ett skjult produkt per treff i hele produsentkatalogen. `name` overskrives ved oppdatering med mindre `name_locked_by_admin` er satt. |
| `producers` | Kjente produsenter: Apple, Dell, EPOS, HP, Jabra, Lenovo, Logitech, Microsoft, Philips, Samsung. ALSO fører Jabra som "GN NETCOM", mappes i Edge Function. Ukjent produsent gir "skipped". |
| `suppliers` | Also, TD Synnex, Isicom. Matches case insensitivt på `name`. |
| `product_supplier_prices` | Upsert på `(product_id, supplier_id)`: `purchase_price`, `supplier_sku`, `last_fetched_at`, `stock_quantity`, `stock_updated_at`. `is_preferred` gjenberegnes (laveste pris). |
| `price_history` | Kun ved faktisk prisendring. |
| `price_imports` / `sync_log` | Kjørelogg. |
| `suppliers.last_sync_at` / `last_sync_status` | Vises i admin. |

## Kontrakt mot `price-sync`

Hver batch (BATCH_SIZE 40, satt ned fra 200 etter 504 feil) er én POST med:

- `supplier` — `also` / `tdsynnex` / `isicom`
- `items[]` — se `toPayloadItem()` i `src/supabase.ts`: `mpn`, `manufacturer`, `name`,
  `purchase_price` (ekskl. mva), `supplier_sku`, `ean`, `available_qty`,
  `next_delivery_date` (ikke lagret ennå), `source_name`, `specs`, `image_url`
- `run_started_at` — ISO tidspunkt for starten på hele synken, identisk i alle batcher.
  Edge Function bruker den som terskel for "stale stock" i stedet for egen klokke, slik
  at tidligere batcher i samme kjøring ikke nullstilles av senere.
- `finalize` — `true` kun i siste batch, og kun hvis ingen tidligere batch feilet.
  Stale reset (nullstill lager for rader leverandøren ikke leverte) kjører KUN da.

**Lager:** `available_qty` mappes til `stock_quantity`/`stock_updated_at`. Mangler
feltet helt gir `null` (ikke rapportert), ikke `0`. isicom sitt tall er kun 0/1 proxy.
Butikken viser "ukjent" når ingen leverandørrad har `stock_updated_at`.

**Lærdom, to ganger:** felt som sendes i payload men aldri leses av Edge Function
(`ean`, `available_qty` tidligere) gir ingen feil, bare stille datatap. Verifiser alltid
i `products`/`product_supplier_prices` at et nytt felt faktisk lander.

## TD Synnex

- Auth er OAuth2 client_credentials, ikke statisk Bearer. Token hentes og caches per
  kjøring.
- Produktlisten ligger under JSON nøkkelen `data`, ikke `products`.
- Feltnavn: `manufPartNumber`, `productDescription`, `price.customerPrice`
  (`listPrice` er høyere referansepris), `stock.quantityAvailableTotal`, neste levering
  er tidligste dato i `stock.quantityIncomingByDate`.
- Minst ett søkeparameter er obligatorisk. `modifiedFrom` alene gir HTTP 400.
- **10 000 rads cap** på rene `manufacturer` søk, uten feilmelding. Bruk `class`/
  `subclass` (f.eks. `COMPORT:NOTEBOOKS` for Apple bærbare) når et helt segment skal
  kartlegges.
- Catalogue API et returnerer **ingen bildefelt**, og ukjente `include*` flagg ignoreres
  stille. Bilder kommer fra Icecat i stedet.
- `isPhysicalProduct` finnes kun i svar på `tdsynnexPartNumber` søk, ikke
  `manufPartNumber` (produksjonsstien). Service/garanti SKU er filtreres i stedet via
  `classDesc`/`subclassDesc` pluss navnemønstre i `mapProduct()`.
- `mode=full` (bred produsentskann) lager uunngåelig tusenvis av skjulte produkter og
  service SKU søppel. **Kjør aldri uten planlagt opprydding etterpå.** Historisk ga ett
  slikt kjør 5 922 nye rader som måtte ryddes manuelt via Lovable agenten.
- Produsenter i lista: HP, Lenovo, Dell, Apple, Samsung, Jabra, Logitech, Philips.
  Microsoft fjernet (for mange endringer per dag), Asus/LG fjernet (ingen producer rad).

## ALSO

- Portal URL: `https://www.also.com/ec/cms5/2900/pricelistView.do?todo=download&filename=pricelist-1.txt.zip`
  (2900 er landkoden for den norske portalen).
- Sesjon cookie utløper etter litt over ett døgn i praksis. Manuell fornyelse: logg
  inn, kopier alle cookies for `also.com` og `weblogin.also.com`, lim inn som
  `ALSO_SESSION_COOKIE`.
- **Automatisk 2FA innlogging er uttømmende feilsøkt og fungerer ikke fra GitHub
  Actions.** Avkreftet: feil TOTP secret (verifisert korrekt manuelt), splittede
  OTP felt, klokkedrift, flere 2FA credentials, headless fingerprint, og til slutt
  ekte ikke headless Chrome under Xvfb. Identisk "Ugyldig engangskode" hver gang.
  Gjenværende forklaring er server side IP/risikovurdering i ALSO sin Keycloak.
  Gjentatte forsøk ga midlertidig kontosperre. **Ikke skru på `session-renewal.yml`
  igjen uten ny informasjon fra ALSO support.** Mulig vei videre: halvautomatisk
  skript der et menneske taster 6 sifferkoden i et synlig vindu.
- `also-sync.yml` er disabled inntil videre for å slippe daglig støy på utløpt cookie.
- ALSO fetcheren filtreres til kjente MPN er i `sync.ts` (samme prinsipp som
  TD Synnex). Før dette opprettet én kjøring 460 skjulte produkter.

## Icecat berikelse (`src/enrichment/`)

Ingen leverandør har et kort produktnavn, kun full spesifikasjonstekst. Derfor:

- `icecat.ts` — eksakt treff API (EAN → merke+MPN → merke+basis MPN uten regional
  suffiks som `#UUW`). Gratis `openIcecat-live` bruker. Kaster aldri, returnerer
  `matched | not_found | error`.
- `normalize.ts` — bygger kort navn (merke + modell + spec highlights, f.eks.
  `"HP ZBook Ultra G1a — Ryzen AI Max+ PRO 395, 128GB/4TB"`) og 9 faste norske
  `specs` nøkler fra `FeaturesGroups`, pluss `tastaturoppsett` fra nøkkelordsøk i
  distributørens egen tekst (`source_text`). Feltnavn er verifisert mot ekte respons:
  "Processor model" alene er ufullstendig og må kombineres med "Processor family",
  "Discrete graphics card model" kan være placeholder `"Not available"`.
- `isMeaningfulModelName()` — Icecat sitt `ProductName` er i ~30 % av tilfellene bare
  MPN en selv (Lenovo tilbehør, mange skjermer). Da beholdes `specs`, men `name` blir
  `null` og distributørnavnet brukes.
- `competitor-name.ts` — fallback når Icecat mangler treff eller meningsfullt navn:
  Power (EAN) → Komplett (MPN) → Dustin (MPN). Gir navn og `image_url`, ingen specs.
  `nameSource` i cachen sier hvor navnet kom fra.
- `cache.ts` — `data/icecat-cache.json`, nøkkel `ean:<ean>` eller `mpn:<merke>|<mpn>`.
  `matched` permanent, `not_found` prøves igjen etter 14 dager, forbigående feil
  skrives aldri. Git committed (ikke `actions/cache`, som kastes etter 7 dager).
  Workflowene committer filen tilbake kun hvis den endret seg, `continue-on-error`.
- `index.ts` — `enrichProducts()`, kalt fra ETT sted i `sync.ts` for alle leverandører.
  Garanterer at samme EAN fra to distributører får identisk navn/specs.

`image_url` fra Power/Komplett/Dustin sendes i payloaden. Lovable siden må lese feltet
og sette `products.image_url` kun når produktet mangler bilde helt (aldri overskrive et
kuratert bilde). Frem til det er gjort ignoreres feltet trygt.

`tdsynnex-sync.yml` kaller `import-icecat-images` etter synken (inntil 12 kall à 60
produkter) slik at nye produkter får bilde fra dag én. Lovable sin publiseringstrigger
krever bilde, MPN og rapportert lager for at et produkt kan gjøres synlig.

## Konkurrent fetcherne (kun navn/bilde fallback her)

- **Power.no** — åpent JSON API (`/api/v2/search/suggestions` + `/api/v2/products`).
  Bilde URL bygges mot `media.power-cdn.net`.
- **Komplett** — Kasada bot beskyttelse avviser `curl` på TLS nivå, men Node sin
  `fetch()` (undici) kommer gjennom. Eksakt MPN søk gir redirect til produktsiden ved
  treff. JSON-LD blokken har HTML entity kodet `type`, bruk `id="product-schema-main"`.
  EAN ligger i `additionalProperty`.
- **Dustin** — Next.js RSC app. Product objektet ligger som escaped JSON streng i en
  `self.__next_f.push` chunk, ikke i en ld+json tag. Les med regex fra `"mpn":"<mpn>"`
  ankeret, ikke full `JSON.parse` (tomme tegn i navn bryter parsing). Eksakt MPN søk
  gir redirect ved treff. Priser er ekskl. mva (`valueAddedTaxIncluded`).
- Søk på EAN fungerer ikke hos noen av dem, kun MPN. EAN brukes til verifisering.

## GitHub Actions lærdommer

- `secrets` konteksten kan ikke brukes i `if:`. Hele workflow filen blir ugyldig, uten
  synlig feil andre steder enn Actions fanen. Send via `env:` og sjekk `env.X`.
  Dette stoppet all synk i en uke uten at noen merket det. Sjekk Actions fanen etter
  hver endring i en `.yml`.
- Én workflow per leverandør, slik at en utløpt ALSO cookie ikke viser TD Synnex som
  feilet.
- Workflowene har `permissions: contents: write` kun for cache commit steget.

## Kjørekommandoer

```bash
npm run sync                     # ALSO + TD Synnex kjente MPN er (delta)
node --experimental-strip-types src/sync.ts tdsynnex
node --experimental-strip-types src/sync.ts also
node --experimental-strip-types src/sync.ts isicom
node --experimental-strip-types src/sync.ts full          # Bred TD Synnex skann, se advarsel
node --experimental-strip-types src/sync.ts icecat-debug <mpn> [produsent] [ean]
npm run sync:also / sync:tdsynnex / sync:isicom            # Dry run, skriver ingenting
npm test                                                   # 30 tester, node:test
npm run typecheck
```

Debug moduser for TD Synnex (`tdsynnex-sync.yml` sin `workflow_dispatch`, valgfritt
`part` input): `tdsynnex-debug`, `tdsynnex-debug-tdpn`, `tdsynnex-debug-raw`,
`tdsynnex-debug-raw-mpn`, `tdsynnex-debug-raw-mpn-extra`, `tdsynnex-debug-count`,
`tdsynnex-discover [class:subclass]`, `mpns-debug`, `icecat-images` (no-op som kun
kjører bildesteget).

## Priser

| Leverandør | Format |
|---|---|
| ALSO | Ekskl. mva |
| TD Synnex | Ekskl. mva |
| isicom.no | Ekskl. mva |

ALSO og TD Synnex bruker samme MPN format (f.eks. `AD3C6ET#UUW`). Jabra: `38599-989-899`.
