/* ===== 模型吞吐压测台 · 前端逻辑 ===== */
'use strict';

const $ = (id) => document.getElementById(id);
const API = '';   // 同源后端

/* ---------------- 配置读写 ---------------- */
const FIELDS = [
  'base_url', 'api_key', 'api_format', 'path', 'model', 'prompt',
  'max_tokens', 'temperature', 'timeout', 'extra_body',
  'include_usage', 'verify_tls', 'keepalive',
  'thinking_provider', 'thinking_enabled', 'thinking_level', 'thinking_budget',
  'requests', 'concurrency', 'warmup', 'bucket_ms',
];

const DEFAULTS = {
  base_url: 'https://api.openai.com',
  api_key: '',
  api_format: 'openai',
  path: '/v1/chat/completions',
  model: 'gpt-4o-mini',
  prompt: '用大约 300 个字详细介绍一下量子计算的历史、原理和当前的应用前景。',
  max_tokens: 512,
  temperature: 0.7,
  timeout: 120,
  extra_body: '',
  include_usage: true,
  verify_tls: true,
  keepalive: false,
  requests: 20,
  concurrency: 4,
  warmup: 1,
  bucket_ms: 100,
};

const CHECKS = { include_usage: 'includeUsage', verify_tls: 'verifyTls', keepalive: 'keepalive' };

// 后端字段名 → DOM id 映射。必须显式声明，不能靠名字猜。
const FIELD_IDS = {
  base_url: 'baseUrl',
  api_key: 'apiKey',
  api_format: 'apiFormat',
  path: 'path',
  model: 'model',
  prompt: 'prompt',
  max_tokens: 'maxTokens',
  temperature: 'temperature',
  timeout: 'timeout',
  extra_body: 'extraBody',
  requests: 'requests',
  concurrency: 'concurrency',
  warmup: 'warmup',
  bucket_ms: 'bucketMs',
  thinking_provider: 'thinkingProvider',
  thinking_enabled: 'thinkingEnabled',
  thinking_level: 'thinkingLevel',
  thinking_budget: 'thinkingBudget',
};
/* ------------------------------------------------------------------
 * 思考模式
 * 各家思考参数写法完全不同，这里维护档位表，由后端 thinking.py 翻译成 wire 格式
 * ------------------------------------------------------------------ */
const THINKING_LEVELS = {
  openai:    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  deepseek:  ['low', 'high', 'max'],
  glm:       ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  qwen:      ['low', 'medium', 'xhigh'],
  gemini:    ['minimal', 'low', 'medium', 'high'],
  mimo:      [],
  longcat:   [],
};

// 各家思考参数风格，键与 PROVIDERS 里的服务商对应
const THINKING_STYLE = {
  '小米': 'mimo',
  'DeepSeek': 'deepseek',
  'LongCat（美团）': 'longcat',
  'GLM（智谱）': 'glm',
  'Qwen（阿里通义）': 'qwen',
  'Claude（Anthropic）': 'anthropic',
  'Gemini（Google）': 'gemini',
  'OpenAI': 'openai',
  'Kimi（月之暗面）': 'qwen',
  '豆包（火山引擎）': 'qwen',
  '硅基流动 SiliconFlow': 'openai',
  '百度千帆': 'openai',
  '腾讯混元': 'openai',
  '海外聚合': 'openai',
  '本地部署': 'openai',
};

const LEVEL_LABEL = {
  none: 'none（关闭思考）',
  minimal: 'minimal（最低）',
  low: 'low（低）',
  medium: 'medium（中）',
  high: 'high（高）',
  xhigh: 'xhigh（超高）',
  max: 'max（最深）',
};

/** 按当前风格刷新思考级别的可选项 */
function refreshThinkingLevels() {
  const style = $('thinkingProvider').value;
  const sel = $('thinkingLevel');
  const prev = sel.value;
  sel.innerHTML = '';
  const levels = THINKING_LEVELS[style] || [];
  if (!levels.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = style ? '该服务商无强度档位（仅开关）' : '—';
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '模型默认';
    sel.appendChild(blank);
    for (const lv of levels) {
      const o = document.createElement('option');
      o.value = lv;
      o.textContent = LEVEL_LABEL[lv] || lv;
      sel.appendChild(o);
    }
    sel.disabled = false;
    if (prev && levels.includes(prev)) sel.value = prev;
  }
  // 只有 Qwen 与 LongCat 支持 token 预算
  $('thinkingBudgetField').hidden = !(style === 'qwen' || style === 'longcat');
  updateThinkingHint();
}

function updateThinkingHint() {
  const style = $('thinkingProvider').value;
  const hint = $('thinkingHint');
  if (!hint) return;
  if (!style) {
    hint.textContent = '不启用时完全不下发思考参数，由模型自行决定。';
    return;
  }
  const levels = THINKING_LEVELS[style] || [];
  const lvl = $('thinkingLevel').value;
  const en = $('thinkingEnabled').value;
  const bits = [];
  if (en === 'true') bits.push('开关：开启');
  else if (en === 'false') bits.push('开关：关闭');
  else bits.push('开关：模型默认');
  if (levels.length) {
    bits.push('级别：' + (lvl ? (LEVEL_LABEL[lvl] || lvl) : '模型默认'));
  } else {
    bits.push('级别：不支持');
  }
  hint.textContent = bits.join(' · ');
}

/** 服务商预设切换时，自动匹配思考参数风格 */
function syncThinkingStyle(group) {
  const style = THINKING_STYLE[group] || '';
  const sel = $('thinkingProvider');
  if (style) {
    sel.value = style;
  }
  $('thinkingFields').hidden = !sel.value;
  refreshThinkingLevels();
}

const INT_FIELDS = ['max_tokens', 'timeout', 'requests', 'concurrency', 'warmup', 'bucket_ms'];

