// 渲染 preview-snapshot.html 成 PNG。
// 障碍：.pv-frame 的高度被 CSS 固定为 min(calc(100vh - 130px), 900px)，
// 内容在其内部的滚动容器里，fullPage 截不全。
// 解法：覆盖这几层的固定高度，展开滚动，再整页截图。
process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:\\Users\\13264\\AppData\\Local\\ms-playwright';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const shot = path.join(root, 'dev', 'preview-snapshot.html');
const outDir = path.join(root, 'docs');
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = require('E:\\AI-Tools\\gstack\\node_modules\\playwright-core');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(shot).href, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  await page.addStyleTag({
    content: `
      .snap { padding: 16px !important; }
      .pv-frame { height: auto !important; max-height: none !important; min-height: 0 !important; }
      .mm-view { height: auto !important; min-height: 0 !important; }
      /* 展开所有内部滚动区 */
      .mm-body, .mm-scroll, .mm-list, [class*="scroll"] {
        height: auto !important; max-height: none !important; overflow: visible !important;
      }
      * { overflow-y: visible !important; }
      body, html { height: auto !important; overflow: visible !important; }
    `,
  });
  await page.waitForTimeout(600);

  const h = await page.evaluate(() => Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
    document.querySelector('.pv-frame')?.scrollHeight ?? 0,
  ));
  console.log('展开后内容高度:', h);

  await page.setViewportSize({ width: 1320, height: Math.min(h + 40, 8000) });
  await page.waitForTimeout(400);

  const out = path.join(outDir, 'screenshot.png');
  await page.screenshot({ path: out, fullPage: true });
  console.log('已写入:', out, Math.round(fs.statSync(out).size / 1024), 'KB');

  await browser.close();
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
