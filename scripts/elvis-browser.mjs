import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.ELVIS_OUT || '/out';
const doOrder = process.argv.includes('--order');
const email = process.env.ELVIS_EMAIL || '';
const industry = process.env.ELVIS_INDUSTRY || 'Other';
const west = 150.95, south = -33.62, east = 151.65, north = -33.10;
fs.mkdirSync(out, { recursive: true });

const network = [];
const consoleLog = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();

page.on('console', m => consoleLog.push(`[${m.type()}] ${m.text()}`));
page.on('request', r => network.push({ type: 'request', method: r.method(), url: r.url(), resourceType: r.resourceType() }));
page.on('response', r => network.push({ type: 'response', status: r.status(), url: r.url(), contentType: r.headers()['content-type'] || '' }));
page.on('requestfailed', r => network.push({ type: 'failed', url: r.url(), error: r.failure()?.errorText || '' }));

await page.goto('https://elevation.fsdf.org.au/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(12000);

async function snapshot(label) {
  const buttons = await page.locator('button').evaluateAll(els => els.map((e, i) => ({
    i, text: (e.innerText || '').trim(), aria: e.getAttribute('aria-label'), title: e.getAttribute('title'), disabled: e.disabled
  })));
  const inputs = await page.locator('input,select,textarea').evaluateAll(els => els.map((e, i) => ({
    i, tag: e.tagName, type: e.getAttribute('type'), name: e.getAttribute('name'), id: e.id,
    placeholder: e.getAttribute('placeholder'), aria: e.getAttribute('aria-label'), accept: e.getAttribute('accept'),
    value: e.value
  })));
  const links = await page.locator('a').evaluateAll(els => els.map((e, i) => ({ i, text: (e.innerText || '').trim(), href: e.href })).filter(x => x.text || x.href));
  const text = (await page.locator('body').innerText()).slice(0, 100000);
  fs.writeFileSync(path.join(out, `${label}-ui.json`), JSON.stringify({ url: page.url(), title: await page.title(), buttons, inputs, links }, null, 2));
  fs.writeFileSync(path.join(out, `${label}-text.txt`), text);
  await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
}

await snapshot('initial');

// Try to reveal the ordering panel using resilient text/ARIA matching.
const orderCandidates = [
  page.getByRole('button', { name: /order data/i }),
  page.getByText(/order data/i, { exact: true }),
  page.getByRole('button', { name: /order/i })
];
for (const loc of orderCandidates) {
  try {
    if (await loc.first().isVisible({ timeout: 1500 })) {
      await loc.first().click();
      await page.waitForTimeout(3000);
      break;
    }
  } catch {}
}
await snapshot('order-panel');

// Create the Central Coast AOI KML so the full-order mode can upload it if ELVIS exposes a file input.
const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Central Coast LiDAR AOI</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${west},${south},0 ${east},${south},0 ${east},${north},0 ${west},${north},0 ${west},${south},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
const kmlPath = path.join(out, 'central-coast-aoi.kml');
fs.writeFileSync(kmlPath, kml);

if (doOrder) {
  if (!email) throw new Error('ELVIS_EMAIL is required for --order mode');

  // Prefer ELVIS' Load File path because it avoids brittle map mouse coordinates.
  const loadFile = page.getByText(/load file/i, { exact: false }).first();
  if (await loadFile.isVisible({ timeout: 3000 }).catch(() => false)) {
    await loadFile.click();
    await page.waitForTimeout(1500);
  }
  const fileInput = page.locator('input[type=file]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(kmlPath);
    await page.waitForTimeout(5000);
  }

  // Search/continue after AOI selection where possible.
  for (const rx of [/search/i, /find data/i, /continue/i, /next/i]) {
    const b = page.getByRole('button', { name: rx }).first();
    if (await b.isVisible({ timeout: 1000 }).catch(() => false)) {
      await b.click();
      await page.waitForTimeout(4000);
      break;
    }
  }

  await snapshot('after-aoi');

  // Select rows/cards containing the required product names. We intentionally use text context
  // rather than numeric DOM indexes because ELVIS changes its UI periodically.
  const wanted = [/1\s*m(?:etre|eter)?\s*(?:dem|digital elevation)/i, /point cloud/i, /lidar/i, /classified/i];
  for (const rx of wanted) {
    const textLoc = page.getByText(rx).first();
    if (!(await textLoc.isVisible({ timeout: 1500 }).catch(() => false))) continue;
    const container = textLoc.locator('xpath=ancestor-or-self::*[self::tr or self::div or self::li][1]');
    const cb = container.locator('input[type=checkbox]').first();
    if (await cb.count()) {
      if (!(await cb.isChecked().catch(() => false))) await cb.check({ force: true }).catch(() => {});
    } else {
      const add = container.getByRole('button', { name: /add|select|order/i }).first();
      if (await add.isVisible({ timeout: 500 }).catch(() => false)) await add.click().catch(() => {});
    }
  }

  // Fill contact details without ever printing the email value.
  const emailInput = page.locator('input[type=email], input[name*=email i], input[id*=email i]').first();
  if (await emailInput.count()) await emailInput.fill(email);
  const industrySelect = page.locator('select[name*=industry i], select[id*=industry i]').first();
  if (await industrySelect.count()) {
    await industrySelect.selectOption({ label: industry }).catch(async () => {
      const opts = await industrySelect.locator('option').allTextContents();
      const fallback = opts.find(x => /other|information|technology|research/i.test(x));
      if (fallback) await industrySelect.selectOption({ label: fallback });
    });
  }

  await snapshot('before-submit');

  const submit = page.getByRole('button', { name: /order datasets|submit order|place order|order/i }).last();
  if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await submit.click();
    await page.waitForTimeout(10000);
  }
  await snapshot('after-submit');
}

fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(network, null, 2));
fs.writeFileSync(path.join(out, 'console.txt'), consoleLog.join('\n'));

// Produce a compact endpoint summary for Actions logs without leaking form values.
const interesting = [...new Set(network.map(x => x.url).filter(Boolean).filter(u => /api|order|dataset|elev|lidar|point|search|download|customerdigitalservices/i.test(u)))];
console.log(`ELVIS browser inspection complete. URL=${page.url()} endpoints=${interesting.length}`);
for (const u of interesting.slice(0, 80)) console.log(u);

await browser.close();
