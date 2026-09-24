/**
 * Forny isicom.no sesjon-cookie via Playwright.
 * PrestaShop-sesjoner varer ~1 time — fornyes hvert 6. time.
 *
 * Krever:
 *   ISICOM_USERNAME — e-post
 *   ISICOM_PASSWORD — passord
 *   GH_TOKEN        — GitHub PAT med secrets:write
 *   GH_REPO         — "org/repo"
 */

import { chromium } from 'playwright';
import { updateGitHubSecret } from './github-secrets.ts';

const USERNAME = process.env.ISICOM_USERNAME;
const PASSWORD = process.env.ISICOM_PASSWORD;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;

if (!USERNAME || !PASSWORD) {
  console.error('ISICOM_USERNAME og ISICOM_PASSWORD må være satt');
  process.exit(1);
}

console.log('[isicom] Starter sesjon-fornyelse via Playwright...');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
});

const page = await context.newPage();

try {
  // Gå til innloggingssiden
  await page.goto('https://www.isicom.no/logg-inn', { waitUntil: 'networkidle' });

  // Fyll inn innlogging
  await page.fill('input[name="email"], input[type="email"]', USERNAME);
  await page.fill('input[name="passwd"], input[type="password"]', PASSWORD);
  await page.click('button[type="submit"], input[type="submit"], .login-form button');

  // Vent på at innlogging er fullført
  await page.waitForURL('**/isicom.no/**', { timeout: 15000 });
  await page.waitForLoadState('networkidle');

  // Sjekk at vi er logget inn
  const isLoggedIn = await page.evaluate(() =>
    !document.querySelector('.login-form') && !!document.querySelector('.logout, .user-info')
  );

  if (!isLoggedIn) {
    throw new Error('isicom: Innlogging feilet — sjekk ISICOM_USERNAME og ISICOM_PASSWORD');
  }

  // Hent cookies
  const cookies = await context.cookies(['https://www.isicom.no']);
  const relevantCookies = cookies.filter(c =>
    c.name === 'PHPSESSID' || c.name.startsWith('PrestaShop-')
  );

  const cookieString = relevantCookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log(`[isicom] ${relevantCookies.length} relevante cookies hentet`);

  // Verifiser cookie mot produktsiden (priser skal være synlige)
  const testPage = await context.newPage();
  await testPage.goto('https://www.isicom.no/39-jabra?page=1');
  const hasPrices = await testPage.evaluate(() =>
    !!document.querySelector('.price, .product-price')
  );

  if (!hasPrices) {
    console.warn('[isicom] ⚠️ Priser ikke synlige etter innlogging');
  } else {
    console.log('[isicom] Cookie verifisert — priser er synlige ✓');
  }

  // Lagre til GitHub Secrets
  if (GH_TOKEN && GH_REPO) {
    updateGitHubSecret('ISICOM_SESSION_COOKIE', cookieString, GH_TOKEN, GH_REPO);
    console.log('[isicom] GitHub Secret oppdatert: ISICOM_SESSION_COOKIE');
  } else {
    console.log('ISICOM_SESSION_COOKIE=' + cookieString);
  }

} finally {
  await browser.close();
}
