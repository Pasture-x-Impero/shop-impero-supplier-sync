/**
 * Komplett — konkurrent-pris.
 *
 * Komplett kjører Kasada sin bot-beskyttelse (bekreftet 2026-09-13: en bar
 * `curl`-forespørsel ble avvist på TLS-nivå, HTTP 000 — "Failure with
 * receiving network data", altså før noe HTTP-svar i det hele tatt).
 * OVERRASKENDE: Node sin innebygde `fetch()` (undici) kommer derimot rett
 * gjennom med et ekte 200-svar og full produktdata — ingen Playwright
 * nødvendig her, i motsetning til Elkjøp/Dustin. Fingerprint-forskjellen
 * mellom curl og Node sin TLS-stack er nok hva som avgjør dette; kan slutte
 * å fungere hvis Kasada strammer inn, se filkommentaren i browser-fetch.ts
 * for hvordan man bygger om til Playwright hvis dette skjer.
 *
 * Søk på EAN gir ingen treff (som Elkjøp) — kun MPN fungerer. `/search?q=`
 * redirecter DIREKTE til produktsiden ved eksakt MPN-treff, og blir værende
 * på søke-URL-en (ingen produkt-JSON-LD) ved ingen treff — samme rene
 * signal som Dustin.
 *
 * JSON-LD-blokken har en HTML-entity-kodet type-attributt
 * (`type="application/ld&#x2B;json"` — altså "+" som `&#x2B;`) som en vanlig
 * `type="application/ld+json"`-selector IKKE fanger opp. Bruker i stedet den
 * stabile `id="product-schema-main"`-ankeret.
 *
 * EAN ligger uvanlig plassert i `additionalProperty`-arrayen
 * (`{"name":"EAN","value":"..."}`), ikke som et eget `gtin`/`gtin13`-felt
 * slik Power.no/Elkjøp har det — se CLAUDE.md.
 */

import type { MarketPrice } from '../types.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 800;

interface KomplettOffer {
  price?: string;
  availability?: string;
  url?: string;
}

interface KomplettProductJsonLd {
  name?: string;
  image?: string;
  sku?: string;
  mpn?: string;
  offers?: KomplettOffer;
  additionalProperty?: Array<{ name?: string; value?: string }>;
}

function extractProductJsonLd(html: string): KomplettProductJsonLd | null {
  const match = html.match(/<script[^>]*id="product-schema-main"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export async function fetchKomplettByMPN(mpn: string, expectedEan?: string | null): Promise<MarketPrice | null> {
  try {
    const resp = await fetch(`https://www.komplett.no/search?q=${encodeURIComponent(mpn)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.8' },
    });
    if (!resp.ok) return null;

    const html = await resp.text();
    const data = extractProductJsonLd(html);
    if (!data) return null; // Ingen redirect til produktside => ingen eksakt treff.

    // KRITISK, samme lærdom som Elkjøp: verifiser MPN eksplisitt i stedet
    // for å stole blindt på at et treff faktisk er riktig produkt.
    const foundMpn = String(data.mpn ?? '').trim().toLowerCase();
    if (foundMpn !== mpn.trim().toLowerCase()) return null;

    const ean = data.additionalProperty?.find(p => p.name === 'EAN')?.value;
    if (expectedEan && ean) {
      const foundEan = ean.replace(/^0+/, '');
      if (foundEan !== expectedEan.replace(/^0+/, '')) return null;
    }

    const priceIncVat = data.offers?.price ? parseFloat(data.offers.price) : null;

    return {
      ean: ean ?? expectedEan ?? null,
      mpn: data.mpn ?? mpn,
      source: 'komplett',
      source_sku: data.sku,
      name: data.name,
      price_inc_vat: priceIncVat,
      price_ex_vat: priceIncVat ? Math.round((priceIncVat / 1.25) * 100) / 100 : null,
      available: data.offers?.availability?.includes('InStock') ?? false,
      image_url: data.image || undefined,
      product_url: data.offers?.url ?? resp.url,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[Komplett] Feil ved oppslag av MPN ${mpn}:`, err);
    return null;
  }
}

/**
 * Batch-henting for en liste MPN-er (med tilhørende forventet EAN for
 * verifisering, samme rekkefølge).
 */
export async function fetchKomplettBatch(
  items: Array<{ mpn: string; ean?: string | null }>
): Promise<MarketPrice[]> {
  console.log(`[Komplett] Henter ${items.length} produkter...`);
  const results: MarketPrice[] = [];

  for (let i = 0; i < items.length; i++) {
    const result = await fetchKomplettByMPN(items[i].mpn, items[i].ean);
    if (result) results.push(result);

    if ((i + 1) % 10 === 0) {
      console.log(`[Komplett] ${i + 1}/${items.length} behandlet`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`[Komplett] ${results.length} av ${items.length} produkter funnet`);
  return results;
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('komplett.ts')) {
  const mpn = process.argv[2] ?? 'MG6J4QN/A'; // Apple iPhone 17 256GB, sort
  const result = await fetchKomplettByMPN(mpn, '195950643510');
  console.log('[Komplett] Resultat:', JSON.stringify(result, null, 2));
}
