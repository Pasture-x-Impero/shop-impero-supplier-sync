/**
 * Sekundær navnekilde når Icecat ikke har et treff (eller ikke har et
 * meningsfullt navn, se normalize.ts sin isMeaningfulModelName): spør de
 * samme tre konkurrent-kildene prisings-motoren allerede bruker
 * (src/fetchers/power.ts/komplett.ts/dustin.ts), i rekkefølge Power (EAN) →
 * Komplett (MPN) → Dustin (MPN).
 *
 * Disse gir et EKTE navn en norsk nettbutikk selv bruker for akkurat denne
 * EAN-en/MPN-en — ikke gjetting, bare en tredje kilde å spørre før vi gir
 * opp. De gir kun et navn, ingen strukturerte specs (i motsetning til
 * Icecat) — specs forblir tomt/uendret når navnet kommer herfra.
 *
 * Returnerer null hvis ingen av de tre fører produktet, eller ved
 * forbigående feil — alle tre fetcherne fanger sine egne feil og returnerer
 * null, kaster aldri, så denne funksjonen kaster heller aldri.
 */

import { fetchPowerByEAN } from '../fetchers/power.ts';
import { fetchKomplettByMPN } from '../fetchers/komplett.ts';
import { fetchDustinByMPN } from '../fetchers/dustin.ts';

export type CompetitorNameSource = 'power' | 'komplett' | 'dustin';

export interface CompetitorNameResult {
  name: string;
  source: CompetitorNameSource;
  // Bilde-URL hos kilden, hvis den fantes — alle tre gir dette i praksis (se
  // filkommentarer i power.ts/komplett.ts/dustin.ts for hvordan hver trekker
  // det ut). Kun brukt når produktet mangler bilde helt fra før (Icecat har
  // ingen bildedata i dette repoet uansett).
  imageUrl?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function lookupCompetitorName(input: {
  ean?: string | null;
  mpn: string;
}): Promise<CompetitorNameResult | null> {
  if (input.ean) {
    const power = await fetchPowerByEAN(input.ean);
    if (power?.name) return { name: power.name, source: 'power', ...(power.image_url ? { imageUrl: power.image_url } : {}) };
    await sleep(500); // Samme høflighetspause som Power sin egen batch-henting.
  }

  const komplett = await fetchKomplettByMPN(input.mpn, input.ean);
  if (komplett?.name) return { name: komplett.name, source: 'komplett', ...(komplett.image_url ? { imageUrl: komplett.image_url } : {}) };
  await sleep(800); // Samme pause som Komplett/Dustin sine egne batch-hentinger.

  const dustin = await fetchDustinByMPN(input.mpn);
  if (dustin?.name) return { name: dustin.name, source: 'dustin', ...(dustin.image_url ? { imageUrl: dustin.image_url } : {}) };

  return null;
}
