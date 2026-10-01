export const SITE = 'https://www.braintreevansales.co.uk';
export const LIST_URL_1 = `${SITE}/used-vans`;
export const listUrl = (n) =>
  n <= 1 ? LIST_URL_1 : `${SITE}/search_page.php?location_path=used&sort=h&p=${n}`;
export const DEFAULT_LIST_PAGES = 6;
export const MAX_LIST_PAGES = 10;
export const STORE_CODE = '09512822455352852640';
export const DEALER_ADDRESS = 'Braintree Van Sales, 263 Rayne Road, Braintree CM7 2QF';
export const USER_AGENT =
  'Mozilla/5.0 (compatible; BVS-Feed/1.0; +https://profitablesites.com)';
export const REQUEST_GAP_MS = 20_000;
export const DETAIL_BATCH = 3;
export const STALE_MS = 7 * 24 * 3600 * 1000;
export const SAFETY_RATIO = 0.6;
export const MAX_IMAGES = 10;
export const MAX_FEATURES = 15;
export const ALERT_TO = 'david@profitablesites.com';
