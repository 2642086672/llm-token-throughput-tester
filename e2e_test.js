// 前端端到端验收：真实填表 → 点压测 → 等结果 → 断言 DOM → 截图
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://127.0.0.1:8770';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-22-17-53-10/throughput-tester';

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    args: [
      '--no-sandbox', '--disable-gpu',
      '--proxy-server=127.0.0.1:1',   // 默认走死代理，屏蔽系统代理
      '--proxy-bypass-list=127.0.0.1;localhost',  // 回环地址直连
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    bypassCSP: true,
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  console.log('1) 打开页面');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const conn = await page.textContent('#connText');
  console.log('   后端状态:', conn);

  console.log('2) 填写配置（指向 mock 上游）');
  await page.fill('#baseUrl', 'http://127.0.0.1:18899');
  await page.fill('#apiKey', 'test-key');
  await page.fill('#path', '/v1/chat/completions');
  await page.fill('#model', 'mock-fast');
  await page.fill('#requests', '8');
  await page.fill('#concurrency', '4');
  await page.fill('#warmup', '1');
  await page.fill('#maxTokens', '128');

  console.log('3) 点「开始压测」');
  await page.click('#runBtn');

  // 等 statusLine 出现"完成"
  await page.waitForFunction(
    () => /完成|错误|异常/.test(document.getElementById('statusLine').textContent),
    { timeout: 60000 }
  );
  await page.waitForTimeout(1200);

  const status = await page.textContent('#statusLine');
  console.log('   状态行:', status.trim());

  console.log('4) 断言 KPI');
  const kpi = await page.evaluate(() => {
    const g = (id) => {
      const el = document.getElementById(id);
      return el ? el.textContent.trim() : 'MISSING';
    };
    return {
      tps: g('kpiTps'), dec: g('kpiDec'), ttft: g('kpiTtft'),
      tpot: g('kpiTpot'), tokens: g('kpiTokens'), ok: g('kpiOk'),
    };
  });
  console.log('   KPI:', JSON.stringify(kpi, null, 0));

  console.log('5) 断言表格与图表');
  const dom = await page.evaluate(() => {
    const rows = document.querySelectorAll('#resultBody tr');
    const canvases = [...document.querySelectorAll('canvas')];
    return {
      tableRows: rows.length,
      firstRowText: rows[0] ? rows[0].innerText.replace(/\s+/g, ' ').trim() : '',
      tableCount: document.getElementById('tableCount').textContent,
      canvases: canvases.map((c) => {
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
        return { id: c.id, w: c.width, h: c.height, paintedPx: painted };
      }),
      logLines: document.querySelectorAll('#logBox div').length,
    };
  });
  console.log('   表格行数:', dom.tableRows, '| 计数:', dom.tableCount);
  console.log('   首行:', dom.firstRowText);
  console.log('   日志行数:', dom.logLines);
  console.log('   图表画布:');
  dom.canvases.forEach((c) => console.log(`     ${c.id}: ${c.w}x${c.h} 已绘制像素=${c.paintedPx}`));

  await page.screenshot({ path: OUT + '/shot-light.png', fullPage: true });

  console.log('6) 切深色主题');
  await page.click('#themeBtn');
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT + '/shot-dark.png', fullPage: true });

  console.log('7) 测「单次探测」');
  await page.click('#probeBtn');
  await page.waitForFunction(
    () => !document.getElementById('probeModal').hidden &&
          document.getElementById('probeText').textContent.length > 10,
    { timeout: 20000 }
  );
  await page.waitForTimeout(600);
  const probe = await page.evaluate(() => ({
    stats: document.getElementById('probeStats').innerText.replace(/\n+/g, ' | '),
    textLen: document.getElementById('probeText').textContent.length,
  }));
  console.log('   探测统计:', probe.stats);
  console.log('   返回文本长度:', probe.textLen);
  await page.screenshot({ path: OUT + '/shot-probe.png' });
  await page.click('#probeClose');

  console.log('8) 测响应式（375×812 手机视口）');
  const mob = await ctx.newPage();
  await mob.setViewportSize({ width: 375, height: 812 });
  await mob.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mob.waitForTimeout(1200);
  const overflow = await mob.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  console.log(`   页面宽 ${overflow.scrollW} / 视口宽 ${overflow.clientW} → ` +
              (overflow.scrollW <= overflow.clientW + 2 ? '无横向溢出 OK' : '横向溢出 FAIL'));
  await mob.screenshot({ path: OUT + '/shot-mobile.png', fullPage: true });

  console.log('\n=== 控制台错误 ===');
  console.log(errors.length ? errors.join('\n') : '无');

  await browser.close();

  const tps = parseFloat(kpi.tps);
  const okRate = parseFloat(kpi.ok);
  const pass = dom.tableRows === 8 &&
               dom.canvases.every((c) => c.paintedPx > 500) &&
               tps > 100 && okRate === 100 &&
               overflow.scrollW <= overflow.clientW + 2 &&
               errors.length === 0;
  console.log('\n最终判定:', pass ? 'PASS ✅' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
