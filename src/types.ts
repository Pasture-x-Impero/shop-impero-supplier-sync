// Felles datatyper for alle leverandør-integrasjoner

export interface SupplierProduct {
  mpn: string;                  // Produsentens P/N (primær nøkkel for matching)
  ean?: string | null;          // EAN-13
  supplier: 'also' | 'tdsynnex' | 'isicom';
  supplier_sku?: string;        // Leverandørens interne artikkelnummer
  manufacturer?: string;
  name: string;
  // Kort, kundevennlig navn + source_name/specs — satt av enrichProducts()
  // (src/enrichment/index.ts) via Icecat, IKKE av fetcherne selv. `name`
  // overskrives til det korte navnet når et sikkert treff finnes; `source_name`
  // er alltid distributørens uendrede originaltekst. Se planen
  // (zazzy-splashing-lemon.md) for hele designet.
  source_name?: string;
  specs?: Record<string, string>;
  // Rå distributørtekst (navn + ev. lengre beskrivelse) — brukt KUN til
  // tastaturoppsett-nøkkelordsøket i enrichProducts, siden Icecat sin
  // generiske katalogdata ikke har noe region-/språkspesifikt tastaturfelt.
  source_text?: string;
  // Bilde-URL hos en konkurrent (Power/Komplett/Dustin) — satt av
  // enrichProducts() KUN når produktet mangler bilde helt (Icecat har heller
  // ingen bildedata her, kun tekst/specs). Se src/enrichment/competitor-name.ts.
  image_url?: string;
  price_ex_vat?: number | null; // Innkjøpspris ekskl. 25% MVA (NOK) — mappes til product_supplier_prices.purchase_price
  price_inc_vat?: number | null; // Innkjøpspris inkl. MVA (NOK)
  available_qty?: number;
  next_delivery_date?: string | null;
  category1?: string;
  category2?: string;
  updated_at: string;
}

// Konkurrent-pris — brukt av prisings-motoren (src/pricing/) til å sette
// konkurransedyktig utsalgspris på Produktutvalg. Matches på EAN der det er
// tilgjengelig (Power, Elkjøp, Komplett — se CLAUDE.md), MPN som unntak for
// Eplehuset (ingen EAN i deres offentlige Shopify-feed).
export interface MarketPrice {
  ean?: string | null;
  mpn: string;
  source: 'komplett' | 'dustin' | 'power' | 'eplehuset' | 'elkjop';
  source_sku?: string;
  name?: string;
  price_inc_vat?: number | null;
  price_ex_vat?: number | null;  // Dustin: direkte eks MVA
  available?: boolean;
  image_url?: string;
  product_url?: string;
  updated_at: string;
}

export interface SupplierSyncResult {
  supplier: string;
  productsUpdated: number;   // Eksisterende produkt (matchet på mpn) fikk oppdatert pris
  productsCreated: number;   // Nytt, skjult produkt opprettet for kjent produsent
  productsSkipped: number;   // Ingen mpn/pris, eller ukjent/umatchet produsent
  errors: string[];
  duration_ms: number;
}
