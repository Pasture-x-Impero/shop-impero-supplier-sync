/**
 * Lokal, git-committed cache for Icecat-oppslag (data/icecat-cache.json).
 *
 * Dette repoet har ingen annen persistens (hver `node sync.ts`-kjøring er en
 * fullstendig fersk, stateless prosess) og skal ikke gjøre endringer i
 * Lovable-prosjektets Supabase-skjema denne fasen — se planen
 * (zazzy-splashing-lemon.md §2) for hvorfor en committed JSON-fil ble valgt
 * fremfor `actions/cache` (utkastes stille etter 7 dager, ville brutt
 * kravet om at "ikke funnet"-produkter ikke skal gis opp permanent).
 *
 * `matched`-oppføringer caches permanent (Icecat sin eksakte-treff-data
 * endrer seg ikke for en gitt SKU). `not_found`-oppføringer prøves på nytt
 * når de er eldre enn `notFoundCooldownDays`. Forbigående feil (nettverk,
 * timeout) skrives ALDRI til cachen — de er ikke en bekreftet ikke-match,
 * og skal prøves igjen neste kjøring automatisk (cache-miss-oppførsel).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_COOLDOWN_DAYS = 14;
const CACHE_PATH = fileURLToPath(new URL('../../data/icecat-cache.json', import.meta.url));

export interface CacheEntryMatched {
  status: 'matched';
  lastCheckedAt: string;
  // null = ingen kilde (verken Icecat eller konkurrent-fallback) ga et
  // meningsfullt navn — specs er likevel gyldige og brukes hvis de finnes,
  // men det kallende produktets EGET originalnavn beholdes. Se
  // normalize.ts sin isMeaningfulModelName() og competitor-name.ts.
  name: string | null;
  specs: Record<string, string>;
  // Hvor `name` faktisk kom fra — kun til logging/sporbarhet. Utelatt =
  // 'icecat' (eldre cache-oppføringer fra før dette feltet fantes).
  nameSource?: 'icecat' | 'power' | 'komplett' | 'dustin';
  // Bilde-URL fra samme konkurrent-kilde som ga navnet (Icecat gir ingen
  // bildedata i dette repoet — kun navn/specs). Lovable-siden avgjør selv om
  // den faktisk skal brukes (kun når produktet mangler bilde helt fra før).
  imageUrl?: string;
}

export interface CacheEntryNotFound {
  status: 'not_found';
  lastCheckedAt: string;
}

export type CacheEntry = CacheEntryMatched | CacheEntryNotFound;

export interface CacheFile {
  version: 1;
  notFoundCooldownDays: number;
  entries: Record<string, CacheEntry>;
}

let cache: CacheFile | null = null;
let dirty = false;

function emptyCache(): CacheFile {
  return { version: 1, notFoundCooldownDays: DEFAULT_COOLDOWN_DAYS, entries: {} };
}

/**
 * Laster cache-filen fra disk (én gang per prosess — holdt i minnet resten
 * av kjøringen). Mangler filen, eller er den ugyldig, startes en tom cache
 * i stedet for å kaste — en manglende/korrupt cache skal aldri stoppe synken.
 */
export async function loadCache(): Promise<CacheFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    cache = parsed.entries ? parsed : emptyCache();
  } catch {
    cache = emptyCache();
  }
  return cache;
}

/** Skriver cachen til disk, men kun hvis den faktisk ble endret denne kjøringen. */
export async function saveCacheIfDirty(): Promise<void> {
  if (!dirty || !cache) return;
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  dirty = false;
}

/** Kun til bruk i tester — nullstiller modul-tilstanden mellom testcaser. */
export function _resetCacheStateForTests(): void {
  cache = null;
  dirty = false;
}

export function cacheKey(input: { ean?: string | null; manufacturer?: string; mpn: string }): string {
  if (input.ean) return `ean:${input.ean}`;
  return `mpn:${(input.manufacturer ?? '').toLowerCase()}|${input.mpn.toLowerCase()}`;
}

export function getCacheEntry(c: CacheFile, key: string): CacheEntry | undefined {
  return c.entries[key];
}

export function isEntryStale(c: CacheFile, entry: CacheEntry): boolean {
  if (entry.status === 'matched') return false; // Permanent — Icecat sin eksakte-SKU-data endrer seg ikke.
  const ageDays = (Date.now() - new Date(entry.lastCheckedAt).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays >= (c.notFoundCooldownDays ?? DEFAULT_COOLDOWN_DAYS);
}

export function setMatchedEntry(
  c: CacheFile,
  key: string,
  name: string | null,
  specs: Record<string, string>,
  nameSource?: CacheEntryMatched['nameSource'],
  imageUrl?: string
): void {
  c.entries[key] = {
    status: 'matched',
    lastCheckedAt: new Date().toISOString(),
    name,
    specs,
    ...(nameSource ? { nameSource } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
  dirty = true;
}

export function setNotFoundEntry(c: CacheFile, key: string): void {
  c.entries[key] = { status: 'not_found', lastCheckedAt: new Date().toISOString() };
  dirty = true;
}

// Kun til diagnostikk/lesing utenfra (f.eks. et fremtidig "vis cache-status"-modus).
export function cachePathForDebug(): string {
  return join(CACHE_PATH);
}
