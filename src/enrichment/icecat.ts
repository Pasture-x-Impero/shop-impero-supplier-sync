/**
 * Icecat åpen katalog — kilde for berikelse av produktnavn/spesifikasjoner.
 *
 * Offentlig, gratis "openIcecat-live"-bruker (samme som Lovable sin egen
 * import-icecat-images Edge Function allerede bruker for bilder) — ingen
 * hemmelighet, kun brukernavnet i URL-en.
 *
 * Eksakt-treff-API: gitt en EAN eller et merke+MPN-par returnerer Icecat
 * enten nøyaktig én post eller ingen treff i det hele tatt — det finnes
 * ingen fuzzy-scoring å ta stilling til her. "Sikker match" = Icecat
 * returnerte en post for akkurat den identifikatoren, ingenting annet.
 */

const ICECAT_BASE = 'https://live.icecat.biz/api';
const ICECAT_USERNAME = process.env.ICECAT_USERNAME || 'openIcecat-live';

export interface IcecatFeature {
  groupName: string;
  featureName: string;
  value: string;
  presentationValue?: string;
}

export interface IcecatMatch {
  productName: string; // GeneralInfo.ProductName — kort modellnavn, ALDRI Title
  brand: string;
  title: string; // GeneralInfo.Title — kun til diagnostikk, brukes aldri som `name`
  gtins: string[];
  category?: string;
  features: IcecatFeature[];
}

export type IcecatLookupResult =
  | { status: 'matched'; data: IcecatMatch }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

interface IcecatApiResponse {
  data?: {
    GeneralInfo?: {
      ProductName?: string;
      Brand?: string;
      Title?: string;
      GTIN?: string[];
      Category?: { Name?: { Value?: string } };
    };
    FeaturesGroups?: Array<{
      FeatureGroup?: { Name?: { Value?: string } };
      Features?: Array<{
        Feature?: { Name?: { Value?: string } };
        Value?: string;
        PresentationValue?: string;
      }>;
    }>;
  };
}

function parseMatch(body: IcecatApiResponse): IcecatMatch | null {
  const info = body.data?.GeneralInfo;
  if (!info?.ProductName) return null;

  const features: IcecatFeature[] = [];
  for (const group of body.data?.FeaturesGroups ?? []) {
    const groupName = group.FeatureGroup?.Name?.Value ?? '';
    for (const feature of group.Features ?? []) {
      const featureName = feature.Feature?.Name?.Value ?? '';
      const value = feature.Value ?? feature.PresentationValue ?? '';
      if (!featureName || !value) continue;
      features.push({ groupName, featureName, value, presentationValue: feature.PresentationValue });
    }
  }

  return {
    productName: info.ProductName,
    brand: info.Brand ?? '',
    title: info.Title ?? info.ProductName,
    gtins: info.GTIN ?? [],
    category: info.Category?.Name?.Value,
    features,
  };
}

async function callIcecat(params: Record<string, string>): Promise<IcecatLookupResult> {
  const url = new URL(ICECAT_BASE);
  url.searchParams.set('UserName', ICECAT_USERNAME);
  url.searchParams.set('Language', 'EN');
  url.searchParams.set('Content', 'All');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  try {
    const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });

    if (resp.status === 404) return { status: 'not_found' };
    if (!resp.ok) return { status: 'error', message: `Icecat HTTP ${resp.status}` };

    const body = (await resp.json().catch(() => null)) as IcecatApiResponse | null;
    if (!body) return { status: 'error', message: 'Icecat: ugyldig JSON-svar' };

    const match = parseMatch(body);
    return match ? { status: 'matched', data: match } : { status: 'not_found' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// Regionale suffikser TD Synnex/ALSO bruker på MPN, f.eks. "A3ZJ3ET#UUW" —
// Icecat sin katalog fører typisk kun basis-MPN-en uten dette.
function stripMpnSuffix(mpn: string): string | null {
  const stripped = mpn.replace(/#.+$/, '');
  return stripped !== mpn ? stripped : null;
}

/**
 * Slår opp ett produkt mot Icecat: EAN → merke+MPN → merke+basis-MPN (uten
 * regional suffiks). Kaster aldri. En forbigående feil på ett steg stopper
 * ikke kjeden — den prøver neste fallback likevel. Returnerer 'error' kun
 * hvis ALLE forsøkte steg feilet (aldri et rent 'not_found'-treff) — dette
 * er signalet som forteller den kallende koden at resultatet IKKE skal
 * caches som "ikke funnet", siden det ikke er en bekreftet ikke-match.
 */
export async function lookupIcecatProduct(input: {
  ean?: string | null;
  manufacturer?: string;
  mpn: string;
}): Promise<IcecatLookupResult> {
  const attempts: Array<() => Promise<IcecatLookupResult>> = [];

  if (input.ean) {
    attempts.push(() => callIcecat({ GTIN: input.ean! }));
  }
  if (input.manufacturer) {
    attempts.push(() => callIcecat({ Brand: input.manufacturer!, ProductCode: input.mpn }));
    const baseMpn = stripMpnSuffix(input.mpn);
    if (baseMpn) {
      attempts.push(() => callIcecat({ Brand: input.manufacturer!, ProductCode: baseMpn }));
    }
  }

  let hadError = false;
  for (const attempt of attempts) {
    const result = await attempt();
    if (result.status === 'matched') return result;
    if (result.status === 'error') hadError = true;
  }

  return hadError ? { status: 'error', message: 'Icecat: alle oppslagsforsøk feilet' } : { status: 'not_found' };
}
