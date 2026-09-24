/**
 * Forny ALSO sesjon-cookie via Playwright.
 * Kjøres av GitHub Actions session-renewal.yml hvert 6. time.
 *
 * Skriver ny cookie tilbake til GitHub Secrets via gh CLI.
 *
 * Krever:
 *   ALSO_USERNAME   — e-post/brukernavn for ALSO-innlogging
 *   ALSO_PASSWORD   — passord
 *   ALSO_TOTP_SECRET — base32-hemmelighet (fra 2FA-oppsettet) til å generere
 *                      6-sifret engangskode. ALSO-portalen krever app-basert
 *                      2FA (TOTP) — uten denne stopper innloggingen på
 *                      OTP-steget. Se CLAUDE.md for hvordan du henter den ut.
 *   GH_TOKEN        — GitHub Personal Access Token med secrets:write
 *   GH_REPO         — "org/repo" format
 */

import { chromium } from 'playwright';
import { TOTP, Secret } from 'otpauth';
import { updateGitHubSecret } from './github-secrets.ts';

const USERNAME = process.env.ALSO_USERNAME;
const PASSWORD = process.env.ALSO_PASSWORD;
// .trim() forsvarer mot en vanlig feilkilde: GitHub sitt Secret-tekstfelt er
// en <textarea>, så et vanlig copy-paste kan lett dra med seg en avsluttende
// linjeskift-tegn som ellers ville gitt en subtilt annerledes (og dermed
// alltid avvist) base32-hemmelighet.
const TOTP_SECRET = process.env.ALSO_TOTP_SECRET?.trim();
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;

if (!USERNAME || !PASSWORD) {
  console.error('ALSO_USERNAME og ALSO_PASSWORD må være satt');
  process.exit(1);
}

console.log('[ALSO] Starter sesjon-fornyelse via Playwright...');

// 2026-09-12: bytter fra headless Chromium til ekte, ikke-headless Google
// Chrome (channel: 'chrome'). Alt annet (secret, felt, klokke, flere
// credentials, WAF) er avkreftet 2026-09-11 — gjenstående mistenkt årsak er
// fingerprint-forskjeller headless Chromium har utover bare navigator.webdriver
// (WebGL-renderer, manglende plugin-liste osv.), som en enkelt maskerings-
// script ikke fanger opp alle av. Ekte, ikke-headless Chrome fjerner hele denne
// kategorien i stedet for å måtte maskere hvert enkelt signal. Kjøres via
// xvfb i session-renewal.yml siden ikke-headless krever en skjerm.
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
});

// Bekreftet 2026-09-11: samme TOTP-kode fungerer umiddelbart i en ekte nettleser,
// og skjemaet (input#otp) er identisk med det vi allerede targeter — så feilen
// ligger ikke i hemmeligheten eller feltvalget. Mistenkt gjenværende årsak:
// headless Chromium eksponerer navigator.webdriver=true og fyller/sender skjemaet
// momentant, som skiller seg fra et menneske. Masker det mest åpenbare signalet
// og skriv koden med realistisk tastetempo i stedet for å sette verdien direkte.
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});

const page = await context.newPage();

// Både portalen (www.also.com) og innloggingen (weblogin.also.com) inneholder
// substrengen "also.com/" — en enkel glob som "**/also.com/**" matcher BEGGE,
// så den kunne aldri skille "innlogget" fra "fortsatt på Keycloak sin
// innloggingsside" (bug funnet 2026-09-10, se CLAUDE.md). Sjekk hostname
// eksplisitt i stedet.
function isAlsoPortalUrl(url: URL): boolean {
  return url.hostname.endsWith('also.com') && !url.hostname.startsWith('weblogin.');
}

