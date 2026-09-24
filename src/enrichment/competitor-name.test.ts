import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupCompetitorName } from './competitor-name.ts';

function powerResponse(name: string, productId = 123) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      matchCount: 1,
      topProducts: [{ products: [{ productId, title: name, url: '/p/x', price: 100, vatlessPrice: 80 }] }],
    }),
  };
}
const POWER_NO_MATCH = { ok: true, status: 200, json: async () => ({ matchCount: 0 }) };

function komplettHtml(mpn: string, name: string, image?: string) {
  const json = JSON.stringify({
    name,
    mpn,
    sku: 'sku1',
    ...(image ? { image } : {}),
    offers: { price: '199', availability: 'https://schema.org/InStock', url: 'https://www.komplett.no/product/x' },
  });
  return `<html><script id="product-schema-main" type="application/ld&#x2B;json">${json}</script></html>`;
}
const KOMPLETT_NO_MATCH_HTML = '<html>ingen treff her</html>';

function dustinRscChunk(mpn: string) {
  const escapedMpn = `\\"mpn\\":\\"${mpn}\\"`;
  const offer = `,\\"offers\\":{\\"priceSpecification\\":{\\"price\\":199,\\"priceCurrency\\":\\"NOK\\",\\"valueAddedTaxIncluded\\":false},\\"availability\\":\\"https://schema.org/InStock\\"}`;
  return `self.__next_f.push([1,"${escapedMpn}${offer},\\"productID\\":\\"x\\""])`;
}

test('lookupCompetitorName: Power gir treff — Komplett/Dustin kalles aldri', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    assert.ok(url.includes('power.no'), 'skal kun kalle Power (søk + lagerstatus)');
    if (url.includes('suggestions')) return powerResponse('Logitech MX Master 3S Graphite');
    return { ok: true, status: 200, json: async () => [{ productId: 123, stockCount: 5 }] };
  });

  const result = await lookupCompetitorName({ ean: '5099206107885', mpn: '910-006582' });
  assert.deepEqual(result, { name: 'Logitech MX Master 3S Graphite', source: 'power' });
  assert.equal(calls, 2, 'Power gjør ett søkekall + ett lagerstatus-kall ved treff');
});

test('lookupCompetitorName: Power uten treff, Komplett finner produktet', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return { ok: true, status: 200, text: async () => komplettHtml('910-006582', 'Logitech MX Master 3S for Business') };
    throw new Error('uventet URL: ' + url);
  });

  const result = await lookupCompetitorName({ ean: '5099206107885', mpn: '910-006582' });
  assert.deepEqual(result, { name: 'Logitech MX Master 3S for Business', source: 'komplett' });
});

test('lookupCompetitorName: Power og Komplett uten treff, Dustin finner produktet', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string): Promise<any> => {
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return { ok: true, status: 200, text: async () => KOMPLETT_NO_MATCH_HTML };
    if (url.includes('dustin.no')) {
      return {
        ok: true,
        status: 200,
        url: 'https://www.dustin.no/product/12345/logitech-mx-master-3s-for-business',
        text: async () =>
          `<html><title>Logitech MX Master 3S (for Business) Bluetooth Mus Grafitt (910-006582)</title>${dustinRscChunk('910-006582')}</html>`,
      };
    }
    throw new Error('uventet URL: ' + url);
  });

  const result = await lookupCompetitorName({ ean: '5099206107885', mpn: '910-006582' });
  assert.deepEqual(result, { name: 'Logitech MX Master 3S (for Business) Bluetooth Mus Grafitt', source: 'dustin' });
});

test('lookupCompetitorName: ingen av de tre finner produktet -> null, kaster aldri', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string): Promise<any> => {
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) return { ok: true, status: 200, text: async () => KOMPLETT_NO_MATCH_HTML };
    if (url.includes('dustin.no')) return { ok: true, status: 200, url: 'https://www.dustin.no/search/910-006582', text: async () => '<html>ingen treff</html>' };
    throw new Error('uventet URL: ' + url);
  });

  const result = await lookupCompetitorName({ ean: '5099206107885', mpn: '910-006582' });
  assert.equal(result, null);
});

test('lookupCompetitorName: Komplett sitt bilde tas med når det finnes', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string): Promise<any> => {
    if (url.includes('power.no')) return POWER_NO_MATCH;
    if (url.includes('komplett.no')) {
      return {
        ok: true,
        status: 200,
        text: async () => komplettHtml('910-006582', 'Logitech MX Master 3S for Business', 'https://www.komplett.no/product-media/x.jpg'),
      };
    }
    throw new Error('uventet URL: ' + url);
  });

  const result = await lookupCompetitorName({ ean: '5099206107885', mpn: '910-006582' });
  assert.deepEqual(result, {
    name: 'Logitech MX Master 3S for Business',
    source: 'komplett',
    imageUrl: 'https://www.komplett.no/product-media/x.jpg',
  });
});

test('lookupCompetitorName: uten EAN hoppes Power over, går rett til Komplett', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    if (url.includes('komplett.no')) return { ok: true, status: 200, text: async () => komplettHtml('4XC1U87491', 'Lenovo ThinkStation Wi-Fi Module') };
    throw new Error('uventet URL: ' + url);
  });

  const result = await lookupCompetitorName({ ean: null, mpn: '4XC1U87491' });
  assert.deepEqual(result, { name: 'Lenovo ThinkStation Wi-Fi Module', source: 'komplett' });
  assert.ok(calls.every(u => !u.includes('power.no')), 'Power skal aldri kalles uten EAN');
});
