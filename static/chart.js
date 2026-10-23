/* ===== 图表交互层 =====
 * 给原生 Canvas 图表加上：悬停高亮、鼠标跟随 tooltip、点击选中。
 *
 * 各图表在绘制时调用 registerHit() 登记可交互元素（点/柱/线段），
 * 交互层负责命中测试与反馈渲染。
 * ============================================================ */
'use strict';

/* ---------------- tooltip 元素 ---------------- */
let tipEl = null;

function getTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'chart-tip';
  tipEl.style.display = 'none';
  document.body.appendChild(tipEl);
  return tipEl;
}

function showTip(html, x, y) {
  const t = getTip();
  t.innerHTML = html;
  t.style.display = 'block';
  // 贴近光标但不超出视口
  const pad = 14;
  const rect = t.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) {
    left = x - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - 8) {
    top = y - rect.height - pad;
  }
  t.style.left = Math.max(4, left) + 'px';
  t.style.top = Math.max(4, top) + 'px';
}

function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

/* ---------------- 命中区注册 ---------------- */
// 每个 canvas 存一份：{ hits: [...], hover: idx, selected: idx, onSelect: fn }
const HIT_STATE = new WeakMap();

/**
 * 登记一个可命中的元素
 * @param {HTMLCanvasElement} cv
 * @param {{x:number,y:number,w:number,h:number, tip:string, data:any}} hit
 */
function registerHit(cv, hit) {
  let st = HIT_STATE.get(cv);
  if (!st) {
    st = { hits: [], hover: -1, selected: -1, onSelect: null, redraw: null };
    HIT_STATE.set(cv, st);
  }
  st.hits.push(hit);
  return st;
}

function clearHits(cv) {
  const st = HIT_STATE.get(cv);
  if (st) st.hits = [];
}

/** 画完图后调用，把命中区挂上并绑定一次性的事件 */
function attachInteraction(cv, redrawFn, onSelectFn) {
  let st = HIT_STATE.get(cv);
  if (!st) {
    st = { hits: [], hover: -1, selected: -1, onSelect: null, redraw: null };
    HIT_STATE.set(cv, st);
  }
  st.redraw = redrawFn;
  if (onSelectFn) st.onSelect = onSelectFn;
  if (st.bound) return;
  st.bound = true;

  cv.style.cursor = 'default';

  cv.addEventListener('mousemove', (e) => {
    const s = HIT_STATE.get(cv);
    if (!s || !s.hits.length) return;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let idx = -1;
    // 后注册的优先（上层元素）
    for (let i = s.hits.length - 1; i >= 0; i--) {
      const h = s.hits[i];
      if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) {
        idx = i;
        break;
      }
    }
    if (idx !== s.hover) {
      s.hover = idx;
      cv.style.cursor = idx >= 0 ? 'pointer' : 'default';
      if (s.redraw) s.redraw();
    }
    if (idx >= 0) {
      showTip(s.hits[idx].tip, e.clientX, e.clientY);
    } else {
      hideTip();
    }
  });

  cv.addEventListener('mouseleave', () => {
    const s = HIT_STATE.get(cv);
    if (!s) return;
    if (s.hover !== -1) {
      s.hover = -1;
      if (s.redraw) s.redraw();
    }
    hideTip();
  });

  cv.addEventListener('click', (e) => {
    const s = HIT_STATE.get(cv);
    if (!s || !s.hits.length) return;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    let idx = -1;
    for (let i = s.hits.length - 1; i >= 0; i--) {
      const h = s.hits[i];
      if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      // 点空白处取消选中
      if (s.selected !== -1) {
        s.selected = -1;
        if (s.redraw) s.redraw();
        if (s.onSelect) s.onSelect(null);
      }
      return;
    }
    s.selected = (s.selected === idx) ? -1 : idx;
    if (s.redraw) s.redraw();
    if (s.onSelect) s.onSelect(s.selected >= 0 ? s.hits[idx].data : null);
  });
}

/** 取当前选中的 data（给外部用） */
function getSelected(cv) {
  const s = HIT_STATE.get(cv);
  if (!s || s.selected < 0) return null;
  return s.hits[s.selected].data;
}

function clearSelection(cv) {
  const s = HIT_STATE.get(cv);
  if (!s) return;
  s.selected = -1;
  s.hover = -1;
  if (s.redraw) s.redraw();
}

/** 悬停态索引，绘制时用来高亮 */
function getHover(cv) {
  const s = HIT_STATE.get(cv);
  return s ? s.hover : -1;
}