/* ------------------------------------------------------------------
 * 服务商预设表
 * base: Base URL（不含接口路径，与页面字段一一对应）
 * path: 接口路径（与 base 拼出最终请求地址）
 * fmt : openai | anthropic
 * 默认模型只作兜底，实际以「拉取模型列表」返回的为准
 * ------------------------------------------------------------------ */
const PROVIDERS = [
  {
    group: '小米',
    items: [
      { label: 'MiMo · 按量付费 · OpenAI', base: 'https://api.xiaomimimo.com/v1', path: '/chat/completions', fmt: 'openai', model: 'mimo-v2.6-pro' },
      { label: 'MiMo · 按量付费 · Anthropic', base: 'https://api.xiaomimimo.com/anthropic', path: '/v1/messages', fmt: 'anthropic', model: 'mimo-v2.6-pro' },
      { label: 'MiMo · Token Plan 订阅 · OpenAI', base: 'https://token-plan-cn.xiaomimimo.com/v1', path: '/chat/completions', fmt: 'openai', model: 'mimo-v2.6-pro' },
      { label: 'MiMo · Token Plan 订阅 · Anthropic', base: 'https://token-plan-cn.xiaomimimo.com/anthropic', path: '/v1/messages', fmt: 'anthropic', model: 'mimo-v2.6-pro' },
    ],
  },
  {
    group: 'DeepSeek',
    items: [
      { label: 'DeepSeek 官方', base: 'https://api.deepseek.com', path: '/v1/chat/completions', fmt: 'openai', model: 'deepseek-chat' },
      { label: 'DeepSeek 官方 · 短域名', base: 'https://api.deepseek.com/v1', path: '/chat/completions', fmt: 'openai', model: 'deepseek-chat' },
      { label: 'DeepSeek Reasoner 推理模型', base: 'https://api.deepseek.com', path: '/v1/chat/completions', fmt: 'openai', model: 'deepseek-reasoner' },
    ],
  },
  {
    group: 'LongCat（美团）',
    items: [
      { label: 'LongCat · OpenAI 协议', base: 'https://api.longcat.chat/openai', path: '/v1/chat/completions', fmt: 'openai', model: 'LongCat-2.0' },
      { label: 'LongCat · Anthropic 协议', base: 'https://api.longcat.chat/anthropic', path: '/v1/messages', fmt: 'anthropic', model: 'LongCat-2.0' },
    ],
  },
  {
    group: 'GLM（智谱）',
    items: [
      { label: '智谱开放平台（国内）', base: 'https://open.bigmodel.cn/api/paas/v4', path: '/chat/completions', fmt: 'openai', model: 'glm-4.7' },
      { label: '智谱免费 glm-4.7-flash', base: 'https://open.bigmodel.cn/api/paas/v4', path: '/chat/completions', fmt: 'openai', model: 'glm-4.7-flash' },
      { label: 'Z.AI 国际站', base: 'https://api.z.ai/v1', path: '/chat/completions', fmt: 'openai', model: 'GLM-4.7' },
    ],
  },
  {
    group: 'Qwen（阿里通义）',
    items: [
      { label: '百炼 · OpenAI 兼容（国内）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', path: '/chat/completions', fmt: 'openai', model: 'qwen-max' },
      { label: '百炼 · 国际站', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', path: '/chat/completions', fmt: 'openai', model: 'qwen-max' },
    ],
  },
  {
    group: 'Claude（Anthropic）',
    items: [
      { label: 'Anthropic 官方', base: 'https://api.anthropic.com', path: '/v1/messages', fmt: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    ],
  },
  {
    group: 'Gemini（Google）',
    items: [
      { label: 'Google AI Studio · OpenAI 兼容', base: 'https://generativelanguage.googleapis.com/v1beta/openai/', path: '/chat/completions', fmt: 'openai', model: 'gemini-3.8-flash' },
    ],
  },
  {
    group: 'OpenAI',
    items: [
      { label: 'OpenAI 官方', base: 'https://api.openai.com/v1', path: '/chat/completions', fmt: 'openai', model: 'gpt-4o-mini' },
    ],
  },
  {
    group: 'Kimi（月之暗面）',
    items: [
      { label: 'Moonshot 官方', base: 'https://api.moonshot.cn/v1', path: '/chat/completions', fmt: 'openai', model: 'kimi-k2.5' },
    ],
  },
  {
    group: '豆包（火山引擎）',
    items: [
      { label: '火山方舟 Ark', base: 'https://ark.cn-beijing.volces.com/api/v3', path: '/chat/completions', fmt: 'openai', model: 'doubao-seed-1-6' },
    ],
  },
  {
    group: '硅基流动 SiliconFlow',
    items: [
      { label: '硅基流动官方', base: 'https://api.siliconflow.cn/v1', path: '/chat/completions', fmt: 'openai', model: 'Qwen/Qwen2.5-7B-Instruct' },
    ],
  },
  {
    group: '百度千帆',
    items: [
      { label: '千帆 v2', base: 'https://qianfan.baidubce.com/v2', path: '/chat/completions', fmt: 'openai', model: 'ernie-4.0-turbo-8k' },
    ],
  },
  {
    group: '腾讯混元',
    items: [
      { label: '混元官方', base: 'https://hunyuan.cloud.tencent.com/v1', path: '/chat/completions', fmt: 'openai', model: 'hunyuan-turbos-latest' },
    ],
  },
  {
    group: '海外聚合',
    items: [
      { label: 'Groq', base: 'https://api.groq.com/openai/v1', path: '/chat/completions', fmt: 'openai', model: 'llama-3.3-70b-versatile' },
      { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', path: '/chat/completions', fmt: 'openai', model: 'openrouter/auto' },
      { label: 'Together AI', base: 'https://api.together.xyz/v1', path: '/chat/completions', fmt: 'openai', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
      { label: 'Mistral', base: 'https://api.mistral.ai/v1', path: '/chat/completions', fmt: 'openai', model: 'mistral-large-latest' },
    ],
  },
  {
    group: '本地部署',
    items: [
      { label: 'vLLM', base: 'http://127.0.0.1:8000/v1', path: '/chat/completions', fmt: 'openai', model: '' },
      { label: 'Ollama', base: 'http://127.0.0.1:11434/v1', path: '/chat/completions', fmt: 'openai', model: '' },
      { label: 'LM Studio', base: 'http://127.0.0.1:1234/v1', path: '/chat/completions', fmt: 'openai', model: '' },
      { label: 'Xinference', base: 'http://127.0.0.1:9997/v1', path: '/chat/completions', fmt: 'openai', model: '' },
      { label: 'llama.cpp server', base: 'http://127.0.0.1:8080/v1', path: '/chat/completions', fmt: 'openai', model: '' },
    ],
  },
];

/** 展平成 [ {idx, ...item} ]，供下拉与匹配用 */
const PROVIDER_LIST = [];
PROVIDERS.forEach((g) => {
  g.items.forEach((it) => PROVIDER_LIST.push(Object.assign({ group: g.group }, it)));
});

/** base+path 精确匹配到预设下标，用于恢复配置后同步下拉 */
function matchProvider(base, path, fmt) {
  if (!base) return -1;
  const nb = base.replace(/\/+$/, '');
  const np = (path || '').split('?')[0].replace(/\/+$/, '');
  for (let i = 0; i < PROVIDER_LIST.length; i++) {
    const it = PROVIDER_LIST[i];
    const same = it.base.replace(/\/+$/, '') === nb &&
      (it.path.split('?')[0].replace(/\/+$/, '') === np) &&
      (it.fmt === (fmt || 'openai'));
    if (same) return i;
  }
  return -1;
}

function setField(name, value) {
  if (CHECKS[name]) {
    $(CHECKS[name]).checked = !!value;
    return;
  }
  const el = $(FIELD_IDS[name]);
  if (!el) return;
  if (name === 'thinking_enabled') {
    // 后端存 null / true / false，界面存 '' / 'true' / 'false'
    el.value = value === null || value === undefined ? '' : (value ? 'true' : 'false');
    return;
  }
  el.value = value == null ? '' : value;
}

function readForm() {
  const cfg = {};
  for (const name of FIELDS) {
    if (CHECKS[name]) {
      cfg[name] = $(CHECKS[name]).checked;
      continue;
    }
    const el = $(FIELD_IDS[name]);
    if (!el) continue;
    if (name === 'thinking_enabled') {
      // 三态：'' = 模型默认（不下发），'true'/'false' = 强制
      cfg[name] = el.value === '' ? null : (el.value === 'true');
      continue;
    }
    if (INT_FIELDS.includes(name) || name === 'thinking_budget') {
      cfg[name] = parseInt(el.value, 10) || 0;
    } else if (name === 'temperature') {
      cfg[name] = el.value === '' ? null : parseFloat(el.value);
    } else {
      cfg[name] = el.value;
    }
  }
  return cfg;
}

function fillForm(cfg) {
  for (const name of FIELDS) {
    if (!(name in cfg)) continue;
    setField(name, cfg[name]);
  }
  // 协议切换时自动改默认路径
  syncPathByFormat();
  // 思考面板：先按风格刷出档位选项，再把配置里的档位选回来
  $('thinkingFields').hidden = !$('thinkingProvider').value;
  refreshThinkingLevels();
  if (cfg.thinking_level) {
    const sel = $('thinkingLevel');
    if ([...sel.options].some((o) => o.value === cfg.thinking_level)) {
      sel.value = cfg.thinking_level;
    }
  }
  updateThinkingHint();
  // 已有配置 → 尝试匹配到服务商下拉
  syncProviderSelect();
}

/* ------------------------------------------------------------------
 * 服务商下拉
 * ------------------------------------------------------------------ */
function fillProviderSelect() {
  const sel = $('provider');
  if (!sel) return;
  sel.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = '-1';
  custom.textContent = '自定义 / 手动填写';
  sel.appendChild(custom);

  let offset = 0;   // 与 PROVIDER_LIST 的下标严格对齐，「自定义」单独用 -1
  PROVIDERS.forEach((g) => {
    const og = document.createElement('optgroup');
    og.label = g.group;
    g.items.forEach((it) => {
      const o = document.createElement('option');
      o.value = String(offset);
      o.textContent = it.label;
      og.appendChild(o);
      offset++;
    });
    sel.appendChild(og);
  });
}

/** 把预设填进表单。idx 来自下拉，-1 表示自定义（不动表单） */
function applyProvider(idx) {
  if (idx < 0 || idx >= PROVIDER_LIST.length) {
    const hint = $('providerHint');
    if (hint) hint.textContent = '自定义模式：Base URL 与路径自己填';
    return;
  }
  const it = PROVIDER_LIST[idx];
  $('baseUrl').value = it.base;
  $('path').value = it.path;
  $('apiFormat').value = it.fmt;
  // 思考参数风格跟着服务商走
  syncThinkingStyle(it.group);
  // 模型处理：
  //   - 预设有默认模型 → 覆盖（当前值为空，或仍是某个预设的默认值）
  //   - 预设无默认模型（本地部署）→ 若当前值是某个预设的默认值就清空，
  //     否则保留（用户可能刚从别处粘了真实模型名）
  const mEl = $('model');
  const cur = mEl.value.trim();
  const isPresetModel = cur === '' || PROVIDER_LIST.some((p) => p.model && p.model === cur);
  if (it.model) {
    if (isPresetModel) mEl.value = it.model;
  } else if (cur !== '' && PROVIDER_LIST.some((p) => p.model && p.model === cur)) {
    mEl.value = '';
  }
  syncProviderHint();
  log(`已选择服务商预设：${it.group} · ${it.label}`);
}

/** 把表单当前值反查到下拉（配置加载后用） */
function syncProviderSelect() {
  const sel = $('provider');
  if (!sel) return;
  const idx = matchProvider($('baseUrl').value.trim(), $('path').value.trim(), $('apiFormat').value);
  sel.value = String(idx);
  syncProviderHint();
}

function syncProviderHint() {
  const hint = $('providerHint');
  if (!hint) return;
  const idx = parseInt($('provider').value, 10);
  if (idx < 0 || idx >= PROVIDER_LIST.length) {
    hint.textContent = '自定义模式：Base URL 与路径自己填';
    return;
  }
  const it = PROVIDER_LIST[idx];
  const full = it.base.replace(/\/+$/, '') + it.path;
  hint.innerHTML = `请求地址：<code>${escapeHtml(full)}</code>`;
}

/* ------------------------------------------------------------------
 * 拉取模型列表
 * ------------------------------------------------------------------ */
async function fetchModels() {
  const cfg = readForm();
  if (!cfg.base_url) {
    setStatus('请先填写 Base URL', 'err');
    return;
  }
  const btn = $('fetchModelsBtn');
  if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
  setStatus('正在从上游拉取模型列表…', 'run');
  try {
    const r = await fetch(API + '/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: cfg.base_url, api_key: cfg.api_key, api_format: cfg.api_format, path: cfg.path }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '未知错误');
    const dl = $('modelList');
    if (dl) {
      dl.innerHTML = '';
      // 上游返回可能成百上千条，只塞进 datalist 不阻塞 UI
      for (const id of j.models) {
        const o = document.createElement('option');
        o.value = id;
        dl.appendChild(o);
      }
    }
    setStatus(`拉到 ${j.models.length} 个模型（接口 ${j.path}），点模型输入框下拉选择`);
    log(`模型列表：${j.models.slice(0, 8).join(', ')}${j.models.length > 8 ? ' …' : ''}`);
    // 首个模型直接填进去，用户通常就想要它
    if (j.models.length && !$('model').value.trim()) {
      $('model').value = j.models[0];
    }
  } catch (e) {
    setStatus('拉取模型失败：' + e.message, 'err');
    log('拉取模型失败：' + e.message, '#ef4444');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '拉取模型列表'; }
  }
}

function syncPathByFormat() {
  const fmt = $('apiFormat').value;
  const p = $('path');
  const cur = p.value.trim();
  const isOpenAIPath = cur === '' || cur.includes('chat/completions');
  const isAnthropicPath = cur.includes('/messages');
  if (fmt === 'anthropic' && !isAnthropicPath) {
    p.value = '/v1/messages';
  } else if (fmt === 'openai' && !isOpenAIPath) {
    p.value = '/v1/chat/completions';
  }
}

/* ---------------- 状态 ---------------- */
let running = false;
let abortCtl = null;
let lastResult = null;

/* ---------------- 日志 ---------------- */
function log(msg, cls) {
  const box = $('logBox');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  if (cls) line.style.color = cls;
  line.textContent = `[${t}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setStatus(msg, cls) {
  const el = $('statusLine');
  el.textContent = msg;
  el.className = 'status-line' + (cls ? ' ' + cls : '');
}

/* ---------------- 健康检查 ---------------- */
async function pingHealth() {
  const pill = $('connPill');
  try {
    const r = await fetch(API + '/api/health', { cache: 'no-store' });
    const j = await r.json();
    if (j.ok) {
      pill.className = 'conn-pill ok';
      $('connText').textContent = '后端已连接';
    } else throw new Error('bad');
  } catch (e) {
    pill.className = 'conn-pill bad';
    $('connText').textContent = '后端未连接';
  }
}

/* ---------------- SSE 消费 ---------------- */
async function readSSE(url, body, onEvent) {
  abortCtl = new AbortController();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortCtl.signal,
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try { onEvent(JSON.parse(line.slice(6))); } catch (e) { /* 忽略半包 */ }
        }
      }
    }
  }
}

/* ---------------- 压测 ---------------- */
async function runBench() {
  if (running) return;
  const cfg = readForm();
  if (!cfg.base_url) { setStatus('请填写 Base URL', 'err'); return; }
  if (!cfg.model) { setStatus('请填写模型名', 'err'); return; }

  running = true;
  $('runBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('probeBtn').disabled = true;
  setStatus('压测运行中…', 'run');
  $('resultBody').innerHTML = '<tr class="empty"><td colspan="14">等待结果…</td></tr>';
  $('tableCount').textContent = '0 条';
  resetKpi();
  drawAll(null);

  const t0 = performance.now();
  const rows = [];
  try {
    await readSSE(API + '/api/bench', cfg, (ev) => {
      if (ev.type === 'phase') {
        if (ev.phase === 'warmup') {
          log(`预热 ${ev.count} 条请求（不计入统计）`);
        } else {
          log(`开始压测：${ev.count} 请求 / 并发 ${ev.concurrency}`);
        }
      } else if (ev.type === 'progress') {
        rows.push(ev.record);
        $('tableCount').textContent = rows.length + ' 条';
        const r = ev.record;
        log(`#${r.seq} ${r.ok ? 'OK' : 'FAIL'} ttft=${fmt(r.ttft_ms, 1)}ms ` +
            `tps=${fmt(r.decode_tps, 2)} tok=${r.output_tokens}` +
            (r.error ? ` err=${r.error}` : ''), r.ok ? '' : '#ef4444');
        appendRow(r);
      } else if (ev.type === 'result') {
        lastResult = ev.data;
        renderResult(ev.data);
      } else if (ev.type === 'error') {
        setStatus('错误：' + ev.error, 'err');
        log('错误：' + ev.error, '#ef4444');
      }
    });
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    if (lastResult) {
      const s = lastResult.summary;
      setStatus(`完成：${s.ok}/${s.requests} 成功，聚合吞吐 ${fmt(s.aggregate_tps, 2)} tok/s，耗时 ${dt}s`);
    } else {
      setStatus('结束（未收到结果）');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      setStatus('已手动停止');
      log('用户中止压测', '#f79009');
    } else {
      setStatus('异常：' + e.message, 'err');
      log('异常：' + e.message, '#ef4444');
    }
  } finally {
    running = false;
    abortCtl = null;
    $('runBtn').disabled = false;
    $('stopBtn').disabled = true;
    $('probeBtn').disabled = false;
  }
}

