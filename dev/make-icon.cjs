// 把 icon.svg 渲染成 180x180 PNG，供插件市场做卡片图标。
const fs = require('node:fs');
const path = require('node:path');

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '';

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'icon.svg');
const outPath = path.join(root, 'docs', 'icon-180.png');

const svg = fs.readFileSync(svgPath, 'utf8');
// 原 SVG 声明 width/height=128，直接嵌入会按 128 渲染。
// 覆写成 180 再嵌入，保证输出正好 180×180。
const svg180 = svg
  .replace(/width="128"/, 'width="180"')
  .replace(/height="128"/, 'height="180"');
const html =
  '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>' +
  svg180 +
  '</body></html>';

const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const el = await page.$('svg');
  if (!el) {
    console.error('页面里找不到 svg');
    process.exit(1);
  }
  const box = await el.boundingBox();
  console.log('SVG 渲染尺寸:', box.width + 'x' + box.height);
  await el.screenshot({ path: outPath, omitBackground: true });
  await browser.close();
  const bytes = fs.statSync(outPath).size;
  console.log('已生成:', outPath, Math.round(bytes / 1024), 'KB');
})();
