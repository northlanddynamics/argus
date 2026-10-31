// Renders every wireframe in ../src to ../png at 1280 px wide.
// Usage: node docs/wireframes/render/render.mjs
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const out = join(here, '..', 'png');
const shim = join(here, 'support.js');
const work = mkdtempSync(join(tmpdir(), 'wf-'));
const { chromium } = createRequire(import.meta.url)('playwright');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const f of readdirSync(src).filter((f) => f.endsWith('.dc.html'))) {
  const html = readFileSync(join(src, f), 'utf8')
    .replace('<script src="./support.js"></script>', `<script src="file://${shim}"></script>`)
    .replace(/<sc-(for|if)\b/g, '<template data-sc="$1"')
    .replace(/<\/sc-(for|if)>/g, '</template>');
  const tmp = join(work, f.replace('.dc.html', '.html'));
  writeFileSync(tmp, html);
  await page.goto('file://' + tmp);
  await page.waitForSelector('html[data-rendered]');
  await page.evaluate(() => document.fonts.ready);
  const png = join(out, f.replace('.dc.html', '.png'));
  await page.screenshot({ path: png, fullPage: true });
  console.log('rendered', png);
}
await browser.close();
