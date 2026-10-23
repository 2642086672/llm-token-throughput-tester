// 历史记录 + 图表交互的端到端验收
// 运行：NODE_PATH=<playwright-core 所在目录> node e2e_history.js
// 前置：后端在 8770，mock 上游在 18899（普通）或 18903（思考模式）
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:8770';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-22-17-53-10/throughput-tester';

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    args: ['--no-sandbox', '--disable-gpu',
      '--proxy-server=127.0.0.1:1', '--proxy-bypass-list=127.0.0.1;localhost'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => localStorage.removeItem('tt-history-v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // --- 跑第 1 次 ---
  await page.fill('#baseUrl', 'http://127.0.0.1:18899');
  await page.dispatchEvent('#baseUrl', 'change');
  await page.fill('#path', '/v1/chat/completions');
  await page.dispatchEvent('#path', 'change');
  await page.fill('#model', 'mock-first');
  await page.fill('#requests', '4');
  await page.fill('#concurrency', '2');
  await page.click('#runBtn');
  await page.waitForFunction(() => /完成/.test(document.getElementById('statusLine').textContent), { timeout: 60000 });
  await page.waitForTimeout(1200);
  const h1 = await page.evaluate(() => ({
    items: document.querySelectorAll('.h-item').length,
  }));
  console.log('第 1 次压测后历史条数:', h1.items);

  // --- 跑第 2 次（不同并发/模型） ---
  await page.fill('#model', 'mock-second');
  await page.fill('#requests', '6');
  await page.fill('#concurrency', '3');
  await page.click('#runBtn');
  await page.waitForFunction(() => /完成/.test(document.getElementById('statusLine').textContent), { timeout: 60000 });
  await page.waitForTimeout(1200);
  const h2 = await page.evaluate(() => ({
    items: document.querySelectorAll('.h-item').length,
    models: [...document.querySelectorAll('.h-item .h-title')].map((e) => e.textContent.trim().split(' ')[0]),
  }));
  console.log('第 2 次压测后历史条数:', h2.items, '| 顺序:', JSON.stringify(h2.models));

  // --- 点历史回看 ---
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.h-item')].find((i) => i.innerText.includes('mock-first'));
    t.click();
  });
  await page.waitForTimeout(1500);
  const viewed = await page.evaluate(() => ({
    active: document.querySelector('.h-item.active')
      ? document.querySelector('.h-item.active').innerText.replace(/\s+/g, ' ').trim() : '',
    rows: document.querySelectorAll('#resultBody tr').length,
  }));
  console.log('回看高亮:', viewed.active);
  console.log('回看后明细行数:', viewed.rows, '(应为第 1 次的 4 行)');

  // --- 图表 tooltip ---
  const tips = {};
  for (const [name, id, fx, fy] of [
    ['TTFT', 'chartTtft', 0.3, 0.7],
    ['吞吐曲线', 'chartTps', 0.5, 0.5],
    ['ITL', 'chartItl', 0.4, 0.5],
    ['分位', 'chartPct', 0.15, 0.6],
  ]) {
    const box = await page.locator('#' + id).boundingBox();
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(400);
    tips[name] = await page.evaluate(() => {
      const t = document.querySelector('.chart-tip');
      return t && t.style.display !== 'none' ? t.innerText.replace(/\n/g, ' | ') : null;
    });
    console.log(`  ${name} tooltip:`, tips[name] || '(未显示)');
  }

  // --- 点击 TTFT 柱联动明细表 ---
  const box = await page.locator('#chartTtft').boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.8);
  await page.waitForTimeout(700);
  const clicked = await page.evaluate(() => document.getElementById('statusLine').textContent);
  console.log('点击 TTFT 柱后:', clicked);

  await page.screenshot({ path: OUT + '/shot-history.png', fullPage: true });

  // --- 刷新持久化 ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => document.querySelectorAll('.h-item').length);
  console.log('刷新后历史条数:', after);

  // --- 删除一条 ---
  await page.click('.h-item .h-del');
  await page.waitForTimeout(600);
  const afterDel = await page.evaluate(() => document.querySelectorAll('.h-item').length);
  console.log('删除一条后:', afterDel);

  console.log('\n控制台错误:', errs.length ? errs.join(';') : '无');
  const pass = h1.items === 1 && h2.items === 2 && h2.models[0] === 'mock-second' &&
    viewed.active.includes('mock-first') && viewed.rows === 4 &&
    Object.values(tips).every(Boolean) &&
    clicked.includes('已选中请求') &&
    after === 2 && afterDel === 1 && errs.length === 0;
  console.log('判定:', pass ? 'PASS ✅' : 'FAIL ❌');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