function stopBench() {
  if (abortCtl) abortCtl.abort();
}

/* ---------------- 渲染 ---------------- */
function resetKpi() {
  ['kpiTps', 'kpiDec', 'kpiTtft', 'kpiTpot', 'kpiTokens', 'kpiOk'].forEach((id) => {
    const el = $(id);
    const unit = el.querySelector('.unit');
    el.textContent = '—';
    if (unit) el.appendChild(unit);
  });
  $('kpiTpsSub').textContent = '总 token ÷ 墙钟时长';
  $('kpiDecSub').textContent = '单请求解码速率均值';
  $('kpiTtftSub').textContent = '首 token 延迟';
  $('kpiTpotSub').textContent = '每 token 生成间隔';
  $('kpiTokensSub').textContent = 'usage 精确计数';
  $('kpiOkSub').textContent = '成功 / 总请求';
}

function renderResult(data) {
  const s = data.summary;
  setKpi('kpiTps', fmt(s.aggregate_tps, 2));
  $('kpiTpsSub').textContent = `${s.total_output_tokens} tok ÷ ${(s.wall_time_ms / 1000).toFixed(1)}s`;
  setKpi('kpiDec', fmt(s.aggregate_decode_tps, 2));
  $('kpiDecSub').textContent = `单请求均值 ${fmt(s.avg_decode_tps, 2)} tok/s`;
  setKpi('kpiTtft', fmt(s.avg_ttft_ms, 0));
  // 思考模式下 TTFT 是"首个输出 token"，用户真正看到字要等答案开始
  if (s.avg_answer_ttft_ms != null) {
    $('kpiTtftSub').textContent = `p95 ${fmt(s.p95_ttft_ms, 0)}ms · 答案首字 ${fmt(s.avg_answer_ttft_ms, 0)}ms`;
  } else {
    $('kpiTtftSub').textContent = `p50 ${fmt(s.p50_ttft_ms, 0)} / p95 ${fmt(s.p95_ttft_ms, 0)} ms`;
  }
  setKpi('kpiTpot', fmt(s.avg_tpot_ms, 2));
  $('kpiTpotSub').textContent = `p50 ${fmt(s.p50_tpot_ms, 2)} / p95 ${fmt(s.p95_tpot_ms, 2)}`;
  setKpi('kpiTokens', s.total_output_tokens);
  // 思考 token 单独标注，因为它已包含在总输出 token 里
  const rk = s.total_reasoning_tokens || 0;
  const rkPct = s.total_output_tokens > 0 ? (rk / s.total_output_tokens * 100) : 0;
  $('kpiTokensSub').textContent = rk > 0
    ? `其中思考 ${rk} tok (${rkPct.toFixed(1)}%) · 口径 usage ${s.tokens_from_usage}/估算 ${s.tokens_from_estimate}`
    : `上游 usage 精确 ${s.tokens_from_usage} 条 · 本地估算 ${s.tokens_from_estimate} 条`;
  setKpi('kpiOk', fmt(s.success_rate, 1));
  $('kpiOkSub').textContent = `${s.ok} / ${s.requests} 成功`;

  // 思考模式实际生效情况
  const th = data.thinking;
  if (th && th.provider) {
    log(`思考模式：${th.note}`, '#5b8cff');
  }

  // 明细表整体重绘：progress 阶段已逐行追加，这里用最终数据整体替换，
  // 保证字段完整（progress 事件里的记录是精简版，缺 itl/text_head）
  renderTable(data.records);
  $('tableCount').textContent = data.records.length + ' 条';

  drawAll(data);
}

