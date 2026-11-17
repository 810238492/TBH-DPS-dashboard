// Fetch TaskBarHero (Steam appid 3678970) Community Market prices into prices.json.
// Catalog/listing metadata comes from market/search/render; verified CNY prices come from
// priceoverview. The local Windows updater publishes the result to the `data` branch.
import { readFile, writeFile } from 'node:fs/promises';

const APPID = 3678970;
const STEAM_CURRENCY = 23; // CNY / Chinese Renminbi (yuan)
const CURRENCY_SYMBOL = '¥';
const PER = 100;            // Steam caps search/render at 100 per page
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRICE_BATCH_COUNT = 20;
const UA = 'Mozilla/5.0 (tbh-prices-cron; +https://github.com/WarmBed/TBH-DPS-dashboard)';

// Route Steam through the optional Cloudflare Worker when configured. For scheduled local runs,
// leave PROXY_BASE unset so Steam sees the user's normal network instead of a rate-limited CI IP.
const PROXY_BASE = (process.env.PROXY_BASE || '').replace(/\/+$/, '');
const PROXY_KEY = process.env.PROXY_KEY || '';
const VIA_PROXY = !!PROXY_BASE;
const PROXY_H = PROXY_KEY ? { 'x-proxy-key': PROXY_KEY } : {};
function searchUrl(start) {
  const q = `appid=${APPID}&currency=${STEAM_CURRENCY}&norender=1&count=${PER}&start=${start}&sort_column=name&sort_dir=asc`;
  return VIA_PROXY ? `${PROXY_BASE}/steam/search?${q}` : `https://steamcommunity.com/market/search/render/?${q}`;
}
function priceUrl(name) {
  const q = `appid=${APPID}&currency=${STEAM_CURRENCY}&market_hash_name=${encodeURIComponent(name)}`;
  return VIA_PROXY ? `${PROXY_BASE}/steam/price?${q}` : `https://steamcommunity.com/market/priceoverview/?${q}`;
}

