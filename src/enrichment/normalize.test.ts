import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortenName, buildSpecs, detectKeyboardLayout, isMeaningfulModelName } from './normalize.ts';
import type { IcecatMatch } from './icecat.ts';

function feature(groupName: string, featureName: string, value: string) {
  return { groupName, featureName, value, presentationValue: value };
}

const ZBOOK_MATCH: IcecatMatch = {
  productName: 'ZBook Ultra G1a',
  brand: 'HP',
  title: 'HP ZBook Ultra 14 inch G1a Mobile Workstation PC',
  gtins: ['197489946966'],
  category: 'Laptops',
  features: [
    feature('Design', 'Product type', 'Mobile workstation'),
    feature('Design', 'Product colour', 'Silver'),
    feature('Processor', 'Processor family', 'AMD Ryzen AI Max+ PRO'),
    feature('Processor', 'Processor model', 'PRO 395'),
    feature('Memory', 'Internal memory', '128 GB'),
    feature('Storage', 'Total storage capacity', '4 TB'),
    feature('Storage', 'Storage media', 'SSD'),
    feature('Graphics', 'Discrete graphics card model', 'Not available'),
    feature('Graphics', 'On-board graphics card model', 'AMD Radeon 8060S'),
    feature('Display', 'Display diagonal', '35.6 cm (14")'),
    feature('Display', 'Display resolution', '2880 x 1800 pixels'),
    feature('Display', 'Touchscreen', 'Yes'),
    feature('Software', 'Operating system installed', 'Windows 11 Pro'),
    feature('Network', 'Wi-Fi standards', 'Wi-Fi 7 (802.11be)'),
    feature('Network', 'Bluetooth', 'Yes'),
    feature('Network', 'Bluetooth version', '5.4'),
  ],
};

test('shortenName prefikser merke når modellnavnet ikke allerede starter med det', () => {
  assert.equal(shortenName('ZBook Ultra G1a', 'HP', {}), 'HP ZBook Ultra G1a');
});

test('shortenName dupliserer ikke merket når modellnavnet allerede starter med det', () => {
  assert.equal(shortenName('HP ZBook Ultra G1a', 'HP', {}), 'HP ZBook Ultra G1a');
});

test('shortenName skiller "HP" fra "HPE ProLiant" (ordgrense, ikke prefiks-substring)', () => {
  assert.equal(shortenName('HPE ProLiant DL380', 'HP', {}), 'HP HPE ProLiant DL380');
});

test('shortenName legger til spec-highlights (prosessor + minne/lagring) i Lenovo-stil', () => {
  const specs = buildSpecs(ZBOOK_MATCH, undefined);
  const name = shortenName(ZBOOK_MATCH.productName, ZBOOK_MATCH.brand, specs);
  assert.equal(name, 'HP ZBook Ultra G1a — Ryzen AI Max+ PRO 395, 128GB/4TB');
});

test('shortenName uten highlights faller tilbake til bare modellnavn', () => {
  assert.equal(shortenName('ZBook Ultra G1a', 'HP', {}), 'HP ZBook Ultra G1a');
});

test('buildSpecs fyller alle ni Icecat-baserte nøkler for HP-eksempelet', () => {
  const specs = buildSpecs(ZBOOK_MATCH, undefined);
  assert.deepEqual(specs, {
    produkttype: 'Mobile workstation',
    prosessor: 'AMD Ryzen AI Max+ PRO 395',
    minne: '128 GB',
    lagring: '4 TB SSD',
    grafikk: 'AMD Radeon 8060S',
    skjerm: '35.6 cm (14"), 2880 x 1800 pixels, berøringsskjerm',
    operativsystem: 'Windows 11 Pro',
    nettverk: 'Wi-Fi 7 (802.11be), Bluetooth 5.4',
    farge: 'Silver',
  });
  assert.ok(!('tastaturoppsett' in specs), 'tastaturoppsett skal utelates uten rå kildetekst');
});

test('buildSpecs legger til tastaturoppsett kun når nøkkelord finnes i rå distributørtekst', () => {
  const withKeyword = buildSpecs(ZBOOK_MATCH, 'HP ZBook Ultra G1a ... Nordic keyboard - Windows 11 Pro');
  assert.equal(withKeyword.tastaturoppsett, 'Nordisk');

  const withoutKeyword = buildSpecs(ZBOOK_MATCH, 'HP ZBook Ultra G1a - some description with no layout info');
  assert.ok(!('tastaturoppsett' in withoutKeyword));
});

test('buildSpecs utelater grafikk-verdier som er Icecat sin "Not available"-placeholder', () => {
  const specs = buildSpecs(ZBOOK_MATCH, undefined);
  assert.equal(specs.grafikk, 'AMD Radeon 8060S'); // ikke "Not available" fra discrete-feltet
});

test('isMeaningfulModelName avviser et Icecat-navn som bare speiler artikkelnummeret', () => {
  assert.equal(isMeaningfulModelName('DX0L8AT', 'DX0L8AT#UUW'), false);
  assert.equal(isMeaningfulModelName('dx0l8at', 'DX0L8AT'), false);
});

test('isMeaningfulModelName godtar et ekte modellnavn', () => {
  assert.equal(isMeaningfulModelName('ZBook Ultra G1a', 'A3ZJ3ET#UUW'), true);
});

test('detectKeyboardLayout gjenkjenner flere språkvarianter', () => {
  assert.equal(detectKeyboardLayout('Nordic keyboard'), 'Nordisk');
  assert.equal(detectKeyboardLayout('Norwegian layout'), 'Norsk');
  assert.equal(detectKeyboardLayout('French AZERTY keyboard'), 'Fransk (AZERTY)');
  assert.equal(detectKeyboardLayout('No layout info here'), undefined);
  assert.equal(detectKeyboardLayout(undefined), undefined);
});
