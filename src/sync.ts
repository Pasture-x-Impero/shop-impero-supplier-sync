/**
 * Hoved-synk-script for impero-price-sync
 *
 * Kjøres daglig av to separate GitHub Actions-workflows, én per leverandør
 * (tdsynnex-sync.yml, also-sync.yml — splittet fra tidligere daily-sync.yml
 * 2026-09-12 nettopp for at hver leverandørs status skal være synlig
 * uavhengig av den andre i Actions-fanen, se CLAUDE.md). isicom-sync.yml
 * finnes også, men uten schedule — kun manuell trigger.
 *
 * Henter innkjøpspriser fra leverandører og oppdaterer product_supplier_prices
 * i Supabase (shop.impero.no sitt eget, Lovable-styrte skjema).
 *
 * Miljøvariabler (GitHub Secrets):
 *   SUPABASE_URL                  — Supabase prosjekt-URL
 *   SUPABASE_SERVICE_ROLE_KEY     — Service role nøkkel (ikke anon!)
 *   ALSO_SESSION_COOKIE           — ALSO innkjøpsportal sesjon-cookie
 *   TDSYNNEX_CLIENT_ID             — TD Synnex Digital Bridge OAuth2 client ID
 *   TDSYNNEX_CLIENT_SECRET         — TD Synnex Digital Bridge OAuth2 client secret
 *   ISICOM_SESSION_COOKIE         — isicom.no PrestaShop sesjon-cookie (kun for mode=isicom)
 *
 * Argumenter:
 *   node sync.ts also       → Kun ALSO (kjøres av also-sync.yml). ALSO har
 *                             ingen "kun endret"-modus — leverandøren sender
 *                             alltid hele prisfilen sin, uansett. Filtreres
 *                             til kun MPN-er som allerede er kuratert i
 *                             products (samme prinsipp som TD Synnex under)
 *                             — uten dette lager price-sync et nytt skjult
 *                             produkt for ALT i hele ALSO-katalogen som
 *                             matcher en kjent produsent, hver eneste dag.
 *                             Fikset 2026-09-12, se CLAUDE.md.
 *   node sync.ts tdsynnex   → Kun TD Synnex, kun MPN-er som allerede er
 *                             kuratert i products (via price-sync-mpns), ikke
 *                             hele produsent-kataloger — se CLAUDE.md for
 *                             hvorfor. Kjøres av tdsynnex-sync.yml.
 *   node sync.ts full       → Kun TD Synnex sin BREDE produsent-skann
 *                             (fetchTDSynnexFull) — kan ta timer, kun for
 *                             manuell/sjelden oppdagelse av nye produkter.
 *                             Rører ALDRI ALSO (se punktet over for hvorfor
 *                             det uansett ikke ville gjort noen forskjell).
 *   node sync.ts delta      → Lokal bekvemmelighet: ALSO + TD Synnex (kjente
 *                             MPN-er) i én kommando. Ingen workflow bruker
 *                             denne lenger, men `npm run sync` defaulter
 *                             fortsatt til den for manuell lokal bruk.
 *   node sync.ts isicom     → Kun isicom.no (lav prioritet, kun ved eksplisitt forespørsel — se CLAUDE.md)
 *   node sync.ts tdsynnex-discover <produsent> [filter] [class:subclass] [include-cto]
 *                           → Diagnostikk, skriver ALDRI til DB: full katalog-
 *                             oppslag for ÉN produsent (default Apple), valgfritt
 *                             filtrert på et ord i produktnavnet (f.eks. "MacBook")
 *                             og/eller et class:subclass-par (f.eks.
 *                             "COMPORT:NOTEBOOKS" — se fetchTDSynnexByManufacturers
 *                             sin filkommentar: et rent manufacturer-søk mot Apple
 *                             traff en 10 000-rads-cap og MANGLET kjente ekte
 *                             SKU-er, class/subclass-filter unngår dette).
 *                             Brukt til å se hva TD Synnex faktisk fører FØR man
 *                             kuraterer inn flere varianter i Produktutvalg.
 *   node sync.ts icecat-debug <mpn> [manufacturer] [ean]
 *                           → Diagnostikk, skriver ALDRI til DB/cache: kjører
 *                             kun Icecat-oppslag + navn/specs-normalisering
 *                             for ÉN MPN og printer resultatet. Se
 *                             src/enrichment/ og planen (zazzy-splashing-lemon.md).
 *
 * Markedspris-synk (Eplehuset/Dustin) er utsatt — market_prices-tabellen
 * finnes ikke i Supabase enda. Se CLAUDE.md.
 */

