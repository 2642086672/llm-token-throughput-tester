#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
模型吞吐压测后端 —— throughput-tester

对外只暴露三件事：
  POST /api/probe    单次流式探测：实时回吐 token 增量 + 逐项计时（TTFT / ITL）
  POST /api/bench    并发压测：实时回吐每请求结果 + 最终聚合统计（吞吐 / TTFT 分位 / TPOT）
  POST /api/config   保存前端改过的默认配置（仅落本地 config.json）

另提供：
  GET  /api/config   读取当前默认配置
  GET  /api/health   健康检查
  GET  /              静态前端

零第三方依赖，只用 Python 标准库。
运行：python server.py --host 127.0.0.1 --port 8770
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import queue
import socket
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

try:
    from thinking import apply_thinking, thinking_note
except ImportError:  # 直接以脚本方式运行时也保证能找到同目录模块
    import os
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from thinking import apply_thinking, thinking_note

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

# ---------------------------------------------------------------- 默认配置

DEFAULT_CONFIG = {
    "base_url": "https://api.openai.com",
    "api_key": "",
    "api_format": "openai",          # openai | anthropic
    "path": "/v1/chat/completions",  # 上游接口路径
    "model": "gpt-4o-mini",
    "prompt": "用大约 300 个字详细介绍一下量子计算的历史、原理和当前的应用前景。",
    "max_tokens": 512,
    "temperature": 0.7,
    "include_usage": True,           # OpenAI 兼容协议下请求 usage 统计
    "extra_body": "",                # 追加到请求体的 JSON 片段（字符串）
    "thinking_provider": "",         # 思考参数风格：openai/anthropic/deepseek/glm/qwen/gemini/mimo/longcat
    "thinking_enabled": None,        # None=用模型默认；True/False=强制开关
    "thinking_level": "",            # 强度档位，见 thinking.py LEVELS
    "thinking_budget": 0,           # token 预算（Qwen / LongCat 用）
    "timeout": 120,                  # 单请求超时（秒）
    "verify_tls": True,
    "keepalive": False,              # 是否复用 TCP 连接（影响 TTFT 口径）
    "requests": 20,                  # 总请求数
    "concurrency": 4,                # 并发数
    "warmup": 1,                     # 预热请求数（不计入统计）
    "bucket_ms": 100,                # 吞吐曲线采样桶宽（毫秒）
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                cfg.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
        except Exception as e:  # 配置坏了不能让服务起不来
            print(f"[config] 读取失败，使用默认配置：{e}", file=sys.stderr)
    return cfg


def save_config(cfg: dict) -> dict:
    clean = {k: cfg.get(k, DEFAULT_CONFIG[k]) for k in DEFAULT_CONFIG}
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)  # 原子替换，避免半截文件
    return clean


# ---------------------------------------------------------------- token 计数

_ENCODER = None          # tiktoken 编码器（若环境装了）
_ENCODER_TRIED = False


def _encoder():
    global _ENCODER, _ENCODER_TRIED
    if not _ENCODER_TRIED:
        _ENCODER_TRIED = True
        try:
            import tiktoken  # type: ignore
            _ENCODER = tiktoken.get_encoding("cl100k_base")
        except Exception:
            _ENCODER = None
    return _ENCODER


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
        or 0x3040 <= o <= 0x30FF or 0xAC00 <= o <= 0xD7AF
        or 0xF900 <= o <= 0xFAFF or 0x3000 <= o <= 0x303F
        or 0xFF01 <= o <= 0xFF60
    )


def count_tokens(text: str) -> int:
    """精确计数走 tiktoken，缺失时退化为启发式估算（CJK 1 字≈1 token，ASCII 4 字符≈1 token）。"""
    if not text:
        return 0
    enc = _encoder()
    if enc is not None:
        try:
            return len(enc.encode(text, disallowed_special=()))
        except Exception:
            pass
    cjk = 0
    for ch in text:
        if _is_cjk(ch):
            cjk += 1
    other = len(text) - cjk
    return cjk + (other + 3) // 4


# ---------------------------------------------------------------- 上游调用

class UpstreamError(Exception):
    pass