function renderTable(records) {
  const body = $('resultBody');
  body.innerHTML = '';
  if (!records.length) {
    body.innerHTML = '<tr class="empty"><td colspan="14">还没有数据，点「开始压测」</td></tr>';
    return;
  }
  for (const r of records) appendRow(r);
}

function setKpi(id, val) {
  const el = $(id);
  const unit = el.querySelector('.unit');
  el.textContent = val;
  if (unit) el.appendChild(unit);
}

function appendRow(r) {
  const body = $('resultBody');
  const empty = body.querySelector('.empty');
  if (empty) empty.remove();
  const tr = document.createElement('tr');
  const srcLabel = r.token_source === 'usage' ? 'usage' : '估算';
  const srcTitle = r.token_source === 'usage'
    ? '上游 usage 精确计数'
    : '本地估算（tiktoken 或启发式）';
  const cells = [
    r.seq,
    r.ok ? '<span class="badge ok">OK</span>' : '<span class="badge err">FAIL</span>',
    fmt(r.ttft_ms, 1),
    r.answer_ttft_ms != null ? fmt(r.answer_ttft_ms, 1) : '—',
    fmt(r.total_ms, 1),
    fmt(r.gen_ms, 1),
    r.output_tokens,
    r.reasoning_tokens ? `<span class="src-tag src-th" title="思考 token（含在输出 token 内）">${r.reasoning_tokens}</span>` : '0',
    `<span class="src-tag src-${r.token_source === 'usage' ? 'u' : 'e'}" title="${srcTitle}">${srcLabel}</span>`,
    fmt(r.decode_tps, 2),
    fmt(r.e2e_tps, 2),
    fmt(r.tpot_ms, 2),
    r.chunks,
    r.error ? `<span class="err-text" title="${escapeAttr(r.error)}">${escapeHtml(r.error)}</span>` : '',
  ];
  cells.forEach((c, i) => {
    const td = document.createElement('td');
    if (i === 0 || i === 1 || i === 7 || i === 8 || i === 12) td.innerHTML = c;
    else td.textContent = c;
    tr.appendChild(td);
  });
  body.appendChild(tr);
}

