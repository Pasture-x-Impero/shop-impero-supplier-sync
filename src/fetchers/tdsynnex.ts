/**
 * TD Synnex — Digital Bridge API
 *
 * Offisiell partner-API: https://developer.api.tdsynnex.com/eu/docs/resellers/catalogue
 * Endepunkt: POST /resellers/v2/products/catalogue
 * Auth: OAuth2 client_credentials — bytter TDSYNNEX_CLIENT_ID/TDSYNNEX_CLIENT_SECRET
 * (GitHub Secrets) mot et kortlevd Bearer-token via POST /auth/token. Verifisert mot
 * TD Synnex sin dokumentasjon (Production-miljø) 2026-08-31 — se CLAUDE.md.
 *
 * Strategi:
 *   - Full sync: hent alle produkter per produsent (ukentlig)
 *   - Delta sync: hent kun produkter endret siden i går (daglig, mye raskere)
 */

import type { SupplierProduct } from '../types.ts';

const API_BASE = 'https://api.tdsynnex.com/eu';
const TOKEN_ENDPOINT = `${API_BASE}/auth/token`;
const CATALOGUE_ENDPOINT = `${API_BASE}/resellers/v2/products/catalogue`;

const CLIENT_ID = process.env.TDSYNNEX_CLIENT_ID;
const CLIENT_SECRET = process.env.TDSYNNEX_CLIENT_SECRET;

