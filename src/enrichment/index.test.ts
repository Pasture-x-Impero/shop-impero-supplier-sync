import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichProducts } from './index.ts';
import type { CacheFile } from './cache.ts';
import type { SupplierProduct } from '../types.ts';

function emptyCache(): CacheFile {
  return { version: 1, notFoundCooldownDays: 14, entries: {} };
}

function product(overrides: Partial<SupplierProduct> = {}): SupplierProduct {
  return {
    mpn: 'A3ZJ3ET#UUW',
    ean: '197489946966',
    supplier: 'tdsynnex',
    manufacturer: 'HP',
    name: 'HP ZBook Ultra 14 inch G1a Mobile Workstation PC - Nordic keyboard',
    source_text: 'HP ZBook Ultra 14 inch G1a Mobile Workstation PC - Nordic keyboard',
    price_ex_vat: 42500,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeIcecatResponse(productName: string, brand: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        GeneralInfo: { ProductName: productName, Brand: brand, Title: `${brand} ${productName}`, GTIN: [] },
        FeaturesGroups: [
          {
            FeatureGroup: { Name: { Value: 'Memory' } },
            Features: [{ Feature: { Name: { Value: 'Internal memory' } }, PresentationValue: '32 GB' }],
          },
        ],
      },
    }),
  };
}

const NOT_FOUND_RESPONSE = { ok: false, status: 404, json: async () => ({}) };
const ICECAT_NOT_FOUND = { ok: false, status: 404, json: async () => ({}) };
const POWER_NO_MATCH = { ok: true, status: 200, json: async () => ({ matchCount: 0 }) };
const KOMPLETT_NO_MATCH = { ok: true, status: 200, text: async () => '<html>ingen treff</html>' };
const DUSTIN_NO_MATCH = { ok: true, status: 200, url: 'https://www.dustin.no/search/x', text: async () => '<html>ingen treff</html>' };

function dustinMatchResponse(mpn: string, name: string, imageUrl?: string) {
  const escapedMpn = `\\"mpn\\":\\"${mpn}\\"`;
  const offer = `,\\"offers\\":{\\"priceSpecification\\":{\\"price\\":199,\\"priceCurrency\\":\\"NOK\\",\\"valueAddedTaxIncluded\\":false},\\"availability\\":\\"https://schema.org/InStock\\"}`;
  const imageChunk = imageUrl ? `self.__next_f.push([1,"\\"image\\":\\"${imageUrl}\\""])` : '';
  return {
    ok: true,
    status: 200,
    url: `https://www.dustin.no/product/1/x`,
    text: async () =>
      `<html><title>${name} (${mpn})</title>self.__next_f.push([1,"${escapedMpn}${offer},\\"productID\\":\\"x\\""])${imageChunk}</html>`,
  };
}

test('enrichProducts: ingen sikkert treff beholder distributørnavnet og gir tom specs, uten å kaste', async t => {
  t.mock.method(globalThis, 'fetch', async () => NOT_FOUND_RESPONSE);

  const cache = emptyCache();
  const p = product();
  const result = await enrichProducts([p], { cache });

  assert.equal(result.missing, 1);
  assert.equal(result.enriched, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.items[0].name, p.name);
  assert.equal(result.items[0].source_name, p.name);
  assert.deepEqual(result.items[0].specs, {});
});

test('enrichProducts: samme EAN fra to ulike leverandører gir identisk navn/specs og ett Icecat-kall', async t => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return fakeIcecatResponse('ZBook Ultra G1a', 'HP');
  });

  const cache = emptyCache();
  const fromAlso = product({ supplier: 'also', name: 'HP ZBOOK ULTRA G1A NORDIC' });
  const fromTdsynnex = product({ supplier: 'tdsynnex', name: 'HP ZBook Ultra 14 inch G1a Mobile Workstation PC' });

  const result = await enrichProducts([fromAlso, fromTdsynnex], { cache });

  assert.equal(callCount, 1, 'begge produktene deler samme EAN-nøkkel i cachen — kun ett Icecat-kall');
  assert.equal(result.enriched, 2);
  assert.equal(result.items[0].name, result.items[1].name);
  assert.deepEqual(result.items[0].specs, result.items[1].specs);
  // source_name skal fortsatt være hver leverandørs EGET opprinnelige navn, ikke delt
  assert.equal(result.items[0].source_name, fromAlso.name);
  assert.equal(result.items[1].source_name, fromTdsynnex.name);
});

test('enrichProducts: en feilet oppslag (nettverksfeil) stopper aldri resten av synken, og skrives ikke til cachen', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('nettverksfeil');
  });

  const cache = emptyCache();
  const p = product();
  const result = await enrichProducts([p, product({ mpn: 'ANNEN-MPN', ean: null })], { cache });

  assert.equal(result.errors, 2);
  assert.equal(result.items.length, 2, 'begge produktene skal fortsatt være med i resultatet');
  assert.deepEqual(result.items[0].specs, {});
  assert.equal(Object.keys(cache.entries).length, 0, 'en forbigående feil skal ikke skrives til cachen som en bekreftet ikke-match');
});

