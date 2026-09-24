/**
 * Dustin — konkurrent-pris.
 *
 * ⚠️ Historikk: den forrige fetcheren (før 2026-09-17) brukte Playwright og
 * DOM-scraping (lette etter en "Ekskl. MVA"-knapp og en synlig <span> ved
 * siden av). Den feilet stille ("Ikke funnet") for enkelte produkter — bl.a.
 * Jabra Evolve3 85 MS (MPN 38599-999-889) — der Dustin sin produktside har
 * flere konfigurasjonsvalg (sertifisering, USB-kontakt, ladepute) som gjør
 * DOM-strukturen rundt prisen mindre forutsigbar/mer hydrerings-tidsavhengig
 * enn på enklere produktsider. Manuell verifisering i nettleser viste at
 * denne konkrete siden faktisk viser prisen helt fint — feilen var trolig
 * miljøspesifikk for GitHub Actions (samme klasse problem som Elkjøp sin
 * IP-baserte bot-beskyttelse, se CLAUDE.md), og uansett unødvendig skjør.
 *
 * ✅ Ny løsning 2026-09-17 — ingen Playwright, samme mønster som Komplett:
 * Dustin sin produktside ER en Next.js RSC-app UTEN en brukbar
 * <script type="application/ld+json">-tag i rå HTML (kun én BreadcrumbList
 * finnes slik — bekreftet), MEN selve schema.org Product-objektet (med
 * korrekt mpn/pris/lagerstatus) er faktisk embedded i siden — som en escaped
 * JSON-STRENG inne i en `self.__next_f.push([...])` RSC-datachunk, usynlig
 * for en enkel `script[type="application/ld+json"]`-selector. Verifisert med
 * rå `fetch()` (ingen Playwright, ingen Cloudflare-blokkering observert —
 * samme overraskelse som Komplett sin Kasada-beskyttelse) mot flere kjente
 * MPN-er, inkl. Jabra Evolve3 85 MS: `offers.price` = 4799,
 * `offers.priceSpecification.valueAddedTaxIncluded` = false (bekrefter
 * ekskl. mva, som CLAUDE.md allerede dokumenterte), `offers.availability` =
 * "https://schema.org/InStock".
 *
 * Ekstraksjon: finn `"mpn":"<mpn>"`-ankeret i den escapede RSC-teksten, ta
 * vinduet frem til det påfølgende `,"productID"`-feltet (som alltid følger
 * rett etter `offers`-objektet), fjern escaping-backslashene, og les
 * price/availability med enkle regexer — IKKE et fullt JSON.parse av hele
 * blokken, siden produktnavn med et bokstavelig anførselstegn (f.eks. et
 * tomme-tegn i en skjermstørrelse, "14.2\"") krever et ekstra escape-nivå der
 * og ellers gir en JSON-parse-feil. Navn/MPN-verifisering gjøres i stedet
 * via <title>-taggen (ingen slik escaping-komplikasjon der), akkurat som før.
 *
 * Søk på EAN gir ingen treff — kun MPN fungerer (se CLAUDE.md). `/search/{mpn}`
 * redirecter DIREKTE til produktsiden ved eksakt MPN-treff (bekreftet at
 * dette også skjer med en ren fetch(), ikke bare i nettleser), og blir
 * værende på søke-URL-en ved ingen treff — samme rene "ingen treff"-signal
 * som Komplett.
 */

import type { MarketPrice } from '../types.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 800;

interface ExtractedOffer {
  priceExVat: number;
  available: boolean;
}

// <title> hentes nå via regex på rå HTML, ikke page.title() (som Playwright
// avkoder automatisk) — dekod de vanligste HTML-entitetene selv, ellers
// dukker f.eks. "14.2&quot;" opp i produktnavnet i stedet for "14.2"".
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Bilde-URL-en ligger IKKE i samme RSC-datablokk som mpn/offers (bekreftet
// 2026-09-22 — søk i vinduet mellom mpn og productID ga ingen "image"-nøkkel
// i det hele tatt), men et globalt søk på siden fant nøyaktig ett "image"-
// treff, med filnavn som tydelig matcher det aktuelle produktet (merke,
// modell, farge). Trygt siden det kun er ett treff — ingen tvetydighet om
// hvilket bilde som faktisk gjelder.
function extractImageUrl(html: string): string | undefined {
  const match = html.match(/\\"image\\":\\"(https:[^\\"]+)\\"/);
  return match?.[1];
}

