/**
 * Eneste offentlige inngang for produktnavn/specs-berikelse — se planen
 * (zazzy-splashing-lemon.md) for hele designet.
 *
 * Kalles fra ETT sted per leverandørgren i sync.ts, alltid identisk
 * uavhengig av hvilken leverandør som kalte den — dette er det som
 * garanterer at samme fysiske produkt (samme EAN) fra to ulike
 * distributører får identisk navn/specs, siden begge treffer samme
 * cache-nøkkel i stedet for å kjøre separat, potensielt avvikende logikk
 * per fetcher.
 *
 * Kaster aldri: et produkt uten sikkert Icecat-treff beholder sitt
 * opprinnelige distributørnavn (både som `name` og `source_name`) og får
 * `specs = {}`. En feilet enkelt-oppslag stopper aldri resten av synken.
 */

import type { SupplierProduct } from '../types.ts';
import { lookupIcecatProduct } from './icecat.ts';
import { shortenName, buildSpecs, isMeaningfulModelName } from './normalize.ts';
import { lookupCompetitorName } from './competitor-name.ts';
import {
  loadCache,
  saveCacheIfDirty,
  cacheKey,
  getCacheEntry,
  isEntryStale,
  setMatchedEntry,
  setNotFoundEntry,
  type CacheFile,
} from './cache.ts';

const ICECAT_DELAY_MS = 300;

export interface EnrichResult {
  items: SupplierProduct[];
  enriched: number;
  enrichedViaCompetitor: number;
  missing: number;
  errors: number;
}

export interface EnrichProductsOptions {
  // Kun til testing: injiser en egen, ren i-minne-cache i stedet for å
  // lese/skrive den ekte, git-committede data/icecat-cache.json. Når denne
  // er satt, gjøres ingen disk-I/O i det hele tatt.
  cache?: CacheFile;
}

export async function enrichProducts(
  products: SupplierProduct[],
  opts: EnrichProductsOptions = {}
): Promise<EnrichResult> {
  const usingInjectedCache = Boolean(opts.cache);
  const cache = opts.cache ?? (await loadCache());

  let enriched = 0;
  let enrichedViaCompetitor = 0;
  let missing = 0;
  let errors = 0;
  const items: SupplierProduct[] = [];

  for (const product of products) {
    const originalName = product.name;
    const key = cacheKey(product);
    let entry = getCacheEntry(cache, key);

    if (!entry || isEntryStale(cache, entry)) {
      const result = await lookupIcecatProduct({
        ean: product.ean,
        manufacturer: product.manufacturer,
        mpn: product.mpn,
      });
      await new Promise(r => setTimeout(r, ICECAT_DELAY_MS));

      if (result.status === 'matched') {
        const rawSourceText = product.source_text ?? product.name;
        const specs = buildSpecs(result.data, rawSourceText);
        // Specs er gyldige selv når Icecat sitt eget ProductName ikke er et
        // meningsfullt navn (f.eks. speiler bare artikkelnummeret) — i så
        // fall prøves konkurrent-fallback under for selve navnet, mens
        // Icecat sine specs beholdes uansett.
        let name = isMeaningfulModelName(result.data.productName, product.mpn)
          ? shortenName(result.data.productName, result.data.brand || product.manufacturer, specs)
          : null;
        let nameSource: 'icecat' | 'power' | 'komplett' | 'dustin' | undefined = name ? 'icecat' : undefined;
        let imageUrl: string | undefined;
        if (!name) {
          const competitor = await lookupCompetitorName({ ean: product.ean, mpn: product.mpn });
          if (competitor) {
            name = competitor.name;
            nameSource = competitor.source;
            imageUrl = competitor.imageUrl;
          }
        }
        setMatchedEntry(cache, key, name, specs, nameSource, imageUrl);
        entry = getCacheEntry(cache, key);
      } else if (result.status === 'not_found') {
        // Icecat har ingenting i det hele tatt for dette produktet (verken
        // navn eller specs) — prøv konkurrent-fallback for i det minste et
        // ekte navn (og et bilde, siden Icecat uansett ikke gir bildedata her)
        // før vi gir opp helt og cacher som "ikke funnet".
        const competitor = await lookupCompetitorName({ ean: product.ean, mpn: product.mpn });
        if (competitor) {
          setMatchedEntry(cache, key, competitor.name, {}, competitor.source, competitor.imageUrl);
        } else {
          setNotFoundEntry(cache, key);
        }
        entry = getCacheEntry(cache, key);
      }
      // status === 'error': skriver bevisst ikke til cachen — dette er ikke
      // en bekreftet ikke-match, og skal fremstå som cache-miss neste kjøring.
    }

    if (entry?.status === 'matched') {
      enriched++;
      if (entry.nameSource && entry.nameSource !== 'icecat') enrichedViaCompetitor++;
      items.push({
        ...product,
        name: entry.name ?? originalName,
        source_name: originalName,
        specs: entry.specs,
        ...(entry.imageUrl ? { image_url: entry.imageUrl } : {}),
      });
    } else if (entry?.status === 'not_found') {
      missing++;
      items.push({ ...product, source_name: originalName, specs: {} });
    } else {
      errors++;
      items.push({ ...product, source_name: originalName, specs: {} });
    }
  }

  if (!usingInjectedCache) {
    await saveCacheIfDirty();
  }

  return { items, enriched, enrichedViaCompetitor, missing, errors };
}