/* ---------------- 图表（原生 Canvas，无第三方依赖） ---------------- */
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';
}

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(320, rect.width);
  const h = Number(cv.getAttribute('height')) || 220;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawFrame(ctx, box, xLabel, yLabel, yTicks) {
  const { x, y, w, h } = box;
  ctx.save();
  ctx.strokeStyle = cssVar('--border');
  ctx.lineWidth = 1;
  ctx.fillStyle = cssVar('--muted');
  ctx.font = '10px -apple-system, sans-serif';

  yTicks.forEach((t) => {
    const yy = y + h - (t.pos * h);
    ctx.beginPath();
    ctx.moveTo(x, yy + 0.5);
    ctx.lineTo(x + w, yy + 0.5);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.label, x - 6, yy);
  });

  ctx.strokeStyle = cssVar('--border');
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y);
  ctx.lineTo(x + 0.5, y + h + 0.5);
  ctx.lineTo(x + w, y + h + 0.5);
  ctx.stroke();

  if (xLabel) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(xLabel, x + w, y + h + 7);
  }
  if (yLabel) {
    ctx.save();
    ctx.translate(11, y);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function niceTicks(max, count) {
  if (!isFinite(max) || max <= 0) max = 1;
  // 取整步长（1/2/2.5/5 × 10^n），保证刻度值是好读的整数
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;   // 轴顶取整到 step 的倍数
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    ticks.push({ pos: v / top, label: fmtAxis(v) });
  }
  ticks.axisTop = top;   // 数据归一化必须用同一个基准，否则会画到轴外
  return ticks;
}

