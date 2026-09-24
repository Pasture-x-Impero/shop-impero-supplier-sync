import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupIcecatProduct } from './icecat.ts';

function fakeIcecatResponse(productName: string, brand: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        GeneralInfo: { ProductName: productName, Brand: brand, Title: `${brand} ${productName} full title`, GTIN: [] },
        FeaturesGroups: [],
      },
    }),
  };
}

const NOT_FOUND_RESPONSE = { ok: false, status: 404, json: async () => ({}) };

test('lookupIcecatProduct prioriterer EAN — kaller aldri merke+MPN-endepunktet hvis EAN gir treff', async t => {
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    callCount++;
    assert.ok(url.includes('GTIN='), 'første og eneste kall skal være GTIN-oppslaget');
    return fakeIcecatResponse('ZBook Ultra G1a', 'HP');
  });

  const result = await lookupIcecatProduct({ ean: '197489946966', manufacturer: 'HP', mpn: 'A3ZJ3ET#UUW' });

  assert.equal(result.status, 'matched');
  assert.equal(callCount, 1, 'brand+ProductCode-endepunktet skal aldri kalles når EAN allerede matchet');
});

test('lookupIcecatProduct faller tilbake til basis-MPN (uten regional suffiks) hvis full MPN ikke gir treff', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    if (url.includes('ProductCode=A3ZJ3ET%23UUW') || url.includes('ProductCode=A3ZJ3ET#UUW')) {
      return NOT_FOUND_RESPONSE;
    }
    if (url.includes('ProductCode=A3ZJ3ET')) {
      return fakeIcecatResponse('ZBook Ultra G1a', 'HP');
    }
    return NOT_FOUND_RESPONSE;
  });

  const result = await lookupIcecatProduct({ manufacturer: 'HP', mpn: 'A3ZJ3ET#UUW' });

  assert.equal(result.status, 'matched');
  if (result.status === 'matched') {
    assert.equal(result.data.productName, 'ZBook Ultra G1a');
  }
  assert.equal(calls.length, 2, 'skal ha prøvd full MPN først, deretter basis-MPN');
});

test('lookupIcecatProduct returnerer not_found når ingen steg gir treff (ingen gjetting)', async t => {
  t.mock.method(globalThis, 'fetch', async () => NOT_FOUND_RESPONSE);

  const result = await lookupIcecatProduct({ ean: '000', manufacturer: 'HP', mpn: 'UKJENT#XYZ' });
  assert.equal(result.status, 'not_found');
});

test('lookupIcecatProduct returnerer error (ikke not_found) når alle forsøk feiler på nettverksnivå', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('nettverksfeil');
  });

  const result = await lookupIcecatProduct({ ean: '000', manufacturer: 'HP', mpn: 'A3ZJ3ET#UUW' });
  assert.equal(result.status, 'error');
});

test('lookupIcecatProduct går videre til neste steg selv om et tidligere steg feiler på nettverksnivå', async t => {
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    call++;
    if (call === 1) throw new Error('EAN-oppslag feilet forbigående');
    return fakeIcecatResponse('ZBook Ultra G1a', 'HP');
  });

  const result = await lookupIcecatProduct({ ean: '197489946966', manufacturer: 'HP', mpn: 'A3ZJ3ET#UUW' });
  assert.equal(result.status, 'matched');
});
