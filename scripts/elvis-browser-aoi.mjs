import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.ELVIS_OUT || '/out';
const doOrder = process.argv.includes('--order');
const email = process.env.ELVIS_EMAIL || '';
const industry = process.env.ELVIS_INDUSTRY || 'Other';
const west = Number(process.env.ELVIS_WEST || 140.8);
const south = Number(process.env.ELVIS_SOUTH || -37.7);
const east = Number(process.env.ELVIS_EAST || 159.4);
const north = Number(process.env.ELVIS_NORTH || -28.0);
const aoiName = process.env.ELVIS_AOI_NAME || 'NSW research AOI';
const includePointCloud = /^(1|true|yes)$/i.test(process.env.ELVIS_INCLUDE_POINT_CLOUD || 'false');

if (![west,south,east,north].every(Number.isFinite) || west >= east || south >= north) {
  throw new Error(`Invalid AOI bounds: ${west},${south},${east},${north}`);
}
fs.mkdirSync(out, { recursive: true });

const network = [];
const consoleLog = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('console', m => consoleLog.push(`[${m.type()}] ${m.text()}`));
page.on('request', r => network.push({ type:'request', method:r.method(), url:r.url(), resourceType:r.resourceType() }));
page.on('response', r => network.push({ type:'response', status:r.status(), url:r.url(), contentType:r.headers()['content-type'] || '' }));
page.on('requestfailed', r => network.push({ type:'failed', url:r.url(), error:r.failure()?.errorText || '' }));

async function snapshot(label) {
  const buttons = await page.locator('button').evaluateAll(els => els.map((e,i)=>({i,text:(e.innerText||'').trim(),aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),disabled:e.disabled})));
  const inputs = await page.locator('input,select,textarea').evaluateAll(els => els.map((e,i)=>({i,tag:e.tagName,type:e.getAttribute('type'),name:e.getAttribute('name'),id:e.id,placeholder:e.getAttribute('placeholder'),aria:e.getAttribute('aria-label')})));
  fs.writeFileSync(path.join(out, `${label}-ui.json`), JSON.stringify({url:page.url(),title:await page.title(),buttons,inputs}, null, 2));
  await page.screenshot({ path:path.join(out,`${label}.png`), fullPage:true });
}

await page.goto('https://elevation.fsdf.org.au/', { waitUntil:'domcontentloaded', timeout:90000 });
await page.waitForTimeout(10000);
await snapshot('initial');

for (const loc of [page.getByRole('button',{name:/order data/i}),page.getByText(/order data/i,{exact:true}),page.getByRole('button',{name:/order/i})]) {
  try { if (await loc.first().isVisible({timeout:1200})) { await loc.first().click(); await page.waitForTimeout(2500); break; } } catch {}
}
await snapshot('order-panel');

const safeName = aoiName.replace(/[<>&]/g,' ');
const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>${safeName}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${west},${south},0 ${east},${south},0 ${east},${north},0 ${west},${north},0 ${west},${south},0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
const kmlPath = path.join(out, 'elvis-aoi.kml');
fs.writeFileSync(kmlPath, kml);
fs.writeFileSync(path.join(out,'request.json'), JSON.stringify({aoiName,west,south,east,north,includePointCloud}, null, 2));

if (doOrder) {
  if (!email) throw new Error('ELVIS_EMAIL is required for --order mode');
  const loadFile = page.getByText(/load file/i,{exact:false}).first();
  if (await loadFile.isVisible({timeout:2500}).catch(()=>false)) { await loadFile.click(); await page.waitForTimeout(1200); }
  const fileInput = page.locator('input[type=file]').first();
  if (!(await fileInput.count())) throw new Error('ELVIS file-upload control was not found');
  await fileInput.setInputFiles(kmlPath);
  await page.waitForTimeout(4500);

  for (const rx of [/search/i,/find data/i,/continue/i,/next/i]) {
    const b=page.getByRole('button',{name:rx}).first();
    if(await b.isVisible({timeout:900}).catch(()=>false)){await b.click();await page.waitForTimeout(3500);break;}
  }
  await snapshot('after-aoi');

  const wanted = [/1\s*m(?:etre|eter)?\s*(?:dem|digital elevation)/i];
  if (includePointCloud) wanted.push(/point cloud/i,/lidar/i,/classified/i);
  for (const rx of wanted) {
    const textLoc=page.getByText(rx).first();
    if(!(await textLoc.isVisible({timeout:1400}).catch(()=>false)))continue;
    const container=textLoc.locator('xpath=ancestor-or-self::*[self::tr or self::div or self::li][1]');
    const cb=container.locator('input[type=checkbox]').first();
    if(await cb.count()){if(!(await cb.isChecked().catch(()=>false)))await cb.check({force:true}).catch(()=>{});}
    else {const add=container.getByRole('button',{name:/add|select|order/i}).first();if(await add.isVisible({timeout:500}).catch(()=>false))await add.click().catch(()=>{});}
  }

  const emailInput=page.locator('input[type=email],input[name*=email i],input[id*=email i]').first();
  if(await emailInput.count())await emailInput.fill(email);
  const industrySelect=page.locator('select[name*=industry i],select[id*=industry i]').first();
  if(await industrySelect.count())await industrySelect.selectOption({label:industry}).catch(async()=>{const opts=await industrySelect.locator('option').allTextContents();const fallback=opts.find(x=>/other|information|technology|research/i.test(x));if(fallback)await industrySelect.selectOption({label:fallback});});
  await snapshot('before-submit');

  const submit=page.getByRole('button',{name:/order datasets|submit order|place order|order/i}).last();
  if(!(await submit.isVisible({timeout:2500}).catch(()=>false)))throw new Error('ELVIS submit-order control was not found');
  await submit.click();
  await page.waitForTimeout(9000);
  await snapshot('after-submit');
}

fs.writeFileSync(path.join(out,'network.json'),JSON.stringify(network,null,2));
fs.writeFileSync(path.join(out,'console.txt'),consoleLog.join('\n'));
const interesting=[...new Set(network.map(x=>x.url).filter(Boolean).filter(u=>/api|order|dataset|elev|lidar|point|search|download/i.test(u)))];
console.log(`ELVIS AOI inspection complete. AOI=${west},${south},${east},${north}; pointCloud=${includePointCloud}; endpoints=${interesting.length}`);
for(const u of interesting.slice(0,60))console.log(u);
await browser.close();