function fmtAxis(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  if (a === 0) return '0';
  return v.toFixed(2);
}

function drawTpsChart(data) {
  const cv = $('chartTps');
  const { ctx, w, h } = setupCanvas(cv);
  const box = { x: 42, y: 14, w: w - 58, h: h - 46 };
  const pts = (data && data.timeline && data.timeline.points) || [];
  if (!pts.length) { drawEmpty(ctx, box, '暂无数据'); return; }

  const maxCum = Math.max(...pts.map((p) => p.cum_tokens), 1);
  const maxInst = Math.max(...pts.map((p) => p.inst_tps), 1);
  const t0 = pts[0].t_ms, t1 = pts[pts.length - 1].t_ms || 1;

  const cumTicks = niceTicks(maxCum, 4);
  const cumTop = cumTicks.axisTop;      // 归一化基准 = 轴顶
  drawFrame(ctx, box, '时间(ms)', '累计 token', cumTicks);

  // 累计 token 面积
  const grad = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
  grad.addColorStop(0, hexA(cssVar('--a'), .28));
  grad.addColorStop(1, hexA(cssVar('--a'), .02));
  ctx.beginPath();
  pts.forEach((p, i) => {
    const px = box.x + ((p.t_ms - t0) / (t1 - t0 || 1)) * box.w;
    const py = box.y + box.h - (p.cum_tokens / cumTop) * box.h;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.lineTo(box.x, box.y + box.h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => {
    const px = box.x + ((p.t_ms - t0) / (t1 - t0 || 1)) * box.w;
    const py = box.y + box.h - (p.cum_tokens / cumTop) * box.h;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.strokeStyle = cssVar('--a');
  ctx.lineWidth = 2;
  ctx.stroke();

  // 瞬时 tok/s（橙色柱，右轴语义，高度按自身峰值归一化，限制在 0.55 框高内）
  const bw = Math.max(1, box.w / pts.length - 1);
  ctx.fillStyle = hexA(cssVar('--b'), .55);
  pts.forEach((p) => {
    const px = box.x + ((p.t_ms - t0) / (t1 - t0 || 1)) * box.w;
    const ph = (p.inst_tps / maxInst) * box.h * 0.55;
    ctx.fillRect(px - bw / 2, box.y + box.h - ph, bw, ph);
  });

  ctx.font = '10px -apple-system, sans-serif';
  const peakTxt = '瞬时峰值 ' + fmt(maxInst, 1) + ' tok/s';
  const tw = ctx.measureText(peakTxt).width;
  // 放左上角：累计曲线从左下升到右上，左上恒为空白；加背景避免压住网格线
  const pxx = box.x + 3;
  const pyy = box.y + 11;
  ctx.fillStyle = hexA(cssVar('--card'), .9);
  ctx.fillRect(pxx - 2, pyy - 10, tw + 5, 13);
  ctx.fillStyle = cssVar('--muted');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(peakTxt, pxx, pyy);
}

function drawTtftChart(data) {
  const cv = $('chartTtft');
  const { ctx, w, h } = setupCanvas(cv);
  const box = { x: 42, y: 14, w: w - 58, h: h - 46 };
  const recs = (data && data.records) || [];
  const vals = recs.filter((r) => r.ok).map((r) => r.ttft_ms).filter((v) => v != null);
  if (!vals.length) { drawEmpty(ctx, box, '暂无数据'); return; }

  const maxV = Math.max(...vals, 1);
  const med = pctOf(vals, 50);
  // 离群判定用中位数的倍数，而不是"接近最大值"。
  // 否则一批 TTFT 几乎相同的请求会全部被判成离群，整屏变橙色。
  const outlierLine = Math.max(med * 1.5, 1);
  const ttftTicks = niceTicks(maxV, 4);
  const ttftTop = ttftTicks.axisTop;
  drawFrame(ctx, box, '请求序号', 'TTFT (ms)', ttftTicks);

  const n = vals.length;
  // 按槽位均分居中，而不是把第 1 根和第 n 根钉在两端。
  // 后者在请求数少（n=2/3）时中间会留大片空白，看起来像数据丢了。
  const slot = box.w / n;
  const bw = Math.max(2, Math.min(26, slot - 2));
  vals.forEach((v, i) => {
    const px = box.x + slot * i + slot / 2;
    const ph = (v / ttftTop) * box.h;
    const hot = v > outlierLine;
    ctx.fillStyle = hot ? hexA(cssVar('--b'), .85) : hexA(cssVar('--c'), .8);
    ctx.fillRect(px - bw / 2, box.y + box.h - ph, bw, ph);
  });

  // 离群阈值虚线
  if (outlierLine < ttftTop) {
    const ly = box.y + box.h - (outlierLine / ttftTop) * box.h;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = hexA(cssVar('--b'), .6);
    ctx.beginPath();
    ctx.moveTo(box.x, ly);
    ctx.lineTo(box.x + box.w, ly);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('离群线 ' + fmt(outlierLine, 0) + 'ms', box.x + box.w, ly - 2);
  }
}

/** 线性插值分位数，与后端 pct() 口径一致 */
function pctOf(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const k = (s.length - 1) * (p / 100);
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

function drawItlChart(data) {
  const cv = $('chartItl');
  const { ctx, w, h } = setupCanvas(cv);
  const box = { x: 42, y: 14, w: w - 58, h: h - 46 };
  const curve = data && data.itl_curve;
  if (!curve || !curve.p50 || !curve.p50.length) { drawEmpty(ctx, box, '暂无数据'); return; }

  // 三条分位曲线必须等长且逐点对应，否则画出来是斜线
  const n = Math.min(curve.p50.length, curve.p10.length, curve.p90.length);
  if (!n) { drawEmpty(ctx, box, '暂无数据'); return; }
  const p10 = curve.p10.slice(0, n);
  const p50 = curve.p50.slice(0, n);
  const p90 = curve.p90.slice(0, n);

  const all = p10.concat(p90).filter((v) => v != null);
  const maxV = Math.max(...all, 1);
  const itlTicks = niceTicks(maxV, 4);
  const itlTop = itlTicks.axisTop;
  drawFrame(ctx, box, 'token 序号', 'ITL (ms)', itlTicks);

  const band = (arr, color) => {
    ctx.beginPath();
    arr.forEach((v, i) => {
      if (v == null) return;
      const px = box.x + (i / Math.max(1, n - 1)) * box.w;
      const py = box.y + box.h - (v / itlTop) * box.h;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  band(p10, '#9aa4b5');
  band(p90, cssVar('--b'));
  band(p50, cssVar('--a'));
}

function drawPctChart(data) {
  const cv = $('chartPct');
  const { ctx, w, h } = setupCanvas(cv);
  const box = { x: 42, y: 14, w: w - 58, h: h - 46 };
  const s = data && data.summary;
  if (!s) { drawEmpty(ctx, box, '暂无数据'); return; }

  const labels = ['p50', 'p90', 'p95', 'p99'];
  const ttft = [s.p50_ttft_ms, s.p90_ttft_ms, s.p95_ttft_ms, s.p99_ttft_ms];
  const tpot = [s.p50_tpot_ms, s.p90_tpot_ms, s.p95_tpot_ms, s.p99_tpot_ms];
  const maxV = Math.max(...ttft.filter((v) => v != null), ...tpot.filter((v) => v != null), 1);
  const pctTicks = niceTicks(maxV, 4);
  const pctTop = pctTicks.axisTop;
  drawFrame(ctx, box, '分位', '毫秒', pctTicks);

  const groupW = box.w / labels.length;
  const bw = groupW * 0.26;
  labels.forEach((lb, i) => {
    const cx = box.x + groupW * i + groupW / 2;
    const a = ttft[i] != null ? (ttft[i] / pctTop) * box.h : 0;
    const b = tpot[i] != null ? (tpot[i] / pctTop) * box.h : 0;
    ctx.fillStyle = hexA(cssVar('--a'), .85);
    ctx.fillRect(cx - bw - 1, box.y + box.h - a, bw, a);
    ctx.fillStyle = hexA(cssVar('--b'), .85);
    ctx.fillRect(cx + 1, box.y + box.h - b, bw, b);
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(lb, cx, box.y + box.h + 6);
  });
}

function drawEmpty(ctx, box, text) {
  ctx.save();
  ctx.fillStyle = cssVar('--muted');
  ctx.font = '12px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, box.x + box.w / 2, box.y + box.h / 2);
  ctx.restore();
}

function drawAll(data) {
  drawTpsChart(data);
  drawTtftChart(data);
  drawItlChart(data);
  drawPctChart(data);
}

function hexA(color, alpha) {
  const c = color.replace('#', '');
  if (c.length !== 6) return color;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ---------------- 探测 ---------------- */
async function runProbe() {
  const cfg = readForm();
  if (!cfg.base_url || !cfg.model) { setStatus('请先填写 Base URL 与模型', 'err'); return; }
  $('probeBtn').disabled = true;
  $('probeModal').hidden = false;
  $('probeText').textContent = '请求中…';
  $('probeStats').innerHTML = '';
  setStatus('探测中…', 'run');
  try {
    await readSSE(API + '/api/probe', cfg, (ev) => {
      if (ev.type === 'probe_result') {
        $('probeText').textContent = ev.text || '(空响应)';
        const items = [
          ['TTFT', fmt(ev.ttft_ms, 1) + ' ms'],
          ['总耗时', fmt(ev.total_ms, 1) + ' ms'],
          ['解码速率', fmt(ev.decode_tps, 2) + ' tok/s'],
          ['端到端', fmt(ev.e2e_tps, 2) + ' tok/s'],
          ['输出 tok', ev.output_tokens + (ev.token_source === 'usage' ? ' (usage)' : ' (估算)')],
          ['TPOT', ev.tpot_ms != null ? fmt(ev.tpot_ms, 2) + ' ms' : '—'],
          ['chunks', ev.chunks],
        ];
        $('probeStats').innerHTML = items.map(([l, v]) =>
          `<div class="pstat"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
        log(`探测完成：TTFT ${fmt(ev.ttft_ms, 1)}ms，${fmt(ev.decode_tps, 2)} tok/s`);
        setStatus('探测完成');
      } else if (ev.type === 'error') {
        $('probeText').textContent = '错误：' + ev.error;
        setStatus('探测失败：' + ev.error, 'err');
      }
    });
  } catch (e) {
    $('probeText').textContent = '异常：' + e.message;
    setStatus('探测异常：' + e.message, 'err');
  } finally {
    $('probeBtn').disabled = false;
  }
}

/* ---------------- 配置保存 ---------------- */
async function saveConfig() {
  const cfg = readForm();
  const payload = Object.assign({}, cfg);
  if (!$('rememberKey').checked) payload.api_key = '';   // 不记 Key 时落盘清空
  try {
    const r = await fetch(API + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.ok) { setStatus('配置已保存到 config.json'); log('配置已保存'); }
    else setStatus('保存失败', 'err');
  } catch (e) {
    setStatus('保存失败：' + e.message, 'err');
  }
}

async function loadConfig() {
  try {
    const r = await fetch(API + '/api/config', { cache: 'no-store' });
    const cfg = await r.json();
    fillForm(cfg);
    if (cfg.api_key) $('rememberKey').checked = true;
    setStatus('已加载配置');
  } catch (e) {
    fillForm(DEFAULTS);
    setStatus('读取配置失败，使用默认值', 'err');
  }
}

/* ---------------- 导出 ---------------- */
function download(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportJson() {
  if (!lastResult) { setStatus('暂无结果可导出', 'err'); return; }
  download('throughput-result.json', JSON.stringify(lastResult, null, 2), 'application/json');
}

function exportCsv() {
  if (!lastResult) { setStatus('暂无结果可导出', 'err'); return; }
  const head = ['seq', 'ok', 'ttft_ms', 'answer_ttft_ms', 'total_ms', 'gen_ms',
    'output_tokens', 'reasoning_tokens', 'reasoning_chunks',
    'decode_tps', 'e2e_tps', 'tpot_ms', 'chunks', 'chars', 'token_source', 'error'];
  const lines = [head.join(',')];
  for (const r of lastResult.records) {
    lines.push(head.map((k) => {
      const v = r[k];
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  download('throughput-result.csv', lines.join('\n'), 'text/csv;charset=utf-8');
}

/* ---------------- 工具 ---------------- */
function fmt(v, d) {
  if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
  return typeof v === 'number' ? v.toFixed(d) : v;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('runBtn').addEventListener('click', runBench);
  $('stopBtn').addEventListener('click', stopBench);
  $('probeBtn').addEventListener('click', runProbe);
  $('saveBtn').addEventListener('click', saveConfig);
  $('resetBtn').addEventListener('click', () => {
    fillForm(DEFAULTS);
    setStatus('已恢复默认配置（未保存到磁盘）');
  });
  $('exportJson').addEventListener('click', exportJson);
  $('exportCsv').addEventListener('click', exportCsv);
  $('clearLog').addEventListener('click', () => { $('logBox').innerHTML = ''; });
  $('probeClose').addEventListener('click', () => { $('probeModal').hidden = true; });
  $('probeModal').addEventListener('click', (e) => {
    if (e.target === $('probeModal')) $('probeModal').hidden = true;
  });
  $('apiFormat').addEventListener('change', () => {
    syncPathByFormat();
    // 协议一变，预设基本就对不上了
    $('provider').value = '-1';
    syncProviderHint();
  });
  $('provider').addEventListener('change', (e) => applyProvider(parseInt(e.target.value, 10)));
  $('fetchModelsBtn').addEventListener('click', fetchModels);
  $('thinkingProvider').addEventListener('change', () => {
    $('thinkingFields').hidden = !$('thinkingProvider').value;
    refreshThinkingLevels();
  });
  $('thinkingLevel').addEventListener('change', updateThinkingHint);
  $('thinkingEnabled').addEventListener('change', updateThinkingHint);
  // 手动改 base/path/format 时，下拉自动跳到自定义，避免显示的预设与实际不符
  ['baseUrl', 'path'].forEach((id) => {
    $(id).addEventListener('change', syncProviderSelect);
  });
  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('themeBtn').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('tt-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    if (lastResult) drawAll(lastResult);
  });
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (lastResult) drawAll(lastResult); else drawAll(null); }, 150);
  });
}

/* ---------------- 启动 ---------------- */
(function init() {
  if (localStorage.getItem('tt-theme') === 'dark') document.body.classList.add('dark');
  fillProviderSelect();   // 先填下拉，loadConfig 里要反查匹配
  bind();
  resetKpi();
  loadConfig();
  pingHealth();
  drawAll(null);
  setStatus('就绪');
})();
