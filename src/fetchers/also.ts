/**
 * ALSO Norge — SFTP Prisfil (XML 2.40)
 *
 * Laster ned pricelist-1.txt.zip via autentisert HTTPS,
 * pakker ut og parser tab-separert fil.
 *
 * Sesjon-cookie hentes fra ALSO_SESSION_COOKIE miljøvariabel (GitHub Secret).
 * Cookie fornyes manuelt eller via Playwright-session-renewal-workflow.
 *
 * Filen har INGEN header-rad — det er et rent posisjonelt format (fant ingen
 * offentlig spesifikasjon for "2.40"). Kolonneposisjonene under er verifisert
 * mot 5 ekte rader 2026-09-01 via `also-debug`-modus, se CLAUDE.md. Filen er
 * dessuten Windows-1252-kodet, ikke UTF-8 (æøå ble mojibake med naiv
 * string-dekoding).
 */

import JSZip from 'jszip';
import type { SupplierProduct } from '../types.ts';

const ALSO_PRISFIL_URL =
  'https://www.also.com/ec/cms5/2900/pricelistView.do?todo=download&filename=pricelist-1.txt.zip';

const ALSO_SESSION_COOKIE = process.env.ALSO_SESSION_COOKIE;

async function downloadAndExtractPrisfil(): Promise<string[]> {
  if (!ALSO_SESSION_COOKIE) {
    throw new Error('ALSO_SESSION_COOKIE er ikke satt som miljøvariabel / GitHub Secret');
  }

  console.log('[ALSO] Laster ned prisfil...');

  const resp = await fetch(ALSO_PRISFIL_URL, {
    headers: {
      Cookie: ALSO_SESSION_COOKIE,
      'User-Agent': 'Mozilla/5.0 (compatible; ImperoBot/1.0; +https://shop.impero.no)',
    },
  });

  if (!resp.ok) {
    if (resp.status === 302 || resp.status === 401) {
      throw new Error(
        `ALSO: Sesjon utløpt (HTTP ${resp.status}). Oppdater ALSO_SESSION_COOKIE i GitHub Secrets.`
      );
    }
    throw new Error(`ALSO: HTTP-feil ${resp.status} ved nedlasting av prisfil`);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('zip') && !contentType.includes('octet-stream')) {
    // Sannsynligvis redirect til innloggingssiden
    const text = await resp.text();
    if (text.includes('weblogin.also.com') || text.includes('login')) {
      throw new Error('ALSO: Sesjon utløpt — redirect til login-side. Oppdater ALSO_SESSION_COOKIE.');
    }
    throw new Error(`ALSO: Uventet content-type: ${contentType}`);
  }

  const zipBuffer = await resp.arrayBuffer();
  console.log(`[ALSO] ZIP lastet ned: ${(zipBuffer.byteLength / 1024).toFixed(0)} KB`);

  // Pakk ut ZIP
  const zip = await JSZip.loadAsync(zipBuffer);
  const fileName = Object.keys(zip.files).find(f => f.endsWith('.txt'));
  if (!fileName) {
    throw new Error('ALSO: Ingen .txt-fil funnet i ZIP-arkivet');
  }

  // Filen er Windows-1252-kodet — .async('string') ville dekodet som UTF-8
  // og ødelagt æøå (bekreftet mojibake på "Tilbehør"/"Trådløs" 2026-09-01).
  const txtBytes = await zip.files[fileName].async('uint8array');
  const txtContent = new TextDecoder('windows-1252').decode(txtBytes);
  return txtContent.split('\n').filter(l => l.trim());
}

// Kolonneposisjoner i prisfilen — ingen header-rad, ren posisjonell tab-separert
// fil. Verifisert mot ekte data (se filkommentar øverst).
const COL = {
  PRODUCT_ID: 0,
  MPN: 1,
  MANUFACTURER: 2,
  CATEGORY_1: 3,
  CATEGORY_2: 4,
  CATEGORY_3: 5,
  SHORT_DESCRIPTION: 6,
  DESCRIPTION: 7,
  NET_PRICE: 8,
  AVAILABLE_QTY: 9,
  NEXT_DELIVERY_DATE: 10, // YYYYMMDD
  NEXT_DELIVERY_QTY: 11,
  // [12] uidentifisert, tom i alle observerte rader
  EAN: 13,
} as const;

function formatAlsoDate(raw: string | undefined): string | null {
  if (!raw || raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Diagnostikk: dump de N første radene, felt for felt med indeks, slik at
 * kolonneposisjonene i ALSO sin prisfil kan verifiseres mot ekte data i
 * stedet for å anta et navngitt header-format.
 */
export async function dumpAlsoRawSample(sampleSize = 5): Promise<void> {
  const lines = await downloadAndExtractPrisfil();
  console.log(`[ALSO] Totalt ${lines.length} linjer i filen`);
  for (const line of lines.slice(0, sampleSize)) {
    const fields = line.split('\t');
    console.log(`\n[ALSO] Rad med ${fields.length} felt:`);
    fields.forEach((f, i) => console.log(`  [${i}] ${f}`));
  }
}

export async function fetchAlsoPrisfil(): Promise<SupplierProduct[]> {
  const lines = await downloadAndExtractPrisfil();

  if (lines.length < 1) {
    throw new Error('ALSO: Prisfil er tom');
  }

  const products: SupplierProduct[] = [];
  let skipped = 0;

  for (const line of lines) {
    const cols = line.split('\t').map(c => c.trim());

    const mpn = cols[COL.MPN];
    if (!mpn) {
      skipped++;
      continue;
    }

    const priceStr = cols[COL.NET_PRICE];
    const price = priceStr ? parseFloat(priceStr.replace(',', '.')) : null;

    const qtyStr = cols[COL.AVAILABLE_QTY];
    const qty = qtyStr ? parseInt(qtyStr, 10) : 0;

    products.push({
      mpn,
      ean: cols[COL.EAN] || null,
      supplier: 'also',
      supplier_sku: cols[COL.PRODUCT_ID] || undefined,
      manufacturer: cols[COL.MANUFACTURER] || undefined,
      name: cols[COL.SHORT_DESCRIPTION] || cols[COL.DESCRIPTION] || mpn,
      // Begge feltene kombinert (ikke bare den som "vant" over) — trengs av
      // tastaturoppsett-nøkkelordsøket i enrichProducts, som ellers ville gått
      // glipp av teksten i det feltet `name` IKKE endte opp med å bruke.
      source_text: [cols[COL.SHORT_DESCRIPTION], cols[COL.DESCRIPTION]].filter(Boolean).join(' ') || undefined,
      price_ex_vat: Number.isFinite(price) ? price : null,
      available_qty: Number.isFinite(qty) ? qty : 0,
      next_delivery_date: formatAlsoDate(cols[COL.NEXT_DELIVERY_DATE]),
      category1: cols[COL.CATEGORY_1] || undefined,
      category2: cols[COL.CATEGORY_2] || undefined,
      updated_at: new Date().toISOString(),
    });
  }

  console.log(
    `[ALSO] Parsert ${products.length} produkter (${skipped} rader uten MPN hoppet over)`
  );

  return products;
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('also.ts')) {
  const products = await fetchAlsoPrisfil();
  console.log(`[ALSO] Eksempel (første produkt):`, JSON.stringify(products[0], null, 2));
}