import { fetchAlsoPrisfil, dumpAlsoRawSample } from './fetchers/also.ts';
import {
  fetchTDSynnexFull,
  fetchTDSynnexForKnownMpns,
  fetchTDSynnexByMPN,
  fetchTDSynnexByTDPartNumber,
  fetchTDSynnexByManufacturers,
  dumpTDSynnexRawResponse,
} from './fetchers/tdsynnex.ts';
import { fetchIsicomProducts } from './fetchers/isicom.ts';
import { syncSupplierPrices, getKnownMpns } from './supabase.ts';
import { enrichProducts } from './enrichment/index.ts';
import { lookupIcecatProduct } from './enrichment/icecat.ts';
import { shortenName, buildSpecs, isMeaningfulModelName } from './enrichment/normalize.ts';
import { lookupCompetitorName } from './enrichment/competitor-name.ts';
import type { SupplierSyncResult } from './types.ts';

function logEnrichment(label: string, enriched: number, enrichedViaCompetitor: number, missing: number, errors: number) {
  const viaCompetitorSuffix = enrichedViaCompetitor > 0 ? ` (${enrichedViaCompetitor} via Power/Komplett/Dustin)` : '';
  console.log(`[${label}] Icecat-berikelse: ${enriched} berørt${viaCompetitorSuffix}, ${missing} uten treff, ${errors} feilet`);
}

const mode = process.argv[2] ?? 'delta';

console.log(`\n🚀 impero-price-sync — modus: ${mode}`);
console.log(`📅 Kjøretidspunkt: ${new Date().toISOString()}\n`);

const results: SupplierSyncResult[] = [];

function failedResult(supplier: string, err: unknown): SupplierSyncResult {
  return {
    supplier,
    productsUpdated: 0,
    productsCreated: 0,
    productsSkipped: 0,
    errors: [err instanceof Error ? err.message : String(err)],
    duration_ms: 0,
  };
}

function printResult(label: string, result: SupplierSyncResult) {
  const status = result.errors.length ? '❌' : '✅';
  console.log(
    `${status} ${label}: ${result.productsUpdated} oppdatert, ${result.productsCreated} nye (skjulte), ${result.productsSkipped} hoppet over (${result.duration_ms}ms)`
  );
  result.errors.forEach(e => console.error(`    Feil: ${e}`));
}

// ────────────────────────────────
// ALSO
// ────────────────────────────────
if (['delta', 'also'].includes(mode)) {
  console.log('━━━ ALSO ━━━');
  try {
    const allProducts = await fetchAlsoPrisfil();
    // ALSO har ingen "kun kjente MPN-er"-spørring slik TD Synnex har (se
    // fetchTDSynnexForKnownMpns) — leverandøren sender alltid HELE katalogen
    // sin, uansett. Uten dette filteret ville ethvert ALSO-produkt fra en
    // kjent produsent (Lenovo, Logitech, Samsung, Philips, ...) som ikke
    // allerede er kuratert i products blitt opprettet som et nytt skjult
    // produkt her — samme type forurensning som TD Synnex sin mode=full
    // forårsaket 2026-09-01 (se CLAUDE.md), bare at det ville skjedd på nytt
    // hver eneste dag ALSO synker i stedet for å være en engangshendelse.
    // Fant 460 slike rader (2026-09-12) fra én enkelt vellykket ALSO-kjøring
    // 2026-09-01, før cookien utløp og stanset videre vekst.
    const knownMpns = new Set(await getKnownMpns());
    const products = allProducts.filter(p => knownMpns.has(p.mpn));
    console.log(
      `[ALSO] ${products.length} av ${allProducts.length} produkter i prisfilen er allerede kuratert i products — synker kun disse.`
    );
    const { items: enrichedProducts, enriched, enrichedViaCompetitor, missing, errors: enrichErrors } = await enrichProducts(products);
    logEnrichment('ALSO', enriched, enrichedViaCompetitor, missing, enrichErrors);
    const result = await syncSupplierPrices('also', enrichedProducts);
    results.push(result);
    printResult('ALSO', result);
  } catch (err) {
    console.error('❌ ALSO feilet før synk kunne starte:', err);
    results.push(failedResult('also', err));
  }
  console.log();
}