class Upstream:
    """一个上游连接持有者。keepalive=True 时连接在本 worker 的多条请求间复用。"""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        u = urlparse(cfg["base_url"])
        self.scheme = u.scheme or "https"
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or (443 if self.scheme == "https" else 80)
        self.base_path = (u.path or "").rstrip("/")
        self.path = cfg["path"] if cfg["path"].startswith("/") else "/" + cfg["path"]
        self.conn = None
        self.timeout = float(cfg.get("timeout") or 120)

    def _new_conn(self):
        if self.scheme == "https":
            ctx = ssl.create_default_context()
            if not self.cfg.get("verify_tls", True):
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            return http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout, context=ctx)
        return http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)

    def connect(self):
        if self.conn is None:
            self.conn = self._new_conn()
        return self.conn

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None

    # -- 真正发一次请求 -------------------------------------------------
    def post(self, body: dict, headers: dict) -> dict:
        keep = bool(self.cfg.get("keepalive"))
        if keep and self.conn is not None:
            try:
                return self._do(self.conn, body, headers)
            except (http.client.HTTPException, OSError, socket.timeout):
                self.close()
        conn = self._new_conn()
        try:
            result = self._do(conn, body, headers)
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            raise
        if keep:
            self.conn = conn
        else:
            try:
                conn.close()
            except Exception:
                pass
        return result

    def _do(self, conn, body: dict, headers: dict) -> dict:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        t0 = time.perf_counter()
        conn.request("POST", self.base_path + self.path, body=payload, headers=headers)
        resp = conn.getresponse()
        ctype = (resp.getheader("Content-Type") or "").lower()

        if resp.status != 200:
            try:
                raw = resp.read(4096).decode("utf-8", "replace")
            except Exception:
                raw = ""
            raise UpstreamError(f"HTTP {resp.status} {resp.reason}: {raw[:400]}")

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        reasoning_chunks = 0
        usage = None
        chunks: list[tuple[float, str]] = []   # (相对秒, 增量文本，含思考)
        ttft = None
        answer_ttft = None

        if "application/json" in ctype and "event-stream" not in ctype:
            # 上游没走流式，退化成整体 JSON
            raw = resp.read().decode("utf-8", "replace")
            try:
                obj = json.loads(raw)
            except Exception:
                obj = {}
            content = ""
            think = ""
            ch = obj.get("choices")
            if isinstance(ch, list) and ch:
                msg = ch[0].get("message") or {}
                content = msg.get("content") or ch[0].get("text") or ""
                think = msg.get("reasoning_content") or msg.get("thinking") or ""
            if isinstance(obj.get("usage"), dict):
                usage = obj["usage"]
            now = time.perf_counter() - t0
            if think:
                reasoning_parts.append(think)
                reasoning_chunks += 1
                chunks.append((now, think))
                ttft = now
            if content:
                text_parts.append(content)
                chunks.append((now, content))
                if ttft is None:
                    ttft = now
                answer_ttft = now
        else:
            for raw_line in _iter_lines(resp):
                line = raw_line.decode("utf-8", "replace").strip()
                if not line or line.startswith(":") or line.startswith("event:"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                delta, reasoning, u = _parse_delta(obj)
                if u:
                    usage = u
                now = time.perf_counter()
                # 思考增量先于答案到达，但它同样计入输出 token，
                # 所以计入 chunks（影响 ITL 与吞吐曲线），只是不计入 text。
                if reasoning:
                    if ttft is None:
                        ttft = now - t0
                    reasoning_parts.append(reasoning)
                    reasoning_chunks += 1
                    chunks.append((now - t0, reasoning))
                if delta:
                    if ttft is None:
                        ttft = now - t0
                    if answer_ttft is None:
                        answer_ttft = now - t0
                    text_parts.append(delta)
                    chunks.append((now - t0, delta))

        total = time.perf_counter() - t0
        if ttft is None:
            ttft = total
        if answer_ttft is None:
            answer_ttft = None      # 纯思考没有答案
        return {
            "text": "".join(text_parts),
            "reasoning": "".join(reasoning_parts),
            "reasoning_chunks": reasoning_chunks,
            "usage": usage,
            "ttft": ttft,
            "answer_ttft": answer_ttft,
            "total": total,
            "chunks": chunks,
        }


def _iter_lines(resp):
    """按行切 SSE。read1 拿到多少读多少，避免 readline 过度阻塞。"""
    buf = b""
    while True:
        try:
            chunk = resp.read1(65536)
        except AttributeError:
            chunk = resp.read(65536)
        if not chunk:
            if buf:
                yield buf
            return
        buf += chunk
        while True:
            i = buf.find(b"\n")
            if i < 0:
                break
            line = buf[:i]
            buf = buf[i + 1:]
            yield line


def _parse_delta(obj: dict):
    """同时兼容 OpenAI chat/completions 与 Anthropic messages 两种流式格式。

    返回 (content_delta, reasoning_delta, usage)：
      content   —— 最终答案的增量
      reasoning —— 思维链增量。思考模式下模型先吐这一路，它同样计入
                   输出 token 与计费，但不算"答案"。各家字段名不同：
                     OpenAI 兼容 : delta.reasoning_content
                     Anthropic   : content_block_delta 里的 thinking 块
                     Gemini      : delta.reasoning_content
    """
    usage = None
    delta = None
    reasoning = None
    if isinstance(obj.get("usage"), dict):
        usage = obj["usage"]
    choices = obj.get("choices")
    if isinstance(choices, list) and choices:
        d = choices[0].get("delta") or {}
        if isinstance(d.get("content"), str):
            delta = d["content"]
        elif isinstance(d.get("text"), str):
            delta = d["text"]
        # 思考增量：OpenAI 兼容与 Gemini 通用
        for k in ("reasoning_content", "reasoning", "thinking"):
            v = d.get(k)
            if isinstance(v, str) and v:
                reasoning = v
                break
    if obj.get("type") == "content_block_delta":
        d = obj.get("delta") or {}
        if isinstance(d.get("text"), str):
            delta = d["text"]
        # Anthropic 思考块走 thinking 字段
        if isinstance(d.get("thinking"), str) and d["thinking"]:
            reasoning = d["thinking"]
    if obj.get("type") == "thinking_delta":
        d = obj.get("delta") or {}
        if isinstance(d.get("thinking"), str) and d["thinking"]:
            reasoning = d["thinking"]
    if obj.get("type") == "message_delta" and isinstance(obj.get("usage"), dict):
        usage = obj["usage"]
    return delta, reasoning, usage


def _models_path_from_chat(chat_path: str, api_format) -> str:
    """从 chat completions 路径推导 /models 路径。

    用户填的是业务接口路径（如 /v1/chat/completions），模型列表接口在同级目录。
    """
    p = (chat_path or "").split("?")[0]
    base = p
    # 剥掉末尾的资源段
    for suffix in ("/chat/completions", "/completions", "/messages"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if not base or base == "/":
        return "/models"
    return base.rstrip("/") + "/models"


def _extract_model_ids(obj) -> list:
    """兼容三种返回结构：{data:[{id}]} / {data:[{model_name}]} / {models:[...]}"""
    if not isinstance(obj, dict):
        return []
    items = obj.get("data") or obj.get("models") or obj.get("model_list") or []
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if isinstance(it, str):
            out.append(it)
        elif isinstance(it, dict):
            # 不同厂商字段名不同
            for k in ("id", "name", "model_name", "model"):
                v = it.get(k)
                if isinstance(v, str) and v:
                    out.append(v)
                    break
    return out


def build_request(cfg: dict, prompt: str):
    fmt = (cfg.get("api_format") or "openai").lower()
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "throughput-tester/1.0",
    }
    key = cfg.get("api_key") or ""
    if fmt == "anthropic":
        if key:
            headers["x-api-key"] = key
        headers["anthropic-version"] = cfg.get("anthropic_version") or "2023-06-01"
        body = {
            "model": cfg["model"],
            "max_tokens": int(cfg.get("max_tokens") or 512),
            "stream": True,
            "messages": [{"role": "user", "content": prompt}],
        }
    else:
        if key:
            headers["Authorization"] = "Bearer " + key
        body = {
            "model": cfg["model"],
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "max_tokens": int(cfg.get("max_tokens") or 512),
        }
        if cfg.get("include_usage", True):
            body["stream_options"] = {"include_usage": True}
    if cfg.get("temperature") is not None:
        body["temperature"] = cfg["temperature"]
    # 思考模式参数（各家写法不同，由 thinking.py 按服务商翻译）
    apply_thinking(body, cfg)
    extra = cfg.get("extra_body")
    if extra:
        try:
            parsed = json.loads(extra) if isinstance(extra, str) else extra
            if isinstance(parsed, dict):
                body.update(parsed)
        except Exception as e:
            print(f"[body] extra_body 解析失败，已忽略：{e}", file=sys.stderr)
    return body, headers


# ---------------------------------------------------------------- 单请求执行

def run_request(cfg: dict, upstream: Upstream, prompt: str, seq: int) -> dict:
    body, headers = build_request(cfg, prompt)
    t_origin = upstream.t0_origin
    # 请求发起时刻。必须在这里取，post() 内部的 t0 是 socket 时刻，
    # 而 t0_origin 是整轮压测的统一起点，两者之差才是时间轴位置。
    t_start = time.perf_counter()
    rec = {
        "seq": seq,
        "ok": False,
        "status": None,
        "error": None,
        "ttft_ms": None,
        "total_ms": None,
        "gen_ms": None,
        "output_tokens": 0,
        "prompt_tokens": 0,
        "token_source": "estimated",
        "decode_tps": 0.0,
        "e2e_tps": 0.0,
        "tpot_ms": None,
        "chunks": 0,
        "chars": 0,
        "reasoning_tokens": 0,
        "reasoning_chunks": 0,
        "answer_ttft_ms": None,
        "start_rel_ms": 0.0,
        "first_rel_ms": None,
        "end_rel_ms": 0.0,
    }
    try:
        try:
            res = upstream.post(body, headers)
        except UpstreamError as e:
            # 部分网关不支持 stream_options，去掉后重试一次
            if "stream_options" in str(e) and "stream_options" in body:
                body.pop("stream_options", None)
                res = upstream.post(body, headers)
            else:
                raise
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["start_rel_ms"] = (t_start - t_origin) * 1000
        rec["end_rel_ms"] = (time.perf_counter() - t_origin) * 1000
        return rec

    text = res["text"]
    reasoning_text = res.get("reasoning") or ""
    usage = res["usage"] or {}
    comp = usage.get("completion_tokens")
    if comp is None:
        comp = usage.get("output_tokens")
    prm = usage.get("prompt_tokens")
    if prm is None:
        prm = usage.get("input_tokens")
    # 思考 token：优先取上游的 completion_tokens_details.reasoning_tokens
    detail = usage.get("completion_tokens_details")
    if not isinstance(detail, dict):
        detail = usage.get("output_tokens_details")
    reason_tok = None
    if isinstance(detail, dict):
        for k in ("reasoning_tokens", "thoughts_token_count", "reasoning_token_count"):
            v = detail.get(k)
            if isinstance(v, int):
                reason_tok = v
                break

    # token 计数口径：
    #   1) 上游给了 usage 且我们请求了 usage → 用上游的精确值（completion_tokens）
    #   2) 否则 → 本地估算（tiktoken 优先，没有则启发式）
    # 只看"上游有没有返回 usage"是不够的：用户主动关掉「请求 usage」时，
    # 期望的是估算口径，若仍采信上游返回值会与设置不符。
    # 注意：上游的 completion_tokens 已包含思考 token，估算时也必须把思考文本算进去。
    want_usage = bool(cfg.get("include_usage", True))
    est = count_tokens(text) + count_tokens(reasoning_text)
    if want_usage and comp:
        final_tokens = int(comp)
        rec["token_source"] = "usage"
    else:
        final_tokens = est
        rec["token_source"] = "estimated"
    if reason_tok is None:
        reason_tok = count_tokens(reasoning_text)

    total = res["total"]
    ttft = res["ttft"]
    gen = max(0.0, total - ttft)

    rec["ok"] = True
    rec["status"] = 200
    rec["ttft_ms"] = ttft * 1000
    rec["total_ms"] = total * 1000
    rec["gen_ms"] = gen * 1000
    rec["output_tokens"] = final_tokens
    # prompt token 同理：没请求 usage 就用本地估算
    rec["prompt_tokens"] = int(prm) if (want_usage and prm) else count_tokens(cfg.get("prompt") or "")
    rec["chars"] = len(text)
    rec["chunks"] = len(res["chunks"])
    rec["reasoning_tokens"] = int(reason_tok or 0)
    rec["reasoning_chunks"] = res.get("reasoning_chunks", 0)
    # 答案首字延迟：思考模式下 TTFT 是"首个输出 token"，
    # 用户真正看到字要等到答案开始，这两者差别很大，分开报。
    at = res.get("answer_ttft")
    rec["answer_ttft_ms"] = (at * 1000) if at is not None else None
    rec["decode_tps"] = (final_tokens / gen) if gen > 1e-6 else 0.0
    rec["e2e_tps"] = (final_tokens / total) if total > 1e-6 else 0.0
    if final_tokens > 1:
        rec["tpot_ms"] = gen * 1000 / (final_tokens - 1)
    rec["start_rel_ms"] = (t_start - t_origin) * 1000
    rec["first_rel_ms"] = rec["start_rel_ms"] + ttft * 1000
    rec["end_rel_ms"] = rec["start_rel_ms"] + total * 1000

    # 逐 chunk 的 token 权重曲线：先用估算，随后按 usage 总量做比例缩放
    weights = []
    est_sum = 0
    for t_rel, delta in res["chunks"]:
        n = count_tokens(delta)
        est_sum += n
        weights.append((t_rel, n))
    scale = (final_tokens / est_sum) if est_sum > 0 else 0.0
    rec["_series"] = [(t_rel, n * scale) for t_rel, n in weights]
    rec["_itl"] = [ (res["chunks"][i][0] - res["chunks"][i-1][0]) * 1000
                    for i in range(1, len(res["chunks"])) ]
    rec["_text"] = text
    rec["_reasoning"] = reasoning_text
    return rec


# ---------------------------------------------------------------- 统计工具

def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def avg(values):
    return (sum(values) / len(values)) if values else None


def r2(x, n=1):
    return None if x is None else round(x, n)


# ---------------------------------------------------------------- 压测主流程

def run_bench(cfg: dict, emit) -> dict:
    total_requests = max(1, int(cfg.get("requests") or 1))
    concurrency = max(1, int(cfg.get("concurrency") or 1))
    concurrency = min(concurrency, total_requests)
    warmup = max(0, int(cfg.get("warmup") or 0))
    prompt_tpl = cfg.get("prompt") or "hi"

    t_origin = time.perf_counter()

    def make_prompt(i: int) -> str:
        p = prompt_tpl.replace("{i}", str(i)).replace("{n}", str(total_requests))
        return p

    # ---- 预热：把连接建立、TLS 握手、首 token 编译等一次性开销挪出统计
    if warmup:
        emit({"type": "phase", "phase": "warmup", "count": warmup})
        up = Upstream(cfg)
        up.t0_origin = t_origin
        for i in range(warmup):
            try:
                run_request(cfg, up, make_prompt(-i - 1), -i - 1)
            except Exception:
                pass
        up.close()

    # ---- 正式压测
    workers = concurrency
    per_worker = [total_requests // workers + (1 if i < total_requests % workers else 0)
                  for i in range(workers)]
    barrier = threading.Barrier(workers + 1)   # +1 是主线程，统一放行
    records: list[dict] = []
    lock = threading.Lock()
    seq_lock = threading.Lock()
    seq_counter = {"n": 0}
    errors: dict[str, int] = {}

    def worker(wid: int, n: int):
        up = Upstream(cfg)
        up.t0_origin = t_origin
        try:
            # keepalive 模式下先建连接再放行，避免首条请求多背一次握手
            if cfg.get("keepalive"):
                try:
                    up.connect()
                except Exception:
                    pass
            try:
                barrier.wait(timeout=60)
            except threading.BrokenBarrierError:
                return
            for _ in range(n):
                with seq_lock:
                    seq = seq_counter["n"]
                    seq_counter["n"] += 1
                rec = run_request(cfg, up, make_prompt(seq), seq)
                with lock:
                    records.append(rec)
                    if rec["error"]:
                        key = rec["error"][:120]
                        errors[key] = errors.get(key, 0) + 1
                emit({"type": "progress", "record": _slim(rec)})
        finally:
            up.close()

    emit({"type": "phase", "phase": "bench", "count": total_requests, "concurrency": workers})
    threads = [threading.Thread(target=worker, args=(i, per_worker[i]), daemon=True)
               for i in range(workers)]
    for t in threads:
        t.start()
    try:
        barrier.wait(timeout=60)   # 放行所有 worker
    except threading.BrokenBarrierError:
        pass
    for t in threads:
        t.join()

    return _aggregate(cfg, records, errors, t_origin)


def _slim(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if not k.startswith("_")}


def _aggregate(cfg: dict, records: list[dict], errors: dict, t_origin: float) -> dict:
    ok_recs = [r for r in records if r["ok"]]
    failed = len(records) - len(ok_recs)

    total_tokens = sum(r["output_tokens"] for r in ok_recs)
    total_prompt_tokens = sum(r["prompt_tokens"] for r in ok_recs)
    # 墙钟时长：从最早一个请求发起到最晚一个请求结束
    wall = (max((r["end_rel_ms"] for r in records), default=0.0)
            - min((r["start_rel_ms"] for r in records), default=0.0)) / 1000.0
    if wall <= 0:
        wall = 0.0
    sum_gen = sum((r["gen_ms"] or 0) for r in ok_recs) / 1000.0

    ttfts = [r["ttft_ms"] for r in ok_recs if r["ttft_ms"] is not None]
    tpots = [r["tpot_ms"] for r in ok_recs if r["tpot_ms"] is not None]
    decs = [r["decode_tps"] for r in ok_recs]
    e2es = [r["e2e_tps"] for r in ok_recs]

    src_usage = sum(1 for r in ok_recs if r["token_source"] == "usage")

    summary = {
        "requests": len(records),
        "ok": len(ok_recs),
        "failed": failed,
        "success_rate": r2((len(ok_recs) / len(records) * 100) if records else 0.0, 1),
        "total_output_tokens": total_tokens,
        "total_prompt_tokens": total_prompt_tokens,
        # 思考 token：包含在 total_output_tokens 里（上游 completion_tokens 已含），
        # 这里单列出来，方便看思考占了多大比例
        "total_reasoning_tokens": sum(r.get("reasoning_tokens") or 0 for r in ok_recs),
        "requests_with_reasoning": sum(1 for r in ok_recs if (r.get("reasoning_tokens") or 0) > 0),
        "avg_answer_ttft_ms": r2(avg([r["answer_ttft_ms"] for r in ok_recs
                                       if r.get("answer_ttft_ms") is not None]), 1),
        "wall_time_ms": r2(wall * 1000, 1),
        # 聚合吞吐 = 总输出 token / 墙钟时长（系统整体吐字速率）
        "aggregate_tps": r2(total_tokens / wall if wall > 0 else 0.0, 2),
        # 并发解码吞吐 = 总输出 token / 各请求生成段之和（并发流量的平均速率）
        "aggregate_decode_tps": r2(total_tokens / sum_gen if sum_gen > 0 else 0.0, 2),
        "avg_ttft_ms": r2(avg(ttfts), 1),
        "p50_ttft_ms": r2(pct(ttfts, 50), 1),
        "p90_ttft_ms": r2(pct(ttfts, 90), 1),
        "p95_ttft_ms": r2(pct(ttfts, 95), 1),
        "p99_ttft_ms": r2(pct(ttfts, 99), 1),
        "min_ttft_ms": r2(min(ttfts) if ttfts else None, 1),
        "max_ttft_ms": r2(max(ttfts) if ttfts else None, 1),
        "avg_tpot_ms": r2(avg(tpots), 2),
        "p50_tpot_ms": r2(pct(tpots, 50), 2),
        "p90_tpot_ms": r2(pct(tpots, 90), 2),
        "p95_tpot_ms": r2(pct(tpots, 95), 2),
        "p99_tpot_ms": r2(pct(tpots, 99), 2),
        "avg_decode_tps": r2(avg(decs), 2),
        "p50_decode_tps": r2(pct(decs, 50), 2),
        "min_decode_tps": r2(min(decs) if decs else None, 2),
        "max_decode_tps": r2(max(decs) if decs else None, 2),
        "avg_e2e_tps": r2(avg(e2es), 2),
        "tokens_from_usage": src_usage,
        "tokens_from_estimate": len(ok_recs) - src_usage,
        "error_summary": errors,
    }

    # ---- 吞吐曲线：按固定时间桶累计输出 token
    bucket_ms = max(20, int(cfg.get("bucket_ms") or 100))
    timeline = _build_timeline(ok_recs, t_origin, bucket_ms)

    # ---- ITL 分位曲线：同一 token 序号上跨请求取分位
    itl_curve = _build_itl_curve(ok_recs)

    # ---- 逐请求 ITL 采样（最多 12 条，画抖动用）
    per_req_itl = []
    for r in ok_recs[:12]:
        itl = r.get("_itl") or []
        if itl:
            per_req_itl.append({"seq": r["seq"], "itl_ms": [round(x, 2) for x in itl[:400]]})

    out_records = []
    for r in sorted(records, key=lambda x: x["seq"]):
        d = _slim(r)
        d["itl_ms"] = [round(x, 2) for x in (r.get("_itl") or [])[:400]]
        d["text_head"] = (r.get("_text") or "")[:200]
        out_records.append(d)

    return {
        "summary": summary,
        "records": out_records,
        "timeline": timeline,
        "itl_curve": itl_curve,
        "per_request_itl": per_req_itl,
        "config": {k: cfg.get(k) for k in
                   ("base_url", "model", "api_format", "path", "requests", "concurrency",
                    "max_tokens", "keepalive", "warmup")},
        "thinking": {
            "provider": cfg.get("thinking_provider") or "",
            "enabled": cfg.get("thinking_enabled"),
            "level": cfg.get("thinking_level") or "",
            "budget": cfg.get("thinking_budget") or 0,
            "note": thinking_note(cfg),
        },
    }


def _build_timeline(ok_recs, t_origin, bucket_ms):
    if not ok_recs:
        return {"bucket_ms": bucket_ms, "points": []}
    # 归零：以最早一个请求的发起时刻为 t=0，曲线横轴就是相对时间
    start = min(r["start_rel_ms"] for r in ok_recs)
    end = max(r["end_rel_ms"] for r in ok_recs)
    nb = max(1, int((end - start) / bucket_ms) + 1)
    buckets = [0.0] * nb
    for r in ok_recs:
        series = r.get("_series") or []
        for t_rel, n in series:
            # t_rel 是相对该请求 socket 起点的秒数，换算到全局时间轴
            abs_ms = r["start_rel_ms"] + t_rel * 1000
            idx = int((abs_ms - start) / bucket_ms)
            if 0 <= idx < nb:
                buckets[idx] += n
    points = []
    cum = 0.0
    for i, v in enumerate(buckets):
        cum += v
        points.append({
            "t_ms": round(i * bucket_ms, 1),
            "cum_tokens": round(cum, 2),
            "inst_tokens": round(v, 2),
            "inst_tps": round(v / (bucket_ms / 1000.0), 2),
        })
    # 抽稀：最多 800 个点，前端画图足够
    if len(points) > 800:
        step = len(points) / 800.0
        points = [points[int(i * step)] for i in range(800)]
    return {"bucket_ms": bucket_ms, "points": points}


def _build_itl_curve(ok_recs, max_idx=200):
    series: list[list[float]] = []
    for r in ok_recs:
        itl = r.get("_itl") or []
        if itl:
            series.append(itl[:max_idx])
    if not series:
        return {"p10": [], "p50": [], "p90": [], "idx": []}
    n = min(len(s) for s in series)
    p10, p50, p90 = [], [], []
    idx = []
    for i in range(n):
        col = [s[i] for s in series if len(s) > i]
        if not col:
            continue
        p10.append(r2(pct(col, 10), 2))
        p50.append(r2(pct(col, 50), 2))
        p90.append(r2(pct(col, 90), 2))
        idx.append(i)
    return {"p10": p10, "p50": p50, "p90": p90, "idx": idx}


# ---------------------------------------------------------------- HTTP 服务

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "throughput-tester/1.0"

    # -- 工具 -----------------------------------------------------------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _json_body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            obj = json.loads(raw.decode("utf-8"))
            return obj if isinstance(obj, dict) else {}
        except Exception as e:
            raise ValueError(f"JSON 解析失败: {e}")

    def _send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data: bytes, ctype: str, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def _sse(self, obj):
        payload = ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")
        self.wfile.write(payload)
        self.wfile.flush()

    def _serve_static(self, rel: str):
        # rel 是 URL 路径。去掉 /static/ 前缀后，相对 static 目录解析。
        rel = rel.lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/"):]
        rel = rel or "index.html"
        static_root = os.path.abspath(STATIC_DIR)
        full = os.path.abspath(os.path.join(static_root, rel))
        # 目录穿越防护：解析后的绝对路径必须仍在 static 根内
        if not (full == static_root or full.startswith(static_root + os.sep)):
            self._send_bytes(b"forbidden", "text/plain; charset=utf-8", 403)
            return
        if not os.path.isfile(full):
            self._send_bytes(b"not found", "text/plain; charset=utf-8", 404)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            self._send_bytes(f.read(), ctype)

    # -- 路由 -----------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self._send_json({"ok": True, "service": "throughput-tester", "time": time.time()})
        elif path == "/api/config":
            self._send_json(load_config())
        elif path == "/" or path.startswith("/static/"):
            self._serve_static(path if path != "/" else "/index.html")
        else:
            self._serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            cfg_in = self._json_body()
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, 400)
            return

        if path == "/api/config":
            merged = load_config()
            merged.update({k: v for k, v in cfg_in.items() if k in DEFAULT_CONFIG})
            self._send_json({"ok": True, "config": save_config(merged)})
            return

        if path == "/api/models":
            self._do_models(cfg_in)
            return

        if path == "/api/probe":
            self._do_probe(cfg_in)
            return

        if path == "/api/bench":
            self._do_bench(cfg_in)
            return

        self._send_json({"ok": False, "error": "unknown endpoint"}, 404)

    # -- 拉取上游模型列表 ------------------------------------------------
    def _do_models(self, cfg_in: dict):
        """代理 GET {base}/models。浏览器直接调会被 CORS 拦，走后端。

        模型列表路径由 chat completions 路径推导：
            /v1/chat/completions          -> /v1/models
            /openai/v1/chat/completions   -> /openai/v1/models
            /chat/completions             -> /models
            /v1/messages                  -> /v1/models
        """
        cfg = load_config()
        cfg.update({k: v for k, v in cfg_in.items() if k in DEFAULT_CONFIG})
        try:
            up = Upstream(cfg)
            models_path = _models_path_from_chat(cfg.get("path") or "", cfg.get("api_format"))
            headers = {"Accept": "application/json", "User-Agent": "throughput-tester/1.0"}
            key = cfg.get("api_key") or ""
            if (cfg.get("api_format") or "openai").lower() == "anthropic":
                if key:
                    headers["x-api-key"] = key
                headers["anthropic-version"] = cfg.get("anthropic_version") or "2023-06-01"
            else:
                if key:
                    headers["Authorization"] = "Bearer " + key
            up.connect().request("GET", up.base_path + models_path, headers=headers)
            resp = up.conn.getresponse()
            raw = resp.read(2 * 1024 * 1024).decode("utf-8", "replace")
            up.close()
            if resp.status != 200:
                self._send_json({
                    "ok": False,
                    "error": f"HTTP {resp.status} {resp.reason}: {raw[:300]}",
                }, 200)
                return
            try:
                obj = json.loads(raw)
            except Exception:
                obj = {}
            ids = _extract_model_ids(obj)
            self._send_json({"ok": True, "models": ids, "path": models_path})
        except Exception as e:
            self._send_json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 200)

    # -- 单次流式探测 ---------------------------------------------------
    def _do_probe(self, cfg_in: dict):
        cfg = load_config()
        cfg.update({k: v for k, v in cfg_in.items() if k in DEFAULT_CONFIG})
        self._sse_start()
        try:
            up = Upstream(cfg)
            up.t0_origin = time.perf_counter()
            body, headers = build_request(cfg, cfg.get("prompt") or "hi")
            t0 = time.perf_counter()
            try:
                res = up.post(body, headers)
            except UpstreamError as e:
                if "stream_options" in str(e) and "stream_options" in body:
                    body.pop("stream_options", None)
                    res = up.post(body, headers)
                else:
                    raise
            up.close()
            usage = res["usage"] or {}
            comp = usage.get("completion_tokens")
            if comp is None:
                comp = usage.get("output_tokens")
            est = count_tokens(res["text"])
            # 与压测主流程同口径：请求了 usage 才采信上游值
            want_usage = bool(cfg.get("include_usage", True))
            if want_usage and comp:
                total_tok = int(comp)
                src = "usage"
            else:
                total_tok = est
                src = "estimated"
            gen = max(0.0, res["total"] - res["ttft"])
            self._sse({
                "type": "probe_result",
                "text": res["text"],
                "ttft_ms": round(res["ttft"] * 1000, 1),
                "total_ms": round(res["total"] * 1000, 1),
                "gen_ms": round(gen * 1000, 1),
                "output_tokens": total_tok,
                "token_source": src,
                "chunks": len(res["chunks"]),
                "decode_tps": round(total_tok / gen, 2) if gen > 1e-6 else 0,
                "e2e_tps": round(total_tok / res["total"], 2) if res["total"] > 1e-6 else 0,
                "tpot_ms": round(gen * 1000 / (total_tok - 1), 2) if total_tok > 1 else None,
                "itl_ms": [round((res["chunks"][i][0] - res["chunks"][i-1][0]) * 1000, 2)
                           for i in range(1, len(res["chunks"]))][:400],
            })
        except Exception as e:
            self._sse({"type": "error", "error": f"{type(e).__name__}: {e}"})
        self._sse({"type": "done"})

    # -- 并发压测 -------------------------------------------------------
    def _do_bench(self, cfg_in: dict):
        cfg = load_config()
        cfg.update({k: v for k, v in cfg_in.items() if k in DEFAULT_CONFIG})
        q: "queue.Queue" = queue.Queue()

        def emit(ev):
            q.put(ev)

        def runner():
            try:
                emit({"type": "result", "data": run_bench(cfg, emit)})
            except Exception as e:
                emit({"type": "error", "error": f"{type(e).__name__}: {e}"})
            finally:
                q.put(None)

        th = threading.Thread(target=runner, daemon=True)
        th.start()
        self._sse_start()
        while True:
            ev = q.get()
            if ev is None:
                break
            self._sse(ev)
        self._sse({"type": "done"})


def main():
    global CONFIG_PATH

    ap = argparse.ArgumentParser(description="模型吞吐压测后端")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    ap.add_argument("--port", type=int, default=8770, help="监听端口，默认 8770")
    ap.add_argument("--config", default=CONFIG_PATH, help="配置文件路径")
    args = ap.parse_args()

    CONFIG_PATH = args.config

    if not os.path.isdir(STATIC_DIR):
        print(f"缺少静态目录：{STATIC_DIR}", file=sys.stderr)
        sys.exit(1)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"throughput-tester 已启动 → http://{args.host}:{args.port}")
    print(f"配置文件：{CONFIG_PATH}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        srv.shutdown()


if __name__ == "__main__":
    main()