// Cachet i minnet for varigheten av en enkelt sync-kjøring — hvert kall til
// node sync.ts starter en ny prosess, så tokenet fornyes automatisk hver kjøring.
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'TDSYNNEX_CLIENT_ID og TDSYNNEX_CLIENT_SECRET må være satt som miljøvariabler / GitHub Secrets'
    );
  }

  // Forny 60 sek før faktisk utløp for å unngå å bruke et token som utløper midt i en request
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.accessToken;
  }

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`TD Synnex: Klarte ikke å hente token (HTTP ${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in?: number };
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + expiresInMs };
  return cachedToken.accessToken;
}

// Produsentene vi vil hente priser for — begrenset til de som faktisk finnes
// som rader i `producers`-tabellen i Supabase (bekreftet 2026-09-01). Asus og
// LG er IKKE kuraterte produsenter i butikken, så alt derfra ble uansett bare
// hoppet over av price-sync — fjernet for å unngå bortkastede API-kall.
//
// Microsoft er også fjernet (2026-09-01): delta-synk rapporterte 10 000
// endrede produkter for Microsoft alene på én dag — så mye volum at hele
// jobben rant ut på GitHub Actions sin 30-minutters grense før den kom
// gjennom price-sync-batchene. Legg til igjen når price-sync er optimalisert
// til bulk-spørringer i stedet for én-og-én, eller hvis det viser seg 10 000
// var en pagineringsgrense og ikke et reelt tall — se CLAUDE.md.
const MANUFACTURERS = [
  'HP',
  'Lenovo',
  'Dell',
  'Apple',
  'Samsung',
  'Jabra',
  'Logitech',
  'Philips',
];

interface TDSynnexCatalogueRequest {
  manufPartNumber?: string[];
  upcEan?: string[];
  tdsynnexPartNumber?: string[];
  manufacturer?: string;
  class?: string;
  subclass?: string;
  includeStock?: boolean;
  includePrice?: boolean;
  onlyInStock?: boolean;
  productStatusCode?: 'Active' | 'Allocated' | 'Discontinued' | 'PhasedOut';
  modifiedFrom?: string; // ISO datetime: YYYY-MM-DDTHH:mm:ss.SSS
  modifiedTo?: string;
  page: number;
  pageSize: number;
}

// Feltnavn verifisert mot ekte respons via tdsynnex-debug-raw 2026-09-01 —
// se CLAUDE.md. Avviker på flere punkter fra det som opprinnelig ble antatt
// (bl.a. produktlisten ligger under "data", ikke "products").
interface TDSynnexProduct {
  tdsynnexPartNumber?: string;
  manufPartNumber?: string;
  upcEan?: string;
  manufacturer?: string;
  productDescription?: string;
  // isPhysicalProduct FINNES KUN i respons på søk via tdsynnexPartNumber —
  // bekreftet fraværende 2026-09-13 i respons på manufPartNumber-søk (det
  // produksjonsstien faktisk bruker, se fetchTDSynnexByMPN), som gjorde et
  // tidligere forsøk på å bruke dette feltet til ingenting: feltet er alltid
  // undefined der, så filteret `=== false` aldri traff. IKKE stol på dette
  // feltet alene — se classDesc/subclassDesc-sjekken i mapProduct i stedet,
  // som er bekreftet til stede i BEGGE søketypene. Feltet beholdes her kun
  // for dokumentasjonens skyld / i tilfelle et fremtidig tdsynnexPartNumber-
  // basert kall vil ha nytte av det.
  isPhysicalProduct?: boolean;
  family?: string;
  familyDesc?: string;
  class?: string;
  classDesc?: string;
  subclass?: string;
  subclassDesc?: string;
  price?: {
    currencyCode?: string;
    listPrice?: number;
    customerPrice?: number;
  };
  stock?: {
    quantityAvailableTotal?: number;
    quantityAvailableLocal?: number;
    quantityIncomingTotal?: number;
    quantityIncomingByDate?: Array<{
      arrivalDate?: string;
      quantityIncoming?: number;
      status?: string;
    }>;
  };
}

async function callCatalogueAPI(body: TDSynnexCatalogueRequest): Promise<TDSynnexProduct[]> {
  const accessToken = await getAccessToken();

  const resp = await fetch(CATALOGUE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-NO',
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    throw new Error(
      'TD Synnex: Uautorisert. Sjekk at TDSYNNEX_CLIENT_ID/TDSYNNEX_CLIENT_SECRET er gyldige og at API-tilgang er aktivert.'
    );
  }
  if (resp.status === 429) {
    throw new Error('TD Synnex: Rate limit nådd. Reduser hyppigheten på API-kall.');
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`TD Synnex API feil (HTTP ${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return (data.data as TDSynnexProduct[]) ?? [];
}

/**
 * Diagnostikk: viser den fullstendige, rå HTTP-responsen fra catalogue-
 * endepunktet — status, headere og hele JSON-kroppen, uten noen
 * post-prosessering/filtrering. Til bruk når TD Synnex sitt API-team ber om
 * å se nøyaktig hva vi mottar (ikke bare vårt eget tolkede resultat).
 */
export async function dumpTDSynnexRawResponse(body: TDSynnexCatalogueRequest): Promise<void> {
  const accessToken = await getAccessToken();

  console.log(`[TDSynnex] Endepunkt: ${CATALOGUE_ENDPOINT}`);
  console.log(`[TDSynnex] Request body: ${JSON.stringify(body)}`);

  const resp = await fetch(CATALOGUE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-NO',
    },
    body: JSON.stringify(body),
  });

  console.log(`[TDSynnex] HTTP status: ${resp.status} ${resp.statusText}`);
  console.log('[TDSynnex] Response headers:');
  resp.headers.forEach((value, key) => console.log(`  ${key}: ${value}`));

  const text = await resp.text();
  console.log('[TDSynnex] Rå response body:');
  console.log(text);
}

// Tjeneste-/support-/lisens-/logistikk-kategorier bekreftet i TD Synnex sin
// egen class/subclass-taksonomi 2026-09-13 (f.eks. class "COMACCSER",
// classDesc/subclassDesc "Datamaskiner - service & support" for MPN
// 5WS1E21226, "<= 3 Months Premium Care") — til stede i BÅDE
// tdsynnexPartNumber- og manufPartNumber-baserte søk, i motsetning til
// isPhysicalProduct (se feltkommentar på TDSynnexProduct).
const NON_PHYSICAL_CATEGORY = /service|support|warranty|licens|subscription|abonnement/i;

// Eksakte navnemønstre fra de 21 kjente søppel-radene fra mode=full-hendelsen
// 2026-09-01 (se CLAUDE.md) — beholdt som ekstra sikkerhetsnett i tillegg til
// kategori-sjekken over, siden vi allerede vet nøyaktig hvordan disse ser ut.
const NON_PHYSICAL_NAME = /premium care|\bDOA\b|mail-in\/cci|^EDI |dummy|^CFS -|autopilot|self registration|file will be provided/i;

