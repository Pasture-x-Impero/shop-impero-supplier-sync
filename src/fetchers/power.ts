/**
 * Power.no — konkurrent-pris via deres egen JSON-API (ingen HTML-scraping,
 * ingen Playwright nødvendig). Matches på EAN.
 *
 * Oppdaget 2026-09-13 via nettverkstrafikk på power.no sitt eget søkefelt:
 *   1. GET /api/v2/search/suggestions?searchTerm={EAN} — finner produkt-ID,
 *      returnerer allerede pris (inkl./eksl. mva) og tittel/URL i samme kall.
 *   2. GET /api/v2/products?ids={id}&allowWebStatus8=false — full produktdata
 *      inkl. lagerstatus (stockCount, stockDeliveryDate).
 *
 * Begge er åpne, offentlige API-er (samme som nettsiden selv bruker) — ingen
 * auth, ingen cookies nødvendig. Verifisert med ekte EAN (195950643510,
 * Apple iPhone 17 256GB, svart) — matchCount:0 og ingen topProducts-nøkkel
 * når ingenting finnes.
 */

import type { MarketPrice } from '../types.ts';

const UA = 'Mozilla/5.0 (compatible; ImperoBot/1.0; +https://shop.impero.no)';
const DELAY_MS = 500;

interface PowerImageVariant {
  filename: string;
  width: number;
  height: number;
  isTransparent: boolean;
}

interface PowerProductImage {
  basePath: string;
  variants?: PowerImageVariant[];
}

interface PowerSearchProduct {
  productId: number;
  title: string;
  url: string;
  price: number;
  vatlessPrice: number;
  productImage?: PowerProductImage;
}

// Bilde-CDN-en er media.power-cdn.net, IKKE www.power.no (bekreftet 2026-09-22 —
// et første forsøk med www.power.no ga 404, selve produktsiden lastet bildet fra
// en helt annen host). Velger den største ikke-transparente JPG-varianten
// (..._w_g.jpg) for bredest kompatibilitet.
function buildPowerImageUrl(img: PowerProductImage | undefined): string | undefined {
  if (!img?.basePath || !img.variants?.length) return undefined;
  const jpgVariants = img.variants.filter(v => v.filename.endsWith('_w_g.jpg'));
  const best = jpgVariants.sort((a, b) => b.width - a.width)[0];
  if (!best) return undefined;
  return `https://media.power-cdn.net${img.basePath}/${best.filename}`;
}

interface PowerSearchResponse {
  matchCount: number;
  topProducts?: Array<{ products: PowerSearchProduct[] }>;
}

interface PowerProductDetail {
  productId: number;
  title: string;
  url: string;
  price: number;
  vatlessPrice: number;
  stockCount: number;
  stockDeliveryDate?: string;
}

/**
 * Slår opp én EAN mot Power.no sitt søk, og henter deretter lagerstatus for
 * treffet. Returnerer null hvis ingen treff.
 */
export async function fetchPowerByEAN(ean: string): Promise<MarketPrice | null> {
  try {
    const searchResp = await fetch(
      `https://www.power.no/api/v2/search/suggestions?searchTerm=${encodeURIComponent(ean)}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!searchResp.ok) return null;

    const searchData = (await searchResp.json()) as PowerSearchResponse;
    if (!searchData.matchCount || !searchData.topProducts?.length) return null;

    const product = searchData.topProducts.flatMap(g => g.products)[0];
    if (!product) return null;

    // Hent lagerstatus — søkeresultatet alene har ikke stockCount.
    const detailResp = await fetch(
      `https://www.power.no/api/v2/products?ids=${product.productId}&allowWebStatus8=false`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    const detail = detailResp.ok
      ? ((await detailResp.json()) as PowerProductDetail[])[0]
      : undefined;

    return {
      ean,
      mpn: '', // Power sitt API eksponerer ikke MPN i disse endepunktene — EAN er nøkkelen her.
      source: 'power',
      source_sku: String(product.productId),
      name: product.title,
      price_inc_vat: product.price,
      price_ex_vat: product.vatlessPrice,
      available: (detail?.stockCount ?? 0) > 0,
      image_url: buildPowerImageUrl(product.productImage),
      product_url: `https://www.power.no${product.url}`,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[Power] Feil ved oppslag av EAN ${ean}:`, err);
    return null;
  }
}

/**
 * Batch-henting for en liste EAN-er (typisk alle produkter i Produktutvalg).
 */
export async function fetchPowerBatch(eans: string[]): Promise<MarketPrice[]> {
  console.log(`[Power] Henter ${eans.length} produkter...`);
  const results: MarketPrice[] = [];

  for (let i = 0; i < eans.length; i++) {
    const result = await fetchPowerByEAN(eans[i]);
    if (result) results.push(result);

    if ((i + 1) % 10 === 0) {
      console.log(`[Power] ${i + 1}/${eans.length} behandlet`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`[Power] ${results.length} av ${eans.length} produkter funnet`);
  return results;
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('power.ts')) {
  const ean = process.argv[2] ?? '195950643510'; // Apple iPhone 17 256GB, svart
  const result = await fetchPowerByEAN(ean);
  console.log('[Power] Resultat:', JSON.stringify(result, null, 2));
}
