/**
 * Bygger kort produktnavn (modell + spec-highlights) og strukturerte,
 * norske specs fra et Icecat-treff — se planen
 * (zazzy-splashing-lemon.md) for hele designet og §4/§5 spesifikt.
 *
 * Prinsipp gjennomgående: en verdi tas KUN med hvis kildefeltet faktisk
 * finnes i Icecat sitt svar (eller, for tastaturoppsett, faktisk nevnes i
 * distributørens egen rå tekst) — aldri gjettet, aldri satt til en tom
 * placeholder-streng.
 */

import type { IcecatFeature, IcecatMatch } from './icecat.ts';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForComparison(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

// Enkelte Icecat-poster har intet reelt marketingnavn og speiler i stedet
// bare tilbake artikkelnummeret selv som ProductName (bekreftet i produksjon
// 2026-09-20, f.eks. MPN "DX0L8AT" -> ProductName "DX0L8AT") — å vise dette
// som om det var et "kort, kundevennlig navn" ville vært misvisende, ikke en
// reell berikelse. Sammenligner mot både full og suffiks-strippet MPN.
export function isMeaningfulModelName(productName: string, mpn: string): boolean {
  const normalizedProductName = normalizeForComparison(productName);
  const normalizedMpn = normalizeForComparison(mpn);
  const baseMpn = mpn.replace(/#.+$/, '');
  return normalizedProductName !== normalizedMpn && normalizedProductName !== normalizeForComparison(baseMpn);
}

// Icecat sine egne placeholder-verdier for et felt som teknisk finnes, men
// ikke har noe reelt svar ("Discrete graphics card model" = "Not available"
// på en maskin med kun on-board grafikk, f.eks.) — behandles som fraværende,
// ikke som en gyldig spec-verdi.
const PLACEHOLDER_VALUES = new Set(['not available', 'n/a']);

function findFeature(features: IcecatFeature[], groupPattern: RegExp, namePatterns: RegExp[]): string | undefined {
  for (const namePattern of namePatterns) {
    const hit = features.find(f => groupPattern.test(f.groupName) && namePattern.test(f.featureName));
    if (hit) {
      const value = (hit.presentationValue || hit.value)?.trim();
      if (value && !PLACEHOLDER_VALUES.has(value.toLowerCase())) return value;
    }
  }
  return undefined;
}

// Slår sammen to Icecat-tekstfelt uten å duplisere et overlappende
// ord-suffiks/prefiks — f.eks. "AMD Ryzen AI Max+ PRO" + "PRO 395" skal bli
// "AMD Ryzen AI Max+ PRO 395", ikke "...PRO PRO 395". Ren tekstformatering
// (ingen gjetting av selve verdiene, kun unngår et lesbarhets-duplikat).
function joinDedupe(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const aWords = a.trim().split(/\s+/);
  const bWords = b.trim().split(/\s+/);
  let overlap = 0;
  for (let i = 1; i <= Math.min(aWords.length, bWords.length); i++) {
    if (aWords.slice(-i).join(' ').toLowerCase() === bWords.slice(0, i).join(' ').toLowerCase()) overlap = i;
  }
  const rest = bWords.slice(overlap).join(' ');
  return [a.trim(), rest].filter(Boolean).join(' ');
}

// Gjør Icecat sine formaterte spec-verdier ("32 GB", "1000 GB SSD") om til
// korte visningsformer ("32GB", "1TB") for navne-highlights. Returnerer
// undefined (ikke en halvveis/feilformatert streng) hvis verdien ikke er på
// et gjenkjennelig GB/TB-format — bevisst konservativt, se
// "no guessing"-prinsippet i planen.
function compactUnit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tbMatch = value.match(/([\d.]+)\s*TB/i);
  if (tbMatch) return `${tbMatch[1]}TB`;
  const gbMatch = value.match(/([\d.]+)\s*GB/i);
  if (!gbMatch) return undefined;
  const gb = parseFloat(gbMatch[1]);
  if (gb >= 1000 && gb % 1000 === 0) return `${gb / 1000}TB`;
  return `${gb}GB`;
}

// Feltnavn bekreftet mot ekte Icecat-respons 2026-09-20 (HP ZBook Ultra
// G1a, A3ZJ3ET): "Display diagonal" gir allerede en ferdig formatert streng
// med BÅDE cm og tommer ("35.6 cm (14\")") — trengs ingen egen "-tegn
// syntetisering, i motsetning til en tidligere anntakelse her. "(metric)"-
// varianten (kun cm) brukes kun som fallback hvis hovedfeltet mangler.
function buildSkjerm(features: IcecatFeature[]): string | undefined {
  const size = findFeature(features, /display/i, [/^display diagonal$/i, /diagonal \(metric\)/i]);
  const resolution = findFeature(features, /display/i, [/display resolution/i, /native resolution/i]);
  const touch = findFeature(features, /display/i, [/touchscreen/i]);

  const parts: string[] = [];
  if (size) parts.push(size);
  if (resolution) parts.push(resolution);

  let result = parts.join(', ');
  if (touch && /^(yes|ja|true)$/i.test(touch)) {
    result = result ? `${result}, berøringsskjerm` : 'Berøringsskjerm';
  }
  return result || undefined;
}

// "Bluetooth" alene er et rent ja/nei-felt ("Yes") — versjonsnummeret ligger
// i det egne feltet "Bluetooth version". Ingen fallback til det bare
// ja/nei-feltet, siden "Bluetooth Yes" ikke er en meningsfull spec-verdi.
function buildNettverk(features: IcecatFeature[]): string | undefined {
  const wifi = findFeature(features, /network|wireless/i, [/wi-?fi standards?/i, /wireless lan/i]);
  const bluetoothVersion = findFeature(features, /network|wireless/i, [/bluetooth version/i]);

  const parts: string[] = [];
  if (wifi) parts.push(/wi-?fi/i.test(wifi) ? wifi : `Wi-Fi ${wifi}`);
  if (bluetoothVersion) parts.push(`Bluetooth ${bluetoothVersion}`);
  return parts.length ? parts.join(', ') : undefined;
}

// "Discrete graphics card model"/"On-board graphics card model" — ekte felt
// bekreftet 2026-09-20. Foretrekker diskret GPU hvis den faktisk finnes
// (ikke placeholderen "Not available"), ellers on-board.
function buildGrafikk(features: IcecatFeature[]): string | undefined {
  const discrete = findFeature(features, /graphics/i, [/discrete graphics card model/i]);
  const onboard = findFeature(features, /graphics/i, [/on-board graphics card model/i]);
  return discrete ?? onboard;
}

// "Total storage capacity" + "Storage media" (SSD/HDD) kombinert, f.eks.
// "4 TB SSD" — begge felt bekreftet 2026-09-20.
function buildLagring(features: IcecatFeature[]): string | undefined {
  const capacity = findFeature(features, /storage/i, [/total storage capacity/i, /storage capacity/i]);
  const media = findFeature(features, /storage/i, [/storage media/i]);
  if (!capacity) return undefined;
  return media ? `${capacity} ${media}` : capacity;
}

// "Processor family" ("AMD Ryzen AI Max+ PRO") + "Processor model" ("PRO
// 395") slått sammen med overlapp-dedup til "AMD Ryzen AI Max+ PRO 395" —
// bekreftet 2026-09-20 at verken felt alene gir en brukbar fullt navn.
function buildProsessor(features: IcecatFeature[]): string | undefined {
  const family = findFeature(features, /processor/i, [/processor family/i]);
  const model = findFeature(features, /processor/i, [/processor model/i]);
  return joinDedupe(family, model) ?? findFeature(features, /processor/i, [/^processor$/i]);
}

// Nøkkelordsøk for tastaturoppsett — Icecat sin generiske katalogdata har
// INGEN region-/språkspesifikt tastatur-felt (bekreftet ved direkte testing),
// så dette må komme fra distributørens egen rå tekst i stedet. Ordgrense-
// matchet og case-insensitive. Bare-korte landskoder ("US"/"UK") er bevisst
// krevd sammen med ordet "keyboard" for å unngå falske positiver mot f.eks.
// garantiland-koder eller andre 2-bokstavs-forekomster i fritekst — stram
// inn/utvid denne listen videre hvis testing mot ekte distributørtekst (se
// planens §8) viser behov for det.
const KEYBOARD_KEYWORDS: [RegExp, string][] = [
  [/\bnordic\b|\bnordisk\b/i, 'Nordisk'],
  [/\bnorsk\b|\bnorwegian\b/i, 'Norsk'],
  [/\bswedish\b|\bsvensk\b/i, 'Svensk'],
  [/\bdanish\b|\bdansk\b/i, 'Dansk'],
  [/\bfinnish\b|\bsuomi\b/i, 'Finsk'],
  [/\bqwertz\b|\bgerman keyboard\b/i, 'Tysk (QWERTZ)'],
  [/\bazerty\b|\bfrench keyboard\b/i, 'Fransk (AZERTY)'],
  [/\bUK keyboard\b|\bbritish keyboard\b/i, 'UK'],
  [/\bUS keyboard\b|\binternational english\b/i, 'US'],
];

export function detectKeyboardLayout(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const [pattern, label] of KEYBOARD_KEYWORDS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

/**
 * Bygger `specs`-objektet fra et Icecat-treff. `rawSourceText` er
 * distributørens egen rå tekst (SupplierProduct.source_text ?? name),
 * brukt kun til tastaturoppsett-søket.
 */
export function buildSpecs(match: IcecatMatch, rawSourceText: string | undefined): Record<string, string> {
  const specs: Record<string, string> = {};
  const features = match.features;

  // "Product type" (Design-gruppen, f.eks. "Mobile workstation") er mer
  // spesifikk enn GeneralInfo.Category ("Laptops") når den finnes.
  const produkttype = findFeature(features, /design/i, [/^product type$/i]) ?? match.category;
  if (produkttype) specs.produkttype = produkttype;

  const prosessor = buildProsessor(features);
  if (prosessor) specs.prosessor = prosessor;

  const minne = findFeature(features, /memory/i, [/total memory/i, /internal memory/i]);
  if (minne) specs.minne = minne;

  const lagring = buildLagring(features);
  if (lagring) specs.lagring = lagring;

  const grafikk = buildGrafikk(features);
  if (grafikk) specs.grafikk = grafikk;

  const skjerm = buildSkjerm(features);
  if (skjerm) specs.skjerm = skjerm;

  const os = findFeature(features, /software/i, [/operating system/i]);
  if (os) specs.operativsystem = os;

  const nettverk = buildNettverk(features);
  if (nettverk) specs.nettverk = nettverk;

  const farge = findFeature(features, /design/i, [/product colour/i, /housing colour/i, /^colour$/i]);
  if (farge) specs.farge = farge;

  const tastaturoppsett = detectKeyboardLayout(rawSourceText);
  if (tastaturoppsett) specs.tastaturoppsett = tastaturoppsett;

  return specs;
}

/**
 * Kort, kundevennlig navn: merke + modellnavn (uten duplisering hvis
 * modellnavnet allerede starter med merket) + korte spec-highlights
 * (prosessor, minne/lagring) — samme mønster som Lenovo-piloten
 * ("ThinkStation P3 Tiny Gen 2 — Core Ultra 7 265, 16GB/512GB"), bekreftet
 * av bruker som ønsket format fremfor et bart modellnavn.
 */
export function shortenName(
  icecatProductName: string,
  brand: string | undefined,
  specs: Record<string, string>
): string {
  const rawModel = icecatProductName.trim();
  const model = (() => {
    if (!brand?.trim()) return rawModel;
    // Ordgrense-sjekk hindrer falske positiver som "HPE ProLiant" mot
    // merket "HP" — kun et fullt ledende token teller som "allerede prefikset".
    const brandPattern = new RegExp(`^${escapeRegExp(brand.trim())}(\\b|\\s|$)`, 'i');
    return brandPattern.test(rawModel) ? rawModel : `${brand.trim()} ${rawModel}`;
  })();

  // Dropper redundant merkenavn foran prosessoren i highlighten ("Intel
  // Core Ultra 7 265" -> "Core Ultra 7 265") — ren tekstformatering, ikke gjetting.
  const cpu = specs.prosessor?.replace(/^(Intel|AMD|Qualcomm)\s+/i, '');
  const ram = compactUnit(specs.minne);
  const storage = compactUnit(specs.lagring);
  const ramStorage = ram && storage ? `${ram}/${storage}` : undefined;

  const highlights = [cpu, ramStorage].filter((v): v is string => Boolean(v));
  return highlights.length ? `${model} — ${highlights.join(', ')}` : model;
}