// BTO-/CTO-konfigurasjonsvalg — velges ved BESTILLING av en spesifikk
// arbeidsstasjon/PC ("vil du ha en ekstra CPU? en ekstra LAN-port? 3 års
// service?"), ikke et selvstendig produkt noen søker etter og kjøper alene.
// Oppdaget 2026-09-14/15: 15 slike rader (alle HP/Lenovo, alle skjulte) ble
// funnet manuelt i "Ikke kategorisert" og slettet — se CLAUDE.md. Eksempler:
// "1.8 GHz - 8-core... - 2. CPU - for Workstation Z8 G4",
// "(1 år) - for ThinkReality A3", "3Y Tech Install CRU Add On",
// "LAN-port - for Workstation Z2 G5...".
const BTO_OPTION_NAME =
  /- \d+\. (CPU|GPU|Grafikkort|Prosessor)\b|^\(?\d+ ?(år|year|mnd|month)s?\)?( |-|$)|\bAdd[- ]?On\b|Tech Install|CRU Add|Sealed Battery|^(LAN|Seriell|Parallell)-port - for|^\d+\s*x\s*(USB|HDMI|DP|DisplayPort).*-port - for|^\d+GbE.*-port - for/i;

// Rene interne komponenter (SSD, RAM-moduler, skjermkort, batterier) —
// Besluttet 2026-09-15 at disse ikke skal i katalogen: shop.impero.no selger
// komplette enheter, ikke løse deler, og de skaper bare støy i
// "Ikke kategorisert" (~1000 rader observert, en stor andel av denne typen).
// Ankret på START av navnet — en full PC/workstation som NEVNER "512 GB SSD
// NVMe" midt i sin egen spesifikasjon skal IKKE fanges av dette, kun rader
// der selve produktet ER komponenten (f.eks. "SSD - 256 GB - intern - ...",
// "DDR5 - modul - 48 GB - ...", "Grafikkort - RTX 5880 Ada - ...",
// "Batteri til bærbar PC - ...").
const STANDALONE_COMPONENT_NAME = /^(SSD\b|DDR\d|LPDDR\d\w*\s*SDRAM|Grafikkort\b|Batteri\b)/i;