// Delt diagnostikk: URL/tittel/synlig-tekst-utdrag, brukt hver gang vi havner
// i en tilstand som verken er "på portalen" eller en kjent feilmelding — slik
// at HVILKEN som helst uventet side (CAPTCHA, "husk denne enheten",
// bot-deteksjon, endret skjema osv.) blir synlig i loggen i stedet for bare
// "Timeout ... exceeded".
async function dumpPageState(page: import('playwright').Page, label: string): Promise<string> {
  const url = page.url();
  const title = await page.title().catch(() => '(ukjent)');
  const bodySnippet = await page
    .locator('body')
    .innerText()
    .then(t => t.replace(/\s+/g, ' ').trim().slice(0, 500))
    .catch(() => '(kunne ikke lese body)');
  console.log(`[ALSO] ${label} — URL: ${url}`);
  console.log(`[ALSO] Sidetittel: ${title}`);
  console.log(`[ALSO] Synlig tekst (utdrag): ${bodySnippet}`);
  return bodySnippet;
}

// Kontoen har en gang blitt midlertidig sperret av ALSO sin egen brute-force-
// beskyttelse etter flere feilede automatiserte forsøk på kort tid
// (2026-09-10, se CLAUDE.md). Sjekk eksplisitt for denne meldingen og gi opp
// UMIDDELBART uten flere forsøk hvis den dukker opp — å fortsette å prøve
// ville bare forlenge sperren eller gjøre kontoen mistenkelig for ALSO.
function checkForLockout(bodySnippet: string): void {
  if (/sperret|midlertidig.*blokkert|too many.*attempts|temporarily.*locked/i.test(bodySnippet)) {
    throw new Error(
      `ALSO har midlertidig sperret innlogging pga. for mange feilede forsøk. IKKE prøv igjen med det samme — vent minst 15 min. Sidetekst: "${bodySnippet}"`
    );
  }
}

