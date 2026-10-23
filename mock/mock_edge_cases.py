#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
边界场景 mock —— 专门发"脏 chunk"，用来验证压测工具的 token 计数口径。

场景（每次请求按顺序发）：
  1. role-only chunk    : {"delta":{"role":"assistant","content":""}}   → content 为空串
  2. content=null      : {"delta":{"content":null}}                    → content 为 None
  3. 空 delta          : {"delta":{}}                                  → 没有 content 字段
  4. 纯空格 delta      : {"delta":{"content":" "}}                      → 只有一个空格
  5. SSE 注释心跳      : : ping
  6. 正常内容 x N      : {"delta":{"content":"token"}}
  7. usage 块          : {"choices":[],"usage":{...}}                  → 只有 usage 没有 content
  8. [DONE]

用途：验证 count_tokens 是否把空 chunk 计入、TTFT 是否被 role chunk 提前触发、
      usage 精确值与估算值是否一致。
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

STATE = {"real_tokens": 10, "itl": 20.0, "usage_completion": 10}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if not self.path.startswith("/v1/chat/completions"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def emit(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        def raw(s):
            self.wfile.write((s + "\n\n").encode("utf-8"))
            self.wfile.flush()

        # 1) role-only，content 为空串
        emit({"choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}]})
        # 2) content 显式为 null
        emit({"choices": [{"index": 0, "delta": {"content": None}}]})
        # 3) 空 delta 对象
        emit({"choices": [{"index": 0, "delta": {}}]})
        # 4) 纯空格 —— 这是一个真实字符，但不是空
        emit({"choices": [{"index": 0, "delta": {"content": " "}}]})
        # 5) SSE 注释心跳
        raw(": ping")
        time.sleep(STATE["itl"] / 1000.0)

        # 6) 正常内容
        for i in range(STATE["real_tokens"]):
            emit({"choices": [{"index": 0, "delta": {"content": "token"}}]})
            time.sleep(STATE["itl"] / 1000.0)

        # 7) usage 块，无 content
        emit({
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 7, "completion_tokens": STATE["usage_completion"],
                      "total_tokens": 7 + STATE["usage_completion"]},
        })
        # 8) DONE
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18900)
    ap.add_argument("--real-tokens", type=int, default=10)
    ap.add_argument("--itl", type=float, default=20.0)
    ap.add_argument("--usage-completion", type=int, default=10,
                    help="usage 里报的 completion_tokens，设成不同值可测缩放逻辑")
    args = ap.parse_args()
    STATE.update({"real_tokens": args.real_tokens, "itl": args.itl,
                  "usage_completion": args.usage_completion})
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"边界 mock 已启动 → http://{args.host}:{args.port}/v1/chat/completions")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