/**
 * Trekker ut pris + lagerstatus fra Dustin sin embedded (escaped) RSC-JSON.
 * Se filkommentaren øverst for hvorfor dette ikke er et enkelt JSON.parse.
 */
function extractOffer(html: string, mpn: string): ExtractedOffer | null {
  const startMarker = `\\"mpn\\":\\"${mpn}\\"`;
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return null;

  const endMarker = ',\\"productID\\"';
  const endIdx = html.indexOf(endMarker, startIdx);
  if (endIdx === -1) return null;

  // Fjerner ALLE escaping-backslasher i dette vinduet — trygt her siden vi
  // kun leser price (tall) og availability (et fast schema.org-enum-ord),
  // ingen av dem inneholder tegn som trenger escaping i utgangspunktet.
  const cleaned = html.slice(startIdx, endIdx).replace(/\\+/g, '');

  const priceMatch = cleaned.match(/"priceSpecification":\{"price":([\d.]+),"priceCurrency":"NOK","valueAddedTaxIncluded":(true|false)/);
  if (!priceMatch) return null;

  const priceExVat = parseFloat(priceMatch[1]);
  const vatIncluded = priceMatch[2] === 'true';
  if (!Number.isFinite(priceExVat) || vatIncluded) return null; // Uventet mva-format — tør ikke gjette, se CLAUDE.md.

  const availMatch = cleaned.match(/"availability":"https:\/\/schema\.org\/(\w+)"/);
  const available = availMatch?.[1] === 'InStock';

  return { priceExVat, available };
}

export async function fetchDustinByMPN(mpn: string): Promise<MarketPrice | null> {
  try {
    const resp = await fetch(`https://www.dustin.no/search/${encodeURIComponent(mpn)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.8' },
      redirect: 'follow',
    });
    if (!resp.ok) return null;

    // Ingen redirect til /product/... => ingen eksakt treff.
    if (!/\/product\//.test(resp.url)) return null;

    const html = await resp.text();

    // Sidetittelen inneholder alltid MPN i parentes til slutt — verifiser at
    // vi faktisk landet på RIKTIG produkt, ikke bare et annet treff
    // søkemotoren måtte velge å redirecte til.
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
    const title = decodeHtmlEntities(titleMatch?.[1] ?? '');
    if (!title.toLowerCase().includes(mpn.toLowerCase())) return null;

    const offer = extractOffer(html, mpn);
    if (!offer) return null;

    // Produktnavn = sidetittel uten MPN-parentesen på slutten.
    const name = title.replace(/\s*\([^)]*\)\s*$/, '').trim();

    return {
      mpn,
      source: 'dustin',
      name,
      price_ex_vat: offer.priceExVat,
      price_inc_vat: Math.round(offer.priceExVat * 1.25),
      available: offer.available,
      image_url: extractImageUrl(html),
      product_url: resp.url,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[Dustin] Feil ved oppslag av MPN ${mpn}:`, err);
    return null;
  }
}

/**
 * Batch-henting for en liste MPN-er.
 */
export async function fetchDustinBatch(mpns: string[]): Promise<MarketPrice[]> {
  console.log(`[Dustin] Henter ${mpns.length} produkter...`);
  const results: MarketPrice[] = [];

  for (let i = 0; i < mpns.length; i++) {
    const result = await fetchDustinByMPN(mpns[i]);
    if (result) results.push(result);

    if ((i + 1) % 10 === 0) {
      console.log(`[Dustin] ${i + 1}/${mpns.length} behandlet`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`[Dustin] ${results.length} av ${mpns.length} produkter funnet`);
  return results;
}

// Kjør direkte hvis kalt som standalone-script
if (process.argv[1]?.endsWith('dustin.ts')) {
  const mpn = process.argv[2] ?? 'MDE34H/A'; // Apple MacBook Pro (2025) Stellarsvart
  const result = await fetchDustinByMPN(mpn);
  console.log('[Dustin] Resultat:', JSON.stringify(result, null, 2));
}
