import type { SupplierProduct, SupplierSyncResult } from './types.ts';

// Edge Function i shop.impero.no sitt Lovable Cloud-prosjekt gjør selve
// databasearbeidet (matching, auto-opprettelse, price_history osv.) med
// service role internt. Dette scriptet har aldri tilgang til noen
// Supabase-nøkkel — kun en smal, delt hemmelighet som bare kan trigge
// denne ene synk-operasjonen. Se CLAUDE.md for hele resonnementet.
const PRICE_SYNC_URL =
  process.env.PRICE_SYNC_URL ?? 'https://umnxckqgnlohvawvfgzv.supabase.co/functions/v1/price-sync';
const PRICE_SYNC_MPNS_URL =
  process.env.PRICE_SYNC_MPNS_URL ??
  'https://umnxckqgnlohvawvfgzv.supabase.co/functions/v1/price-sync-mpns';
const PRICE_SYNC_SECRET = process.env.PRICE_SYNC_SECRET;

/**
 * Henter MPN-ene til alle kuraterte produkter (uansett is_visible) via det
 * separate, rene leseendepunktet price-sync-mpns. Brukes til å spørre
 * leverandører spesifikt om det vi allerede har i katalogen, i stedet for å
 * skanne hele produsent-kataloger — se fetchTDSynnexForKnownMpns i
 * tdsynnex.ts og CLAUDE.md for bakgrunnen (en full skann tok >3 timer uten å
 * bli ferdig).
 */
export async function getKnownMpns(): Promise<string[]> {
  if (!PRICE_SYNC_SECRET) {
    throw new Error('PRICE_SYNC_SECRET er ikke satt som miljøvariabel / GitHub Secret');
  }

  const resp = await fetch(PRICE_SYNC_MPNS_URL, {
    headers: { 'x-price-sync-secret': PRICE_SYNC_SECRET },
  });

  if (!resp.ok) {
    throw new Error(`price-sync-mpns feilet: HTTP ${resp.status}`);
  }

  const body = await resp.json();
  return Array.isArray(body?.mpns) ? body.mpns : [];
}

// Antall produkter per kall til Edge Function. Satt ned fra 200 til 40
// 2026-09-01 etter at en ekte ALSO-kjøring viste at price-sync behandler
// rader sekvensielt og fikk HTTP 504 (gateway timeout) på 5 av 7 batcher
// à 200 produkter (~17 min total, ~2,5 min per batch — rett på grensen for
// Supabase sin Edge Function-tidsgrense). Reduser videre hvis 504 dukker
// opp igjen, eller be Lovable optimalisere price-sync til bulk-spørringer
// i stedet for én-og-én — se CLAUDE.md.
const BATCH_SIZE = 40;

interface PriceSyncResponse {
  productsUpdated: number;
  productsCreated: number;
  productsSkipped: number;
  errors: string[];
}

function emptyResult(supplier: string, duration_ms: number, errors: string[] = []): SupplierSyncResult {
  return { supplier, productsUpdated: 0, productsCreated: 0, productsSkipped: 0, errors, duration_ms };
}

// run_started_at / finalize (2026-09-15): én synk består av mange batcher
// (BATCH_SIZE), men price-sync sitt "stale stock"-steg (nullstill lager for
// rader som ikke var med i leveransen) må kjøre ÉN gang per synk, ikke én
// gang per batch — ellers nullstiller batch N det batch 1..N-1 nettopp skrev,
// og kun siste batch beholder lager. Derfor sender vi samme run_started_at i
// alle batcher (terskelen for "gammelt"), og finalize=true kun i siste batch
// (signalet om at nullstillingen kan kjøre nå). Se CLAUDE.md "Lagerstatus".
async function callPriceSync(
  supplierKey: SupplierProduct['supplier'],
  batch: ReturnType<typeof toPayloadItem>[],
  runStartedAt: string,
  finalize: boolean
): Promise<PriceSyncResponse> {
  const resp = await fetch(PRICE_SYNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-price-sync-secret': PRICE_SYNC_SECRET!,
    },
    body: JSON.stringify({ supplier: supplierKey, items: batch, run_started_at: runStartedAt, finalize }),
  });

  const body = await resp.json().catch(() => null);

  if (!resp.ok || !body || typeof body !== 'object' || 'error' in body) {
    const message = body && typeof body === 'object' && 'error' in body ? body.error : `HTTP ${resp.status}`;
    throw new Error(`price-sync feilet: ${message}`);
  }

  return body as PriceSyncResponse;
}

