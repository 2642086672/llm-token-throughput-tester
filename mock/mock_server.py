#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mock 上游 —— 模拟一个 OpenAI 兼容的流式 LLM 接口，用来本地验证压测链路。

不依赖任何第三方库。行为：
  - /v1/chat/completions  支持 stream=true/false，返回 SSE
  - /v1/models           返回模型列表
  - 固定首 token 延迟 80ms，之后每 token 间隔 12ms（可在 URL 参数里调）

启动：
  python mock/mock_server.py --port 18899 --ttft 80 --itl 12 --tokens 120
"""

import argparse
import json
import random
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

WORDS = ("吞吐 压测 首字 延迟 并发 采样 统计 分位 聚合 流式 增量 token "
         "生成 速率 服务 端到端 抖动 稳定 基准 校验 精确 估算 采样桶").split()

STATE = {"ttft": 80.0, "itl": 12.0, "tokens": 120}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + fmt % args + "\n")

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._json({
                "object": "list",
                "data": [
                    {"id": "mock-fast", "object": "model", "owned_by": "mock"},
                    {"id": "mock-accurate", "object": "model", "owned_by": "mock"},
                ],
            })
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}

        if not self.path.startswith("/v1/chat/completions"):
            self._json({"error": "not found"}, 404)
            return

        stream = bool(body.get("stream"))
        if not stream:
            self._json({
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant",
                            "content": " ".join(random.choice(WORDS)
                                                for _ in range(STATE["tokens"]))},
                            "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 12,
                          "completion_tokens": STATE["tokens"],
                          "total_tokens": 12 + STATE["tokens"]},
            })
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        time.sleep(STATE["ttft"] / 1000.0)
        for i in range(STATE["tokens"]):
            chunk = random.choice(WORDS) + (" " if i < STATE["tokens"] - 1 else "")
            obj = {
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "model": body.get("model", "mock"),
                "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
            }
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
            time.sleep(STATE["itl"] / 1000.0)

        final = {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12,
                      "completion_tokens": STATE["tokens"],
                      "total_tokens": 12 + STATE["tokens"]},
        }
        self.wfile.write(("data: " + json.dumps(final, ensure_ascii=False) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18899)
    ap.add_argument("--ttft", type=float, default=80.0, help="首 token 延迟 ms")
    ap.add_argument("--itl", type=float, default=12.0, help="token 间隔 ms")
    ap.add_argument("--tokens", type=int, default=120, help="每次输出的 token 数")
    args = ap.parse_args()
    STATE.update({"ttft": args.ttft, "itl": args.itl, "tokens": args.tokens})
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"mock 上游已启动 → http://{args.host}:{args.port}/v1 "
          f"(ttft={args.ttft}ms itl={args.itl}ms tokens={args.tokens})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