try {
  // Diagnostikk: sjekk om GitHub Actions-runneren sin klokke faktisk stemmer med
  // servertiden, FØR noen navigasjon/redirect kan komplisere hvilken respons vi
  // faktisk får headerne fra. TOTP er tidsbasert — en klokke som har driftet ville
  // gjort ALLE genererte koder ugyldige uansett hvor riktig ALSO_TOTP_SECRET er,
  // og ville sett identisk ut som en feil hemmelighet i loggene.
  //
  // Målt mot weblogin.also.com (selve Keycloak-innloggingsserveren), IKKE
  // www.also.com (portalen) — dette er to ulike hoster som kan kjøre på
  // separat infrastruktur med hver sin klokke. Den faktiske 2FA-respons vi
  // fanger senere manglet en Date-header helt (2026-09-11), så vi kan ikke
  // stole på at et tidligere mål mot feil host faktisk representerer
  // klokken til tjenesten som validerer TOTP-koden.
  try {
    // Standard Keycloak "discovery"-endepunkt — garantert å eksistere og svare
    // med en ekte respons (JSON), i motsetning til bare "/" som er dedikert
    // til innloggingsflyten og kan oppføre seg uforutsigbart uten riktige
    // query-parametre.
    const clockCheckUrl =
      'https://weblogin.also.com/auth/realms/also-customers/.well-known/openid-configuration';
    const clockCheckResp = await context.request.get(clockCheckUrl, { maxRedirects: 0 }).catch(() =>
      context.request.get(clockCheckUrl)
    );
    const serverDateHeader = clockCheckResp.headers()['date'];
    if (serverDateHeader) {
      const serverTime = new Date(serverDateHeader).getTime();
      const runnerTime = Date.now();
      const driftSeconds = Math.round((runnerTime - serverTime) / 1000);
      console.log(
        `[ALSO] Klokkesjekk — runner: ${new Date(runnerTime).toISOString()}, server: ${new Date(serverTime).toISOString()}, drift: ${driftSeconds}s`
      );
      if (Math.abs(driftSeconds) > 20) {
        console.log(
          `[ALSO] ⚠️ Klokkedrift på ${driftSeconds}s oppdaget — dette kan alene forklare "Ugyldig engangskode" uavhengig av om hemmeligheten er riktig.`
        );
      }
    } else {
      console.log('[ALSO] Klokkesjekk: fant ingen Date-header i responsen, kunne ikke sammenligne.');
    }
  } catch (clockCheckErr) {
    console.log(`[ALSO] Klokkesjekk feilet (ikke fatalt): ${clockCheckErr}`);
  }

  // Gå til ALSO-søkesiden — redirect til Keycloak-innlogging
  await page.goto('https://www.also.com/ec/cms5/2900/no_NO/search.jsps', {
    waitUntil: 'networkidle',
  });

  // Fyll inn innloggingsskjema
  await page.fill('input[name="username"], input[type="email"], #username', USERNAME);
  await page.fill('input[name="password"], input[type="password"], #password', PASSWORD);
  await page.click('button[type="submit"], input[type="submit"], #kc-login');

  // Vent på enten portalen direkte, eller Keycloak sitt OTP-steg
  const otpSelector = 'input[name="otp"], #otp, input[name="totp"]';
  await Promise.race([
    page.waitForURL(isAlsoPortalUrl, { timeout: 15000 }).catch(() => {}),
    page.waitForSelector(otpSelector, { timeout: 15000 }).catch(() => {}),
  ]);

  if (!isAlsoPortalUrl(new URL(page.url())) && !(await page.locator(otpSelector).first().isVisible().catch(() => false))) {
    const bodySnippet = await dumpPageState(page, 'Uventet tilstand etter brukernavn/passord-innlogging (verken portal eller 2FA-felt synlig)');
    checkForLockout(bodySnippet);
  }

  // Keycloak sin feilmelding når koden avvises — testet mot flere temaer/
  // versjoner siden vi ikke vet nøyaktig hvilken klasse ALSO sin instans
  // bruker. Løkken under logger den faktiske teksten hvis noen av disse
  // treffer, i stedet for bare "timeout" uten forklaring.
  const errorSelector = '#input-error, .pf-c-alert__title, .kc-feedback-text, span.kc-feedback-text, .alert-error';

  const otpField = page.locator(otpSelector).first();
  if (await otpField.isVisible().catch(() => false)) {
    if (!TOTP_SECRET) {
      throw new Error(
        'ALSO ber om 2FA-kode, men ALSO_TOTP_SECRET er ikke satt som miljøvariabel / GitHub Secret'
      );
    }

    // Redusert fra 3 til 1 2026-09-10: ALSO sperret kontoen midlertidig (15 min)
    // etter at gjentatte automatiserte 2FA-forsøk (3 per kjøring, flere test-
    // kjøringer på kort tid) trigget deres egen brute-force-beskyttelse. Ett
    // forsøk er nok til å bekrefte om hemmeligheten faktisk fungerer — flere
    // forsøk per kjøring gjør bare vondt verre hvis den ikke gjør det.
    const MAX_ATTEMPTS = 1;
    let loggedIn = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !loggedIn; attempt++) {
      // Unngå å sende en kode som er i ferd med å utløpe — Keycloak avviser
      // ofte koder i de siste sekundene av et 30-sekunders vindu. Vent til
      // et friskt vindu starter hvis under 5 sek gjenstår.
      const secondsIntoWindow = Math.floor(Date.now() / 1000) % 30;
      if (secondsIntoWindow > 25) {
        const waitMs = (30 - secondsIntoWindow + 1) * 1000;
        console.log(`[ALSO] Venter ${Math.round(waitMs / 1000)}s på nytt TOTP-vindu før forsøk ${attempt}...`);
        await page.waitForTimeout(waitMs);
      }

      const code = new TOTP({ secret: Secret.fromBase32(TOTP_SECRET), digits: 6, period: 30 }).generate();
      console.log(`[ALSO] 2FA-steg oppdaget, sender TOTP-kode (forsøk ${attempt}/${MAX_ATTEMPTS})...`);
      // .pressSequentially() (tidligere .fill()) skriver ett og ett tegn med en
      // liten pause, som ekte tastetrykk — .fill() setter verdien momentant og
      // ser mer "ikke-menneskelig" ut for enhver skjema-logikk som lytter på
      // faktiske tastetrykk-hendelser i stedet for bare sluttverdien.
      await otpField.click();
      await otpField.pressSequentially(code, { delay: 80 });
      await page.waitForTimeout(300 + Math.random() * 400);

      // Diagnostikk: fang selve HTTP-responsen på 2FA-innsendingen (status +
      // ALLE headere), ikke bare Keycloak sin vennlige feiltekst. Hvis en WAF/
      // bot-manager foran Keycloak spesifikt griper inn på 2FA-steget (mistanke
      // etter at feil hemmelighet, feil felt, klokkedrift og flere
      // credentials alle er avkreftet 2026-09-11), etterlater det ofte spor i
      // headerne som ikke vises i den vanlige feilmeldingen.
      const rawResponsePromise = page
        .waitForResponse(
          resp => resp.request().method() === 'POST' && resp.url().includes('login-actions/authenticate'),
          { timeout: 20000 }
        )
        .catch(() => null);

      await page.click('button[type="submit"], input[type="submit"], #kc-login');

      const rawResponse = await rawResponsePromise;
      if (rawResponse) {
        console.log(`[ALSO] Rå 2FA-respons — status: ${rawResponse.status()} ${rawResponse.statusText()}`);
        console.log(`[ALSO] Rå 2FA-respons — headere: ${JSON.stringify(rawResponse.headers())}`);
      } else {
        console.log('[ALSO] Rå 2FA-respons: ingen POST til login-actions/authenticate fanget opp innen tidsfristen.');
      }

      const outcome = await Promise.race([
        page.waitForURL(isAlsoPortalUrl, { timeout: 20000 }).then(() => 'success' as const).catch(() => null),
        page
          .waitForSelector(errorSelector, { timeout: 20000 })
          .then(el => el.innerText())
          .then(text => ({ error: text.trim() }))
          .catch(() => null),
      ]);

      if (outcome === 'success') {
        loggedIn = true;
      } else if (outcome && 'error' in outcome) {
        console.log(`[ALSO] Keycloak avviste koden: "${outcome.error}"`);
        checkForLockout(outcome.error);
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`ALSO 2FA feilet etter ${MAX_ATTEMPTS} forsøk: ${outcome.error}`);
        }
      } else {
        // Verken suksess-navigasjon eller kjent feilmelding-selector innen tidsfristen —
        // dump nok kontekst til å diagnostisere neste gang uten å måtte gjette.
        const bodySnippet = await dumpPageState(page, `Uventet tilstand etter forsøk ${attempt}`);
        checkForLockout(bodySnippet);
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `ALSO 2FA: ingen vellykket navigasjon og ingen kjent feilmelding funnet etter ${MAX_ATTEMPTS} forsøk — se logg over for sidetilstand.`
          );
        }
      }
    }
  }

  // Vent på at ALSO-portalen er ferdig lastet
  await page.waitForURL(isAlsoPortalUrl, { timeout: 30000 });
  await page.waitForLoadState('networkidle');

  console.log('[ALSO] Innlogget. Henter cookies...');

  // Hent alle cookies for also.com og weblogin.also.com
  const cookies = await context.cookies(['https://www.also.com', 'https://weblogin.also.com']);
  const cookieString = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  console.log(`[ALSO] ${cookies.length} cookies hentet`);

  // Verifiser at prisfil er tilgjengelig med disse cookies
  const testResp = await page.evaluate(async (cookie) => {
    const resp = await fetch(
      'https://www.also.com/ec/cms5/2900/pricelistView.do?todo=download&filename=pricelist-1.txt.zip',
      { headers: { Cookie: cookie } }
    );
    return { status: resp.status, contentType: resp.headers.get('content-type') };
  }, cookieString);

  if (testResp.status !== 200) {
    throw new Error(`Cookie-verifisering feilet: HTTP ${testResp.status}`);
  }

  console.log('[ALSO] Cookie verifisert ✓');

  // Lagre til GitHub Secrets
  if (GH_TOKEN && GH_REPO) {
    updateGitHubSecret('ALSO_SESSION_COOKIE', cookieString, GH_TOKEN, GH_REPO);
    console.log('[ALSO] GitHub Secret oppdatert: ALSO_SESSION_COOKIE');
  } else {
    console.log('[ALSO] GH_TOKEN/GH_REPO ikke satt — skriver cookie til stdout');
    console.log('ALSO_SESSION_COOKIE=' + cookieString);
  }

} finally {
  await browser.close();
}