function mapProduct(p: TDSynnexProduct): SupplierProduct | null {
  const mpn = p.manufPartNumber;
  if (!mpn) return null;

  // Hopp over tjenester/lisenser/logistikk-koder, BTO-konfigurasjonsvalg og
  // løse komponenter — se konstantene over. isPhysicalProduct er IKKE brukt
  // her (se feltkommentar på TDSynnexProduct: feltet mangler i
  // manufPartNumber-baserte søk, som er det denne funksjonen faktisk mottar
  // data fra i produksjon).
  const category = `${p.classDesc ?? ''} ${p.subclassDesc ?? ''}`;
  const name = p.productDescription ?? '';
  if (
    NON_PHYSICAL_CATEGORY.test(category) ||
    NON_PHYSICAL_NAME.test(name) ||
    BTO_OPTION_NAME.test(name) ||
    STANDALONE_COMPONENT_NAME.test(name)
  ) {
    return null;
  }

  // Tidligste innkommende leveranse, hvis noen — stock.quantityIncomingByDate
  // er en liste over separate batcher, ikke ett enkelt nextAvailableDate-felt.
  const nextDelivery = p.stock?.quantityIncomingByDate
    ?.filter(b => b.arrivalDate)
    .sort((a, b) => (a.arrivalDate! < b.arrivalDate! ? -1 : 1))[0];

  return {
    mpn,
    ean: p.upcEan || null,
    supplier: 'tdsynnex',
    supplier_sku: p.tdsynnexPartNumber || undefined,
    manufacturer: p.manufacturer || undefined,
    name: p.productDescription || mpn,
    source_text: p.productDescription || undefined,
    // customerPrice er vår faktiske reseller-pris (ekskl. mva) — listPrice er
    // en høyere referansepris, ikke det vi faktisk betaler.
    price_ex_vat: p.price?.customerPrice ?? null,
    available_qty: p.stock?.quantityAvailableTotal ?? 0,
    next_delivery_date: nextDelivery?.arrivalDate?.slice(0, 10) || null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Full sync: henter alle aktive produkter per produsent.
 * Kjøres ukentlig.
 */
export async function fetchTDSynnexFull(): Promise<SupplierProduct[]> {
  return fetchTDSynnexByManufacturers(MANUFACTURERS);
}

/**
 * Som fetchTDSynnexFull, men for et valgfritt delsett av produsenter — brukt
 * 2026-09-13 til å forsøke å matche manuelt kuraterte Produktutvalg-produkter
 * (ingen mpn/ean registrert siden de aldri gikk via den automatiske
 * leverandør-synken, se CLAUDE.md) mot TD Synnex sin katalog for de aktuelle
 * produsentene, i stedet for å skanne alle 8.
 *
 * ⚠️ 10 000-rads-cap oppdaget 2026-09-13: et usortert manufacturer-only-søk
 * mot Apple stoppet nøyaktig på "10000 produkter hentet" (100 sider × 100)
 * og manglet FLERE kjente, ekte MacBook-SKUer (bl.a. hele MacBook Air-
 * utvalget) — API-et returnerer altså ikke garantert alt for en stor
 * produsent innenfor dette repoets sidevindu. Bruk `classFilter`/
 * `subclassFilter` (se fetchTDSynnexNotebooks under) for å begrense
 * spørringen til en kategori i stedet, når et fullstendig resultat trengs.
 */
export async function fetchTDSynnexByManufacturers(
  manufacturers: string[],
  classFilter?: { class: string; subclass?: string }
): Promise<SupplierProduct[]> {
  const results: SupplierProduct[] = [];

  for (const manufacturer of manufacturers) {
    console.log(`[TDSynnex] Full sync: ${manufacturer}${classFilter ? ` (class=${classFilter.class}${classFilter.subclass ? `, subclass=${classFilter.subclass}` : ''})` : ''}...`);
    let page = 1;
    let totalFetched = 0;

    while (true) {
      const products = await callCatalogueAPI({
        manufacturer,
        class: classFilter?.class,
        subclass: classFilter?.subclass,
        productStatusCode: 'Active',
        includePrice: true,
        includeStock: true,
        onlyInStock: false,
        page,
        pageSize: 100,
      });

      const mapped = products.map(mapProduct).filter((p): p is SupplierProduct => p !== null);
      results.push(...mapped);
      totalFetched += products.length;

      if (products.length < 100) break; // Siste side
      page++;

      // Rate limiting: 0,5 sek mellom kall
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[TDSynnex] ${manufacturer}: ${totalFetched} produkter hentet`);
    await new Promise(r => setTimeout(r, 1000)); // 1 sek mellom produsenter
  }

  console.log(`[TDSynnex] Full sync ferdig: ${results.length} produkter totalt`);
  return results;
}

/**
 * Delta sync: henter kun produkter endret siden angitt dato.
 * Kjøres daglig. Mye raskere enn full sync.
 *
 * NB: TD Synnex definerer "modifikasjon" som lager-endringer.
 * Prisendringer er IKKE inkludert i delta. Kjør full sync ukentlig for priser.
 */
export async function fetchTDSynnexDelta(since?: Date): Promise<SupplierProduct[]> {
  const sinceDate = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // i går
  const modifiedFrom = sinceDate.toISOString().replace('Z', '').slice(0, 23); // YYYY-MM-DDTHH:mm:ss.SSS

  console.log(`[TDSynnex] Delta sync fra: ${modifiedFrom}`);

  // TD Synnex krever at minst ett søkeparameter (f.eks. manufacturer) er satt —
  // "One search parameter is obligatory". modifiedFrom alene holder ikke, i
  // motsetning til det dokumentasjonen antyder. Løkke per produsent, samme
  // mønster som fetchTDSynnexFull, med modifiedFrom som tilleggsfilter.
  // Bekreftet nødvendig via HTTP 400 i produksjon 2026-09-01 — se CLAUDE.md.
  const results: SupplierProduct[] = [];

  for (const manufacturer of MANUFACTURERS) {
    let page = 1;
    let totalFetched = 0;

    while (true) {
      const products = await callCatalogueAPI({
        manufacturer,
        modifiedFrom,
        productStatusCode: 'Active',
        includePrice: true,
        includeStock: true,
        page,
        pageSize: 100,
      });

      const mapped = products.map(mapProduct).filter((p): p is SupplierProduct => p !== null);
      results.push(...mapped);
      totalFetched += products.length;

      if (products.length < 100) break;
      page++;
      await new Promise(r => setTimeout(r, 500));
    }

    if (totalFetched > 0) {
      console.log(`[TDSynnex] ${manufacturer}: ${totalFetched} endrede produkter`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[TDSynnex] Delta sync: ${results.length} endrede produkter totalt`);
  return results;
}

/**
 * Spot-oppslag: hent ett konkret produkt på MPN.
 * Nyttig for ordrebekreftelse / live prissjekk.
 */
export async function fetchTDSynnexByMPN(mpns: string[]): Promise<SupplierProduct[]> {
  if (mpns.length > 50) {
    throw new Error('TD Synnex MPN-oppslag: maks 50 MPN per kall');
  }

  const products = await callCatalogueAPI({
    manufPartNumber: mpns,
    includePrice: true,
    includeStock: true,
    page: 1,
    pageSize: 100,
  });

  return products.map(mapProduct).filter((p): p is SupplierProduct => p !== null);
}

/**
 * Henter TD Synnex-priser kun for MPN-er som allerede finnes i den kuraterte
 * produktkatalogen (hentet via price-sync-mpns), i stedet for å skanne hele
 * produsent-kataloger. Batcher i grupper på 50 (API-grensen for
 * manufPartNumber per kall — se fetchTDSynnexByMPN).
 *
 * Standard daglig metode fra 2026-09-01: en full katalog-skann av 8
 * produsenter ga 22 200+ produkter og rakk ikke gjennom price-sync på 3
 * timer. Siden nettbutikken uansett bare skal vise et kuratert utvalg, gir
 * det ingen mening å synkronisere priser for produkter som aldri blir
 * publisert — så vi spør TD Synnex spesifikt om det vi faktisk har, som
 * skalerer med katalogstørrelsen vår, ikke leverandørens. Se CLAUDE.md.
 */
export async function fetchTDSynnexForKnownMpns(mpns: string[]): Promise<SupplierProduct[]> {
  const results: SupplierProduct[] = [];
  const BATCH = 50;

  for (let i = 0; i < mpns.length; i += BATCH) {
    const chunk = mpns.slice(i, i + BATCH);
    const mapped = await fetchTDSynnexByMPN(chunk);
    results.push(...mapped);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[TDSynnex] Kjente MPN-er: ${results.length} av ${mpns.length} funnet hos TD Synnex`);
  return results;
}

/**
 * Spot-oppslag på TD Synnex sitt eget varenummer (ikke manufPartNumber).
 * Diagnostikk: TD Synnex sitt API-team bekreftet at søk på tdsynnexPartNumber
 * fungerer for et kjent produkt (SKU 11965702) — dette tester om det samme
 * gjelder med våre egne credentials, og om manufPartNumber-søket er det som
 * faktisk feiler. Se CLAUDE.md.
 */
export async function fetchTDSynnexByTDPartNumber(tdsynnexPartNumbers: string[]): Promise<SupplierProduct[]> {
  if (tdsynnexPartNumbers.length > 50) {
    throw new Error('TD Synnex varenummer-oppslag: maks 50 per kall');
  }

  const products = await callCatalogueAPI({
    tdsynnexPartNumber: tdsynnexPartNumbers,
    page: 1,
    pageSize: 50,
  });

  return products.map(mapProduct).filter((p): p is SupplierProduct => p !== null);
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('tdsynnex.ts')) {
  const mode = process.argv[2] ?? 'delta';
  const products = mode === 'full' ? await fetchTDSynnexFull() : await fetchTDSynnexDelta();
  console.log(`[TDSynnex] Eksempel (første produkt):`, JSON.stringify(products[0], null, 2));
}