async function page(start) {
  // sort_column=name keeps the order STABLE across calls so each start-window covers a disjoint slice.
  const res = await fetch(searchUrl(start), { headers: { 'User-Agent': UA, ...PROXY_H }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`steam HTTP ${res.status} at start=${start}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const items = {};
let catalogAt = 0;
try {
  const previous = JSON.parse(await readFile('prices.json', 'utf8'));
  const stamp = Number(previous.catalogAt || previous.cachedAt || 0);
  if (previous.appid === APPID && previous.items && Date.now() - stamp < CATALOG_MAX_AGE_MS) {
    for (const [name, v] of Object.entries(previous.items)) {
      items[name] = {
        qty: v.qty || 0, dispName: v.dispName || name, color: v.color || null,
        icon: v.icon || null, type: v.type || null,
      };
    }
    catalogAt = stamp;
    console.log(`[prices] reused ${Object.keys(items).length} catalog entries refreshed within 24h`);
  }
} catch { /* no usable prior feed → discover the catalog from Steam */ }
let start = 0, maxTotal = 0, guard = 0, sinceNew = 0, lastCount = 0;
// Steam's market search is hostile to completeness: total_count is FLAKY+inflated (151 one call, 112 the
// next; counts delisted/0-listing entries it never actually returns), it caps the page at ~10 regardless
// of count=, the result ORDER shifts between calls (so a fixed start-window misses items that moved), and
// unauthenticated/CI bursts get rate-limited with short/empty pages. So we SWEEP with wrap-around and
// dedup-accumulate: page forward, wrap back to 0 at the end, and keep going until N consecutive pages add
// NOTHING new (the real "we've seen everything Steam will give us" signal). Generous jittered sleeps keep
// us under the throttle so CI catches the same ~full set a single home IP does.
const STALL = 14;          // stop after this many consecutive pages with no new item
const MAX_PAGES = 200;     // hard backstop
while (!Object.keys(items).length && guard++ < MAX_PAGES) {
  let j = null, results = null;
  let lastError = 'invalid Steam response';
  for (let attempt = 0; attempt < 6; attempt++) {
    try { j = await page(start); } catch (error) { lastError = error?.message || String(error); j = null; }
    if (j && j.success === true && Array.isArray(j.results)) {
      results = j.results;
      if (results.length > 0 || attempt >= 3) break;   // accept non-empty now; empty only after retries
    }
    await sleep(4000 * (attempt + 1) + Math.floor(Math.random() * 1500));   // back off + jitter, retry same start
    j = null; results = null;
  }
  if (!j) throw new Error(`steam kept failing at start=${start} (got ${Object.keys(items).length}; last error: ${lastError})`);
  if (typeof j.total_count === 'number' && j.total_count > 0) maxTotal = Math.max(maxTotal, j.total_count);
  results = results || [];
  for (const r of results) {
    const name = r.hash_name || r.name;
    if (!name) continue;
    // asset_description carries the display name, rarity color, icon and type — captured so the web
    // terminal can build its catalog from Steam directly (no tbh-market for anything but the order book).
    const ad = r.asset_description || {};
    items[name] = {
      // search/render returns prices in the caller's wallet currency even when currency=23 is set.
      // Keep only discovery metadata here; priceoverview below supplies the actual CNY amount.
      qty: r.sell_listings ?? 0,
      dispName: ad.name || name, color: ad.name_color || null, icon: ad.icon_url || null, type: ad.type || null,
    };
  }
  const c = Object.keys(items).length;
  if (c > lastCount) { sinceNew = 0; lastCount = c; } else sinceNew++;
  if (sinceNew >= STALL) break;                                   // dry — exhausted what Steam returns
  start += results.length || 10;                                 // advance by what we got (Steam pages ~10)
  if (maxTotal > 0 && start >= maxTotal) start = 0;              // wrap to re-catch items that shifted order
  await sleep(VIA_PROXY ? 150 : 2500 + Math.floor(Math.random() * 1500));   // CF egress isn't throttled → no need to pace
}
// total_count is inflated and unreachable, so it's NOT the completeness signal — the STALL above is.
// Guard only against a clearly-truncated run (hard rate-limit) by refusing to ship a near-empty feed.
const gotCount = Object.keys(items).length;
if (guard) catalogAt = Date.now();
if (guard) console.log(`[prices] fetched ${gotCount} unique items in ${guard} pages (steam total_count reported up to ${maxTotal})`);
if (gotCount < 50) { console.error(`[prices] ABORT: only ${gotCount} items — Steam rate-limited the run; keeping the previous feed.`); process.exit(1); }

// ---- price history (item-major). Each item keeps a rolling [[tMs, minorUnits], ...] series in
// history.json. Old USD history and tbh-market's unqualified history cannot safely be mixed with CNY,
// so history starts fresh after a currency change and accumulates Steam CNY observations forward.
const now = Date.now();
const DAY = 86400000;
const HISTORY_DAYS = 8;
const SAMPLE_GAP_MS = 25 * 60 * 1000;      // ~30min spacing (one point per cron run) for intraday timeframes
const HIST_WINDOW_MS = 7 * DAY;            // window shipped to the plugin
const REPO = process.env.GITHUB_REPOSITORY || 'WarmBed/TBH-DPS-dashboard';
const HISTORY_URL = `https://raw.githubusercontent.com/${REPO}/data/history.json`;

let history = { currencyCode: STEAM_CURRENCY, items: {}, vol: { at: 0, items: {} }, priceBatchCursor: 0 };
try {
  history = JSON.parse(await readFile('history.json', 'utf8'));
} catch {
  try {
    const r = await fetch(HISTORY_URL, { headers: { 'User-Agent': UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } });
    if (r.ok) { const j = await r.json(); if (j && typeof j === 'object') history = j; }
  } catch { /* first run / 404 -> empty history */ }
}
if (!history.items || Array.isArray(history.items)) history.items = {};   // ignore old snapshot-major format
if (!history.vol) history.vol = { at: 0, items: {} };
if (!history.vol.items) history.vol.items = {};
if (history.currencyCode !== STEAM_CURRENCY) {
  console.log(`[prices] resetting history from currency ${history.currencyCode ?? 'unknown'} to CNY`);
  history = { currencyCode: STEAM_CURRENCY, items: {}, vol: { at: 0, items: {} } };
}
history.currencyCode = STEAM_CURRENCY;

const cutoff = now - HISTORY_DAYS * DAY;
for (const [name, v] of Object.entries(items)) {
  let series = Array.isArray(history.items[name]) ? history.items[name] : null;
  if (!series) series = [];
  const cachedPrice = history.vol.items[name]?.lowestCents;
  if (typeof cachedPrice === 'number') v.lowestCents = cachedPrice;
  history.items[name] = series.filter(p => p[0] >= cutoff);                             // prune window
}

// prevCents (~24h ago) + the last-7-day series shipped to the plugin (timestamps in seconds to stay small)
let stamped = 0;
for (const [name, v] of Object.entries(items)) {
  const series = history.items[name] || [];
  let ref = null, rd = Infinity;
  for (const p of series) { const d = Math.abs(p[0] - (now - DAY)); if (d < rd) { rd = d; ref = p; } }
  if (ref && rd <= 18 * 3600 * 1000) { v.prevCents = ref[1]; v.prevAt = ref[0]; stamped++; }
  const win = series.filter(p => p[0] >= now - HIST_WINDOW_MS);
  if (win.length) v.hist = win.map(p => [Math.floor(p[0] / 1000), p[1], p[2] || 0]);
}

// ---- CNY prices + 24h volume/median (priceoverview, per-item). Search/render does not honor the
// currency parameter for sell_price_text, so never treat that field as CNY. Refresh the stalest items
// first within a fixed request budget; cached CNY values persist in history.vol and rotate over time. ----
const VOL_BUDGET_MS = Number(process.env.VOL_BUDGET_MS || 5 * 60 * 1000);   // per-run time box for CNY priceoverview refresh
let vol = (history.vol && history.vol.items) ? history.vol : { at: 0, items: {} };
const refreshedNames = new Set();

async function priceoverview(name, tries) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetch(priceUrl(name), { headers: { 'User-Agent': UA, ...PROXY_H }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.status === 429) { await sleep(VIA_PROXY ? 800 * (attempt + 1) : 15000); continue; }   // escalating backoff
      if (r.ok) return await r.json();   // valid response — success may be true OR false (no market data)
    } catch { /* retry */ }
    await sleep(VIA_PROXY ? 600 * (attempt + 1) : 4000);
  }
  return null;   // never reached Steam → leave the persisted value, retry next run
}
function applyVol(name, pj) {
  if (!pj) return false;                                   // unreachable → keep stale, don't stamp `at`
  if (pj.success) {
    const vRaw = (pj.volume || '').replace(/[^0-9]/g, '');
    const mRaw = (pj.median_price || '').replace(/[^0-9.]/g, '');
    const pRaw = (pj.lowest_price || '').replace(/[^0-9.,]/g, '').replace(/,/g, '');
    vol.items[name] = {
      lowestCents: pRaw ? Math.round(parseFloat(pRaw) * 100) : null,
      vol: vRaw ? parseInt(vRaw, 10) : 0,
      medianCents: mRaw ? Math.round(parseFloat(mRaw) * 100) : 0,
      at: now,
    };
    if (pRaw) refreshedNames.add(name);
  } else {
    // valid "no market data" answer → record 0 with a timestamp so we stop re-hitting it every run
    const prev = vol.items[name] || {};
    vol.items[name] = { lowestCents: null, vol: 0, medianCents: prev.medianCents || 0, at: now };
  }
  return true;
}

const volNames = Object.keys(items);
function priceBatch(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) { hash ^= name.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % PRICE_BATCH_COUNT;
}
if (VIA_PROXY && !process.env.SKIP_VOL) {
  // Each half-hour run handles one stable 1/20 cohort; the cursor is persisted in history.json.
  const batch = ((Number(history.priceBatchCursor) || 0) % PRICE_BATCH_COUNT + PRICE_BATCH_COUNT) % PRICE_BATCH_COUNT;
  const cohort = volNames.filter(name => priceBatch(name) === batch);
  // Within this cohort, try never-refreshed and stalest items first.
  const order = cohort.sort((a, b) => {
    const ta = (vol.items[a] && vol.items[a].at) || 0, tb = (vol.items[b] && vol.items[b].at) || 0;
    return ta !== tb ? ta - tb : (items[b].qty || 0) - (items[a].qty || 0);
  });
  const deadline = Date.now() + VOL_BUDGET_MS;   // budget from here, so a slow sweep doesn't starve volume
  let done = 0, idx = 0;
  const worker = async () => { while (idx < order.length && Date.now() < deadline) { const n = order[idx++]; if (applyVol(n, await priceoverview(n, 3))) done++; } };
  await Promise.all(Array.from({ length: 2 }, worker));
  if (done > 0) history.priceBatchCursor = (batch + 1) % PRICE_BATCH_COUNT;
  vol.at = now;
  console.log(`refreshed ${done}/${order.length} items in price batch ${batch + 1}/${PRICE_BATCH_COUNT} (next batch ${history.priceBatchCursor + 1}, ${Math.round(VOL_BUDGET_MS / 1000)}s budget, via proxy)`);
} else if (!process.env.SKIP_VOL) {
  const order = volNames.slice().sort((a, b) => {
    const ta = (vol.items[a] && vol.items[a].at) || 0, tb = (vol.items[b] && vol.items[b].at) || 0;
    return ta !== tb ? ta - tb : (items[b].qty || 0) - (items[a].qty || 0);
  });
  const deadline = Date.now() + VOL_BUDGET_MS;
  let done = 0;
  for (const name of order) {
    if (Date.now() >= deadline) break;
    if (applyVol(name, await priceoverview(name, 3))) done++;
    await sleep(3500);   // ~17 requests/minute on the user's local egress
  }
  vol.at = now;
  console.log(`refreshed CNY price/volume/median for ${done}/${order.length} items (direct, ${Math.round(VOL_BUDGET_MS / 1000)}s budget)`);
}
history.vol = vol;
for (const [name, v] of Object.entries(items)) {
  const vr = vol.items[name];
  if (vr && typeof vr.lowestCents === 'number') v.lowestCents = vr.lowestCents;
  else delete v.lowestCents; // never label search/render's wallet-currency amount as CNY
  if (vr) { v.vol = vr.vol; v.medianCents = vr.medianCents; }
}

// Replace this run's provisional history points with the CNY priceoverview results.
for (const [name, v] of Object.entries(items)) {
  if (typeof v.lowestCents !== 'number') continue;
  if (!refreshedNames.has(name)) continue;
  const series = history.items[name] || [];
  const last = series[series.length - 1];
  if (last && last[0] === now) { last[1] = v.lowestCents; last[2] = v.vol || 0; }
  else if (!last || now - last[0] >= SAMPLE_GAP_MS) series.push([now, v.lowestCents, v.vol || 0]);
  history.items[name] = series.filter(p => p[0] >= cutoff);
}

const out = { cachedAt: now, catalogAt: catalogAt || now, appid: APPID, currency: CURRENCY_SYMBOL, currencyCode: STEAM_CURRENCY, count: Object.keys(items).length, items };
const pricedCount = Object.values(items).filter(v => typeof v.lowestCents === 'number').length;
console.log(`[prices] ${pricedCount}/${out.count} items have a verified CNY priceoverview value`);
if (pricedCount < 5) { console.error('[prices] ABORT: too few verified CNY prices; refusing to publish a mislabeled feed.'); process.exit(1); }
await writeFile('prices.json', JSON.stringify(out));
await writeFile('history.json', JSON.stringify(history));
console.log(`wrote prices.json: ${out.count} items in CNY; prevCents on ${stamped}, hist series for ${Object.keys(history.items).length} items`);