test('enrichProducts: et Icecat-treff uten meningsfullt navn beholder distributørnavnet, men bruker fortsatt specs', async t => {
  // Icecat speiler kun MPN-en, OG ingen av konkurrent-fallback-kildene finner produktet heller.
  t.mock.method(globalThis, 'fetch', async (url: string): Promise<any> => {
    if (url.includes('icecat.biz')) return fakeIcecatResponse('DX0L8AT', 'HP');
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return KOMPLETT_NO_MATCH;
    if (url.includes('dustin.no')) return DUSTIN_NO_MATCH;
    throw new Error('uventet URL: ' + url);
  });

  const cache = emptyCache();
  const p = product({
    mpn: 'DX0L8AT#UUW',
    name: 'HP DX0L8AT Notebook PC - Nordic keyboard',
    source_text: 'HP DX0L8AT Notebook PC - Nordic keyboard',
  });
  const result = await enrichProducts([p], { cache });

  assert.equal(result.enriched, 1);
  assert.equal(result.items[0].name, p.name, 'navnet skal IKKE erstattes av Icecat sitt ikke-navn');
  assert.equal(result.items[0].source_name, p.name);
  // fra fakeIcecatResponse sin FeaturesGroups + tastaturoppsett-nøkkelordsøket i source_text
  assert.deepEqual(result.items[0].specs, { minne: '32 GB', tastaturoppsett: 'Nordisk' });
});

test('enrichProducts: Icecat uten treff i det hele tatt -> konkurrent-fallback (Dustin) gir navnet, specs forblir tomt', async t => {
  const p = product({ mpn: '910-006582', ean: '5099206107885', manufacturer: 'Logitech', name: 'Mus - ... - grafitt' });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('icecat.biz')) return ICECAT_NOT_FOUND;
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return KOMPLETT_NO_MATCH;
    if (url.includes('dustin.no')) return dustinMatchResponse(p.mpn, 'Logitech MX Master 3S for Business');
    throw new Error('uventet URL: ' + url);
  });

  const cache = emptyCache();
  const result = await enrichProducts([p], { cache });

  assert.equal(result.enriched, 1);
  assert.equal(result.enrichedViaCompetitor, 1);
  assert.equal(result.missing, 0);
  assert.equal(result.items[0].name, 'Logitech MX Master 3S for Business');
  assert.equal(result.items[0].source_name, p.name);
  assert.deepEqual(result.items[0].specs, {}, 'konkurrent-kilder gir kun navn, ingen strukturerte specs');
  assert.equal(result.items[0].image_url, undefined, 'ingen bilde i denne fixturen — skal ikke dukke opp av seg selv');
});

test('enrichProducts: konkurrent-fallback sitt bilde propagerer helt ut til payload-objektet', async t => {
  const p = product({ mpn: '910-006582', ean: '5099206107885', manufacturer: 'Logitech', name: 'Mus - ... - grafitt' });
  const imageUrl = 'https://cf-images.dustin.eu/image/x/logitech-mx-master-3s.jpg';
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('icecat.biz')) return ICECAT_NOT_FOUND;
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return KOMPLETT_NO_MATCH;
    if (url.includes('dustin.no')) return dustinMatchResponse(p.mpn, 'Logitech MX Master 3S for Business', imageUrl);
    throw new Error('uventet URL: ' + url);
  });

  const cache = emptyCache();
  const result = await enrichProducts([p], { cache });

  assert.equal(result.items[0].image_url, imageUrl);
  // Cachet slik at neste kjøring ikke trenger å spørre Dustin på nytt for bildet heller.
  const cached = Object.values(cache.entries).find((e: any) => e.status === 'matched') as any;
  assert.equal(cached.imageUrl, imageUrl);
});

test('enrichProducts: Icecat-treff uten meningsfullt navn -> konkurrent-fallback gir navnet, Icecat sine specs beholdes', async t => {
  const p = product({ mpn: 'DX0L8AT#UUW', ean: '826581749431', manufacturer: 'HP', name: 'AI PC - ... - kbd: Pan Nordic' });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('icecat.biz')) return fakeIcecatResponse('DX0L8AT', 'HP'); // ikke-meningsfullt navn
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return KOMPLETT_NO_MATCH;
    if (url.includes('dustin.no')) return dustinMatchResponse(p.mpn, 'HP EliteBook AI PC Nordic');
    throw new Error('uventet URL: ' + url);
  });

  const cache = emptyCache();
  const result = await enrichProducts([p], { cache });

  assert.equal(result.enrichedViaCompetitor, 1);
  assert.equal(result.items[0].name, 'HP EliteBook AI PC Nordic');
  // fra fakeIcecatResponse sin FeaturesGroups + tastaturoppsett-nøkkelordsøket i produktets EGET navn/tekst
  assert.deepEqual(
    result.items[0].specs,
    { minne: '32 GB', tastaturoppsett: 'Nordisk' },
    'Icecat sine specs skal beholdes selv om navnet kom fra en konkurrent'
  );
});

test('enrichProducts: et allerede cachet treff kalles ikke på nytt', async t => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return fakeIcecatResponse('ZBook Ultra G1a', 'HP');
  });

  const cache = emptyCache();
  const p = product();
  await enrichProducts([p], { cache });
  assert.equal(callCount, 1);

  const result2 = await enrichProducts([p], { cache });
  assert.equal(callCount, 1, 'andre kjøring skal treffe cachen, ikke kalle Icecat på nytt');
  assert.equal(result2.enriched, 1);
});
