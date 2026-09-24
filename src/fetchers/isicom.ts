/**
 * isicom.no — Jabra-produkter (PrestaShop)
 *
 * Henter alle Jabra-produkter fra kategori 39 (/39-jabra).
 * Priser er kun tilgjengelig med autentisert PrestaShop-sesjon.
 *
 * Sesjon-cookie hentes fra ISICOM_SESSION_COOKIE miljøvariabel.
 * Format: "PHPSESSID=xxxx; PrestaShop-{hash}=yyyy"
 *
 * Prisformat i HTML: inkl. 25% MVA (norsk format "kr 3.412,55")
 */

import { parse as parseHtml } from 'node-html-parser';
import type { SupplierProduct } from '../types.ts';

const BASE_URL = 'https://www.isicom.no';
const CATEGORY_URL = `${BASE_URL}/39-jabra`;
const PRODUCTS_PER_PAGE = 24;
const DELAY_MS = 2000; // 2 sekunder mellom kall

const ISICOM_SESSION_COOKIE = process.env.ISICOM_SESSION_COOKIE;

interface IsicomProduct {
  productId: string;
  attributeId: string;
  ean: string;
  mpn: string;
  name: string;
  priceIncVat: number | null;
  priceExVat: number | null;
  productUrl: string;
}

/**
 * Hent én side av Jabra-kategorien.
 */
async function fetchCategoryPage(pageNum: number, cookies: string): Promise<string> {
  const url = `${CATEGORY_URL}?page=${pageNum}&order=product.position.asc`;
  const resp = await fetch(url, {
    headers: {
      Cookie: cookies,
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; ImperoBot/1.0; +https://shop.impero.no)',
    },
  });

  if (!resp.ok) {
    throw new Error(`isicom.no: HTTP ${resp.status} på side ${pageNum}`);
  }

  return resp.text();
}

/**
 * Parser produktkort fra kategorisi-HTML.
 */
function parseProducts(html: string, pageNum: number): IsicomProduct[] {
  const root = parseHtml(html);
  const products: IsicomProduct[] = [];

  // Finn alle produktkort
  const articles = root.querySelectorAll('article.product-miniature');

  for (const article of articles) {
    // Finn produkt-lenke
    const linkEl = article.querySelector('h2.product-title > a, .product-title a');
    if (!linkEl) continue;

    const href = linkEl.getAttribute('href') ?? '';

    // Ekstrakt fra URL: /{kategori}/{product_id}-{attribute_id}-{slug}-{ean}.html
    const urlMatch = href.match(/\/(\d+)-(\d+)-(.+?)-(\d{13})\.html$/);
    if (!urlMatch) continue;

    const [, productId, attributeId, , ean] = urlMatch;

    // Produktnavn
    const name = linkEl.textContent?.trim() ?? '';

    // MPN / Artikelnummer
    const mpnEl = article.querySelector('.product-reference, [class*="reference"]');
    const mpn = mpnEl?.textContent?.replace(/Art\.?nr\.?:?\s*/i, '').trim() ?? '';

    // Pris (kun synlig med sesjon-cookie)
    const priceEl = article.querySelector('.price, [class*="price"] span.price, .product-price-and-shipping .price');
    let priceIncVat: number | null = null;
    let priceExVat: number | null = null;

    if (priceEl) {
      // Format: "kr 3.412,55" eller "3 412,55 kr"
      const priceText = priceEl.textContent ?? '';
      const priceMatch = priceText.replace(/\s/g, '').match(/[\d.]+,\d{2}/);
      if (priceMatch) {
        // Konverter norsk format (punktum = tusenskiller, komma = desimal)
        const normalized = priceMatch[0].replace(/\./g, '').replace(',', '.');
        priceIncVat = parseFloat(normalized);
        priceExVat = Math.round((priceIncVat / 1.25) * 100) / 100;
      }
    }

    products.push({
      productId,
      attributeId,
      ean,
      mpn: mpn || ean, // Fallback til EAN hvis MPN ikke er funnet
      name,
      priceIncVat,
      priceExVat,
      productUrl: `${BASE_URL}${href}`,
    });
  }

  console.log(`[isicom] Side ${pageNum}: ${products.length} produkter`);
  return products;
}

/**
 * Hent antall sider fra paginering i HTML.
 */
function getTotalPages(html: string): number {
  const root = parseHtml(html);

  // PrestaShop-paginering: finn siste side-link
  const pageLinks = root.querySelectorAll('.pagination a[data-page], .page-list a');
  if (!pageLinks.length) return 1;

  const pageNums = pageLinks
    .map(el => parseInt(el.getAttribute('data-page') ?? el.textContent ?? '0', 10))
    .filter(n => n > 0);

  return pageNums.length ? Math.max(...pageNums) : 1;
}

/**
 * Hent alle Jabra-produkter fra isicom.no.
 */
export async function fetchIsicomProducts(): Promise<SupplierProduct[]> {
  if (!ISICOM_SESSION_COOKIE) {
    throw new Error('ISICOM_SESSION_COOKIE er ikke satt som miljøvariabel / GitHub Secret');
  }

  console.log('[isicom] Starter henting av Jabra-produkter...');

  // Last side 1 for å finne totalt antall sider
  const firstPageHtml = await fetchCategoryPage(1, ISICOM_SESSION_COOKIE);
  const totalPages = getTotalPages(firstPageHtml);
  console.log(`[isicom] Totalt ${totalPages} sider`);

  // Sjekk om sesjon er gyldig (priser bør være synlige)
  if (!firstPageHtml.includes('class="price"') && !firstPageHtml.includes('product-price')) {
    console.warn('[isicom] ⚠️ Priser ikke synlige — sesjon-cookie kan være utløpt');
  }

  const allProducts: IsicomProduct[] = parseProducts(firstPageHtml, 1);

  // Hent resterende sider
  for (let page = 2; page <= totalPages; page++) {
    await new Promise(r => setTimeout(r, DELAY_MS));
    const html = await fetchCategoryPage(page, ISICOM_SESSION_COOKIE);
    allProducts.push(...parseProducts(html, page));
  }

  console.log(`[isicom] Totalt ${allProducts.length} produkter hentet`);

  // Konverter til SupplierProduct-format
  return allProducts.map(p => ({
    mpn: p.mpn,
    ean: p.ean,
    supplier: 'isicom' as const,
    supplier_sku: `${p.productId}-${p.attributeId}`,
    manufacturer: 'Jabra',
    name: p.name,
    price_inc_vat: p.priceIncVat,
    price_ex_vat: p.priceExVat,
    available_qty: p.priceIncVat ? 1 : 0, // Synlig i listing = tilgjengelig
    updated_at: new Date().toISOString(),
  }));
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('isicom.ts')) {
  const products = await fetchIsicomProducts();
  console.log('[isicom] Eksempel (første produkt):', JSON.stringify(products[0], null, 2));
  const withPrices = products.filter(p => p.price_inc_vat);
  console.log(`[isicom] ${withPrices.length} av ${products.length} produkter har pris`);
}