// ────────────────────────────────
// TD Synnex
// ────────────────────────────────
if (['full', 'delta', 'tdsynnex'].includes(mode)) {
  console.log('━━━ TD Synnex ━━━');
  try {
    // Standard: kun MPN-er som allerede er kuratert i products (se
    // fetchTDSynnexForKnownMpns). mode=full gjør i stedet den brede
    // produsent-skannen (fetchTDSynnexFull) — se filkommentar øverst.
    const products =
      mode === 'full' ? await fetchTDSynnexFull() : await fetchTDSynnexForKnownMpns(await getKnownMpns());
    const { items: enrichedProducts, enriched, enrichedViaCompetitor, missing, errors: enrichErrors } = await enrichProducts(products);
    logEnrichment('TD Synnex', enriched, enrichedViaCompetitor, missing, enrichErrors);
    const result = await syncSupplierPrices('tdsynnex', enrichedProducts);
    results.push(result);
    printResult('TD Synnex', result);
  } catch (err) {
    console.error('❌ TD Synnex feilet før synk kunne starte:', err);
    results.push(failedResult('tdsynnex', err));
  }
  console.log();
}

// ────────────────────────────────
// Diagnostikk: sjekk price-sync-mpns i isolasjon før den brukes i en ekte
// TD Synnex-kjøring. Skriver ikke til DB.
// ────────────────────────────────
if (mode === 'mpns-debug') {
  console.log('━━━ price-sync-mpns rå-dump ━━━');
  try {
    const mpns = await getKnownMpns();
    console.log(`Fant ${mpns.length} kuraterte MPN-er:`);
    console.log(JSON.stringify(mpns.slice(0, 20), null, 2));
    if (mpns.length > 20) console.log(`... og ${mpns.length - 20} til`);
  } catch (err) {
    console.error('❌ price-sync-mpns feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// ────────────────────────────────
// ALSO rå-dump — diagnostikk, skriver ikke til DB. Se CLAUDE.md for hvorfor.
// ────────────────────────────────
if (mode === 'also-debug') {
  console.log('━━━ ALSO rå-dump ━━━');
  try {
    await dumpAlsoRawSample(5);
  } catch (err) {
    console.error('❌ ALSO rå-dump feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// ────────────────────────────────
// TD Synnex spot-oppslag på kjent MPN — diagnostikk, skriver ikke til DB.
// Brukes til å verifisere at et produkt vi VET finnes (bekreftet i InTouch)
// faktisk kommer tilbake fra catalogue-endepunktet.
// ────────────────────────────────
if (mode === 'tdsynnex-debug') {
  // `||` ikke `??`: et utelatt workflow_dispatch-input kommer nå som en
  // sitert tom streng, ikke undefined (se tdsynnex-sync.yml sin
  // sitering-kommentar) — `??` fanger ikke opp det.
  const mpn = process.argv[3] || 'MDE34H/A';
  console.log(`━━━ TD Synnex spot-oppslag (manufPartNumber): ${mpn} ━━━`);
  try {
    const products = await fetchTDSynnexByMPN([mpn]);
    console.log(`Fant ${products.length} produkt(er):`);
    console.log(JSON.stringify(products, null, 2));
  } catch (err) {
    console.error('❌ Spot-oppslag feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'tdsynnex-debug-raw') {
  const tdPartNumber = process.argv[3] || '11965702';
  console.log(`━━━ TD Synnex RÅ respons (tdsynnexPartNumber): ${tdPartNumber} ━━━`);
  try {
    await dumpTDSynnexRawResponse({
      tdsynnexPartNumber: [tdPartNumber],
      includePrice: true,
      includeStock: true,
      page: 1,
      pageSize: 50,
    });
  } catch (err) {
    console.error('❌ Rå-dump feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// ────────────────────────────────
// Midlertidig diagnostikk 2026-09-12/13: fetchTDSynnexByMPN (den faktiske
// produksjonsstien) søker via manufPartNumber, IKKE tdsynnexPartNumber som
// tdsynnex-debug-raw over gjør — mistanke om at isPhysicalProduct-feltet
// (lagt til i mapProduct 2026-09-12) enten mangler eller har en annen verdi
// når man søker via manufPartNumber, siden 21 service-SKU-er vi nettopp
// slettet ble gjenskapt av en ekte tdsynnex-kjøring rett etter fiksen. Se
// CLAUDE.md.
// ────────────────────────────────
if (mode === 'tdsynnex-debug-raw-mpn') {
  const mpn = process.argv[3] || '5WS1E21226';
  console.log(`━━━ TD Synnex RÅ respons (manufPartNumber, samme spørring som produksjon): ${mpn} ━━━`);
  try {
    await dumpTDSynnexRawResponse({
      manufPartNumber: [mpn],
      includePrice: true,
      includeStock: true,
      page: 1,
      pageSize: 50,
    });
  } catch (err) {
    console.error('❌ Rå-dump feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// Sonde (2026-09-15): finnes det udokumenterte flagg i catalogue-API-et som
// gir bilde-URL/innhold? Sender samme spørring som produksjon pluss en rekke
// "include*"-flagg. Enten dukker nye felt opp i svaret, eller API-et svarer
// 400 med en liste over tillatte felt — begge deler er nyttig informasjon.
// Kun bildehenting (2026-09-15): selve arbeidet gjøres av et eget steg i
// tdsynnex-sync.yml som kaller Lovable sin import-icecat-images-funksjon.
// Denne modusen finnes bare så steget kan trigges/testes uten en full
// TD Synnex-synk foran.
if (mode === 'icecat-images') {
  console.log('🖼️ Modus icecat-images: hopper over leverandør-synk, bildehenting kjøres som eget workflow-steg.');
  process.exit(0);
}

// ────────────────────────────────
// Diagnostikk (2026-09-20): kjør kun Icecat-oppslag + navn/specs-normalisering
// for ÉN MPN, uten å røre cachen eller syncSupplierPrices i det hele tatt.
// Brukt til å visuelt bekrefte berikelses-resultatet før det stoles på i en
// ekte synk — se planen (zazzy-splashing-lemon.md §11).
// Eksempel: node sync.ts icecat-debug A3ZJ3ET#UUW HP 197489946966
// ────────────────────────────────
if (mode === 'icecat-debug') {
  const mpn = process.argv[3];
  const manufacturer = process.argv[4] || undefined;
  const ean = process.argv[5] || undefined;
  if (!mpn) {
    console.error('❌ Oppgi MPN som tredje argument, valgfritt produsent og EAN som fjerde/femte.');
    process.exit(1);
  }
  console.log(`━━━ Icecat-berikelse (kun lesing): mpn=${mpn} manufacturer=${manufacturer ?? '—'} ean=${ean ?? '—'} ━━━`);
  try {
    const result = await lookupIcecatProduct({ ean, manufacturer, mpn });
    let specs: Record<string, string> = {};
    let name: string | null = null;

    if (result.status === 'matched') {
      specs = buildSpecs(result.data, undefined);
      const meaningful = isMeaningfulModelName(result.data.productName, mpn);
      name = meaningful ? shortenName(result.data.productName, result.data.brand || manufacturer, specs) : null;
      console.log(`Icecat productName: ${result.data.productName}`);
      console.log(`Icecat brand: ${result.data.brand}`);
      if (!meaningful) console.log('Icecat sitt navn er ikke meningsfullt (speiler kun MPN) — prøver konkurrent-fallback for selve navnet.');
    } else {
      console.log(`Icecat: ${JSON.stringify(result)} — prøver konkurrent-fallback (Power/Komplett/Dustin) for selve navnet.`);
    }

    if (!name) {
      const competitor = await lookupCompetitorName({ ean, mpn });
      if (competitor) {
        name = competitor.name;
        console.log(`Navn funnet via ${competitor.source}: ${competitor.name}`);
      } else {
        console.log('Ingen av kildene (Icecat, Power, Komplett, Dustin) hadde et navn for dette produktet.');
      }
    } else {
      console.log(`Kort navn: ${name}`);
    }
    console.log(`Specs: ${JSON.stringify(specs, null, 2)}`);
  } catch (err) {
    console.error('❌ Icecat-debug feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'tdsynnex-debug-raw-mpn-extra') {
  const mpn = process.argv[3] || '910-006034';
  console.log(`━━━ TD Synnex RÅ respons med ekstra include-flagg: ${mpn} ━━━`);
  try {
    await dumpTDSynnexRawResponse({
      manufPartNumber: [mpn],
      includePrice: true,
      includeStock: true,
      includeImages: true,
      includeImage: true,
      includeMedia: true,
      includeContent: true,
      includeDescription: true,
      includeAttributes: true,
      includeSpecifications: true,
      includeMarketing: true,
      includeDetails: true,
      includeOutlet: true,
      includeEndUserPrice: true,
      page: 1,
      pageSize: 50,
    } as unknown as Parameters<typeof dumpTDSynnexRawResponse>[0]);
  } catch (err) {
    console.error('❌ Rå-dump feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'tdsynnex-debug-count') {
  const manufacturer = process.argv[3] || 'Microsoft';
  const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const modifiedFrom = sinceDate.toISOString().replace('Z', '').slice(0, 23);
  console.log(`━━━ TD Synnex ekte totalResults for ${manufacturer} (modifiedFrom ${modifiedFrom}) ━━━`);
  try {
    // pageSize=1 — vi vil kun se totalResults/totalPages-metadata, ikke selve dataene.
    await dumpTDSynnexRawResponse({
      manufacturer,
      modifiedFrom,
      productStatusCode: 'Active',
      page: 1,
      pageSize: 1,
    });
  } catch (err) {
    console.error('❌ Telling feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// ────────────────────────────────
// Diagnostikk 2026-09-13: full katalog-oppslag for ETT produsentnavn — kun
// lesing, skriver ALDRI til DB (i motsetning til mode=full, som også kaller
// syncSupplierPrices og dermed oppretter skjulte produkter for alt den
// finner — se advarselen i tdsynnex.ts/CLAUDE.md). Brukt til å se hva
// TD Synnex faktisk fører av f.eks. Apple-varianter FØR man bestemmer om
// flere skal kureres inn i Produktutvalg.
// ────────────────────────────────
if (mode === 'tdsynnex-discover') {
  const manufacturer = process.argv[3] || 'Apple';
  const filter = process.argv[4]; // valgfritt: kun produkter der navnet inneholder denne strengen
  // Valgfritt class/subclass-filter, format "class:subclass" eller bare
  // "class" (f.eks. "COMPORT:NOTEBOOKS" for Apple-notebooks) — se
  // fetchTDSynnexByManufacturers sin filkommentar for hvorfor: et rent
  // manufacturer-søk mot en stor produsent (Apple) traff en 10 000-rads-cap
  // og manglet kjente ekte SKU-er (bl.a. hele MacBook Air-utvalget).
  const classArg = process.argv[5];
  const classFilter = classArg
    ? { class: classArg.split(':')[0], subclass: classArg.split(':')[1] }
    : undefined;
  // "_NO_CTO"/"_CTO"-MPN-er er Apple sine configure-to-order-koder — i praksis
  // uendelige RAM/lagring/tastatur/farge-kombinasjoner Apple bygger på
  // bestilling, ikke faste lagerførte SKU-er. Ekskludert som standard siden de
  // druknet de faktiske faste modellene (117 "MacBook"-treff for Apple var
  // nesten alle CTO-koder) — bruk "include-cto" som sjette argument for å se dem.
  const includeCto = process.argv[6] === 'include-cto';
  console.log(`━━━ TD Synnex full katalog (kun lesing): ${manufacturer} ━━━`);
  try {
    const products = await fetchTDSynnexByManufacturers([manufacturer], classFilter);
    const nameMatches = filter
      ? products.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()))
      : products;
    const ctoCount = nameMatches.filter(p => /_cto$/i.test(p.mpn)).length;
    const filtered = includeCto ? nameMatches : nameMatches.filter(p => !/_cto$/i.test(p.mpn));
    console.log(`\nFant ${products.length} produkter totalt for ${manufacturer}.`);
    if (filter) {
      console.log(
        `${nameMatches.length} matcher "${filter}" (${ctoCount} er configure-to-order-koder${includeCto ? '' : ' — skjult, se "include-cto"-argumentet'}). Viser ${filtered.length}:\n`
      );
    }
    for (const p of filtered.sort((a, b) => (a.price_ex_vat ?? 0) - (b.price_ex_vat ?? 0))) {
      console.log(
        `${p.mpn.padEnd(16)} | ean ${(p.ean ?? '—').padEnd(14)} | ${p.price_ex_vat ?? '—'} kr ekskl. mva | lager ${p.available_qty} | ${p.name}`
      );
    }
  } catch (err) {
    console.error('❌ Katalog-oppslag feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// ────────────────────────────────
// Diagnostikk 2026-09-13: spot-oppslag for FLERE kjente MPN-er samtidig
// (komma-separert), skriver ALDRI til DB. Brukt til å hente EAN/pris/lager
// for en konkret liste kandidat-MPN-er funnet manuelt (f.eks. i InTouch-
// portalen — se CLAUDE.md om 10 000-rads-cap-en som gjør den brede
// tdsynnex-discover-modusen upålitelig for full katalog-kartlegging).
// ────────────────────────────────
if (mode === 'tdsynnex-debug-batch') {
  const mpns = (process.argv[3] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (mpns.length === 0 || mpns.length > 50) {
    console.error('❌ Oppgi 1-50 komma-separerte MPN-er som tredje argument.');
    process.exit(1);
  }
  console.log(`━━━ TD Synnex spot-oppslag (manufPartNumber), ${mpns.length} MPN-er ━━━`);
  try {
    const products = await fetchTDSynnexByMPN(mpns);
    console.log(`\nFant ${products.length} av ${mpns.length}:\n`);
    for (const p of products) {
      console.log(
        `${p.mpn.padEnd(16)} | ean ${(p.ean ?? '—').padEnd(14)} | ${p.price_ex_vat ?? '—'} kr ekskl. mva | lager ${p.available_qty} | ${p.name}`
      );
    }
    const found = new Set(products.map(p => p.mpn.toLowerCase()));
    const missing = mpns.filter(m => !found.has(m.toLowerCase()));
    if (missing.length) console.log(`\n⚠️ Ikke funnet: ${missing.join(', ')}`);
  } catch (err) {
    console.error('❌ Batch-oppslag feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'tdsynnex-debug-tdpn') {
  const tdPartNumber = process.argv[3] || '11965702';
  console.log(`━━━ TD Synnex spot-oppslag (tdsynnexPartNumber): ${tdPartNumber} ━━━`);
  try {
    const products = await fetchTDSynnexByTDPartNumber([tdPartNumber]);
    console.log(`Fant ${products.length} produkt(er):`);
    console.log(JSON.stringify(products, null, 2));
  } catch (err) {
    console.error('❌ Spot-oppslag feilet:', err);
    process.exit(1);
  }
  process.exit(0);
}

// ────────────────────────────────
// isicom.no — kun ved eksplisitt forespørsel (lav prioritet, se CLAUDE.md)
// ────────────────────────────────
if (mode === 'isicom') {
  console.log('━━━ isicom.no ━━━');
  try {
    const products = await fetchIsicomProducts();
    const { items: enrichedProducts, enriched, enrichedViaCompetitor, missing, errors: enrichErrors } = await enrichProducts(products);
    logEnrichment('isicom', enriched, enrichedViaCompetitor, missing, enrichErrors);
    const result = await syncSupplierPrices('isicom', enrichedProducts);
    results.push(result);
    printResult('isicom', result);
  } catch (err) {
    console.error('❌ isicom feilet før synk kunne starte:', err);
    results.push(failedResult('isicom', err));
  }
  console.log();
}

// ────────────────────────────────
// Markedspriser (Eplehuset, Dustin) — utsatt, se CLAUDE.md
// ────────────────────────────────
if (mode === 'market') {
  console.error(
    '⚠️  Markedspris-synk er utsatt — market_prices-tabellen finnes ikke i Supabase enda. Se CLAUDE.md.'
  );
  process.exit(1);
}

// ────────────────────────────────
// Sammendrag
// ────────────────────────────────
console.log('━━━ Sammendrag ━━━');
for (const r of results) {
  const status = r.errors.length ? '❌' : '✅';
  console.log(
    `${status} ${r.supplier.padEnd(10)} | oppdatert ${r.productsUpdated} | nye ${r.productsCreated} | hoppet over ${r.productsSkipped}`
  );
}

const totalErrors = results.flatMap(r => r.errors).length;
if (totalErrors > 0) {
  console.error(`\n⚠️ ${totalErrors} feil totalt — sjekk loggene ovenfor`);
  process.exit(1);
} else {
  console.log('\n✅ Alle leverandører synkronisert uten feil');
}