function toPayloadItem(item: SupplierProduct) {
  return {
    mpn: item.mpn,
    ean: item.ean ?? null,
    supplier_sku: item.supplier_sku ?? null,
    manufacturer: item.manufacturer ?? null,
    name: item.name,
    // source_name/specs (2026-09-20): satt av enrichProducts() i sync.ts før
    // syncSupplierPrices kalles — se src/enrichment/ og planen
    // (zazzy-splashing-lemon.md). Ukjent for price-sync frem til Lovable-siden
    // er utvidet til å lese dem (egen, senere fase — se CLAUDE.md), men trygt
    // å sende allerede nå: samme mønster som denne funksjonens egen
    // kommentar om at ukjente/urørte felt her historisk har blitt silent
    // droppet av Edge Function-en, ikke avvist.
    source_name: item.source_name ?? item.name,
    specs: item.specs ?? {},
    // image_url (2026-09-22): kun satt av enrichProducts() når en konkurrent
    // (Power/Komplett/Dustin) hadde et bilde og Icecat ikke ga noen bildedata
    // i det hele tatt — IKKE noe dette repoet finner for alle produkter. Som
    // med source_name/specs: price-sync ignorerer den frem til Lovable-siden
    // evt. utvides til å lese den (kun sette products.image_url når det
    // mangler helt fra før — se CLAUDE.md).
    image_url: item.image_url ?? null,
    price_ex_vat: item.price_ex_vat,
    next_delivery_date: item.next_delivery_date ?? null,
    // Lagerantall hos leverandøren — hentet av alle tre fetcherne
    // (also.ts/isicom.ts/tdsynnex.ts) men aldri sendt videre før 2026-09-15,
    // se CLAUDE.md. isicom.ts sitt tall er kun en 0/1-proxy (synlig i
    // listing = tilgjengelig), ikke et reelt antall — ekte kun fra ALSO/TD
    // Synnex.
    available_qty: item.available_qty ?? null,
  };
}

/**
 * Synkroniser innkjøpspriser fra én leverandør via price-sync Edge Function.
 * Se supabase/functions/price-sync i shop.impero.no-prosjektet (Lovable) for
 * selve databaselogikken (matching på mpn, auto-opprettelse av skjulte
 * produkter for kjente produsenter, price_history, price_imports, sync_log,
 * is_preferred-gjenberegning).
 */
export async function syncSupplierPrices(
  supplierKey: SupplierProduct['supplier'],
  items: SupplierProduct[]
): Promise<SupplierSyncResult> {
  const start = Date.now();

  if (!PRICE_SYNC_SECRET) {
    return emptyResult(supplierKey, Date.now() - start, [
      'PRICE_SYNC_SECRET er ikke satt som miljøvariabel / GitHub Secret',
    ]);
  }

  // Rader uten mpn/pris kan ikke synkroniseres i det hele tatt — filtrer
  // dem bort lokalt og tell dem som "skipped" uten å bruke en Edge
  // Function-forespørsel på dem.
  const validItems = items.filter(i => i.mpn && i.price_ex_vat != null);
  const localSkipped = items.length - validItems.length;

  const result: SupplierSyncResult = {
    supplier: supplierKey,
    productsUpdated: 0,
    productsCreated: 0,
    productsSkipped: localSkipped,
    errors: [],
    duration_ms: 0,
  };

  // Felles starttidspunkt for hele synken — se kommentaren over callPriceSync.
  const runStartedAt = new Date().toISOString();
  let anyBatchFailed = false;

  for (let i = 0; i < validItems.length; i += BATCH_SIZE) {
    const batch = validItems.slice(i, i + BATCH_SIZE).map(toPayloadItem);
    const batchNum = i / BATCH_SIZE + 1;
    const totalBatches = Math.ceil(validItems.length / BATCH_SIZE);
    const isLast = i + BATCH_SIZE >= validItems.length;
    // Nullstilling av lager for rader som ikke var med i leveransen skal kun
    // skje når HELE leveransen faktisk kom frem. Feilet en batch (timeout
    // e.l.), fikk ikke de produktene oppdatert lager — å nullstille dem da
    // ville feilaktig vist dem som "Utsolgt". Da hopper vi over finalize og
    // lar neste vellykkede synk rydde opp.
    const finalize = isLast && !anyBatchFailed;
    if (isLast && anyBatchFailed) {
      console.warn(`[${supplierKey}] minst én batch feilet — hopper over lager-nullstilling (finalize) denne kjøringen.`);
    }

    try {
      console.log(`[${supplierKey}] price-sync batch ${batchNum}/${totalBatches} (${batch.length} produkter)${finalize ? ', finalize' : ''}...`);
      const response = await callPriceSync(supplierKey, batch, runStartedAt, finalize);
      result.productsUpdated += response.productsUpdated;
      result.productsCreated += response.productsCreated;
      result.productsSkipped += response.productsSkipped;
      result.errors.push(...response.errors);
    } catch (err) {
      anyBatchFailed = true;
      result.errors.push(`Batch ${batchNum}/${totalBatches}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.duration_ms = Date.now() - start;
  return result;
}
