/* ===== 历史记录存储 =====
 * 每次压测结束后把结果存进 localStorage，之后可以点开回看。
 *
 * 存储取舍：localStorage 一般 5MB，全量存会撑爆。这里做了三档降采样：
 *   - timeline 曲线降到 150 点（原始最多 800）
 *   - itl_curve 降到 100 个采样点
 *   - per-request 记录只留关键字段，且只留最近 200 条
 * 折算下来单条约 12KB，存 50 条 600KB，安全。
 * ============================================================ */
'use strict';

const HISTORY_KEY = 'tt-history-v1';
const MAX_RECORDS = 50;          // 保留条数上限
const MAX_TIMELINE = 150;        // 曲线降采样目标点数
const MAX_ITL = 100;             // ITL 曲线采样点数
const MAX_DETAIL = 200;          // 保留的请求明细条数

/** localStorage 在隐私模式 / 配额满时会抛异常，统一兜住 */
function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeSet(key, val) {
  try {
    localStorage.setItem(key, val);
    return true;
  } catch (e) {
    // 配额满：清掉一半再试一次
    try {
      const all = loadHistory();
      const half = all.slice(0, Math.ceil(all.length / 2));
      localStorage.setItem(key, JSON.stringify(half));
      localStorage.setItem(key, val);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function loadHistory() {
  const raw = safeGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveHistory(list) {
  return safeSet(HISTORY_KEY, JSON.stringify(list));
}

/** 均匀降采样到 target 个点，保留首尾。
 *  注意：即使不需要降采样（长度已 ≤ target），也要走一遍 pick，
 *  否则存的会是原始对象（字段名 t_ms/cum_tokens…），
 *  还原时按 t/c/i/s 取就全是 undefined。 */
function downsample(arr, target, pick) {
  if (!arr || !arr.length) return [];
  let idxs;
  if (arr.length <= target) {
    idxs = arr.map((_, i) => i);
  } else {
    const step = (arr.length - 1) / (target - 1);
    idxs = [];
    for (let i = 0; i < target; i++) idxs.push(Math.round(i * step));
  }
  const out = [];
  for (const i of idxs) {
    const v = pick(arr[i]);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** 从完整结果里提取可存储的精简版 */
function buildEntry(result, meta) {
  const s = result.summary || {};
  const cfg = result.config || {};
  const th = result.thinking || {};

  const timeline = (result.timeline && result.timeline.points) || [];
  const tl = downsample(timeline, MAX_TIMELINE, (p) => ({
    t: p.t_ms, c: p.cum_tokens, i: p.inst_tokens, s: p.inst_tps,
  }));

  const itl = result.itl_curve || {};
  const itlOut = {
    idx: downsample(itl.idx || [], MAX_ITL, (v) => v),
    p10: downsample(itl.p10 || [], MAX_ITL, (v) => v),
    p50: downsample(itl.p50 || [], MAX_ITL, (v) => v),
    p90: downsample(itl.p90 || [], MAX_ITL, (v) => v),
  };

  // 请求明细只留展示需要的字段
  const detail = (result.records || []).slice(0, MAX_DETAIL).map((r) => ({
    seq: r.seq,
    ok: r.ok,
    ttft: r.ttft_ms,
    attft: r.answer_ttft_ms,
    total: r.total_ms,
    gen: r.gen_ms,
    tok: r.output_tokens,
    rtok: r.reasoning_tokens,
    src: r.token_source,
    dtps: r.decode_tps,
    etps: r.e2e_tps,
    tpot: r.tpot_ms,
    ch: r.chunks,
    err: r.error || '',
  }));

  return {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    time: meta.time,
    model: cfg.model || meta.model || '未知模型',
    base: cfg.base_url || '',
    concurrency: cfg.concurrency,
    requests: cfg.requests,
    // 存两样：note 是人类可读的说明，provider 是"是否真的配了思考模式"的判据。
    // 不能用 note 是否为空来判断——未配置时 note 也会是"未配置"这种非空字符串。
    thinking: th.provider ? (th.note || '') : '',
    thinking_provider: th.provider || '',
    summary: {
      aggregate_tps: s.aggregate_tps,      aggregate_decode_tps: s.aggregate_decode_tps,
      avg_ttft_ms: s.avg_ttft_ms,
      p50_ttft_ms: s.p50_ttft_ms,
      p95_ttft_ms: s.p95_ttft_ms,
      p99_ttft_ms: s.p99_ttft_ms,
      avg_tpot_ms: s.avg_tpot_ms,
      p50_tpot_ms: s.p50_tpot_ms,
      p95_tpot_ms: s.p95_tpot_ms,
      avg_decode_tps: s.avg_decode_tps,
      avg_e2e_tps: s.avg_e2e_tps,
      total_output_tokens: s.total_output_tokens,
      total_reasoning_tokens: s.total_reasoning_tokens,
      total_prompt_tokens: s.total_prompt_tokens,
      wall_time_ms: s.wall_time_ms,
      ok: s.ok,
      failed: s.failed,
      requests: s.requests,
      success_rate: s.success_rate,
      tokens_from_usage: s.tokens_from_usage,
      tokens_from_estimate: s.tokens_from_estimate,
      avg_answer_ttft_ms: s.avg_answer_ttft_ms,
    },
    timeline: tl,
    itl: itlOut,
    detail: detail,
  };
}

/** 存一条，返回是否成功 */
function addHistory(result, meta) {
  const entry = buildEntry(result, meta || {});
  const list = loadHistory();
  list.unshift(entry);          // 新的在前
  while (list.length > MAX_RECORDS) list.pop();
  return saveHistory(list) ? entry : null;
}

function removeHistory(id) {
  const list = loadHistory().filter((e) => e.id !== id);
  return saveHistory(list);
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

function getHistory(id) {
  return loadHistory().find((e) => e.id === id) || null;
}

/** 把存储的精简 entry 还原成前端渲染要的结构 */
function entryToResult(entry) {
  return {
    summary: entry.summary,
    config: {
      model: entry.model,
      base_url: entry.base,
      concurrency: entry.concurrency,
      requests: entry.requests,
    },
    thinking: { note: entry.thinking, provider: '' },
    timeline: {
      bucket_ms: 100,
      points: (entry.timeline || []).map((p) => ({
        t_ms: p.t, cum_tokens: p.c, inst_tokens: p.i, inst_tps: p.s,
      })),
    },
    itl_curve: entry.itl || { p10: [], p50: [], p90: [], idx: [] },
    records: (entry.detail || []).map((r) => ({
      seq: r.seq,
      ok: r.ok,
      ttft_ms: r.ttft,
      answer_ttft_ms: r.attft,
      total_ms: r.total,
      gen_ms: r.gen,
      output_tokens: r.tok,
      reasoning_tokens: r.rtok,
      token_source: r.src,
      decode_tps: r.dtps,
      e2e_tps: r.etps,
      tpot_ms: r.tpot,
      chunks: r.ch,
      error: r.err,
    })),
  };
}
