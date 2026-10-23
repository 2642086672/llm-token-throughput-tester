#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
思考模式 mock —— 模拟会先吐思维链、再吐答案的流式接口。

行为（每次请求）：
  1. 先发 N 帧 reasoning_content（思维链），每帧间隔 --think-itl
  2. 再发 M 帧 content（答案），每帧间隔 --itl
  3. usage 里带 completion_tokens_details.reasoning_tokens

用途：验证思考模式下的 token 计数、TTFT 与答案首字延迟的区分。

启动：
  python mock/mock_thinking.py --port 18903 --think-chunks 8 --answer-chunks 5
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

STATE = {"think_chunks": 8, "answer_chunks": 5, "think_itl": 15.0, "itl": 20.0,
         "reasoning_tokens": 40}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}

        if not self.path.startswith("/v1/chat/completions"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # 读出思考配置，便于测试时确认参数确实传到了
        thinking = body.get("thinking")
        enable_thinking = body.get("enable_thinking")
        level = body.get("reasoning_effort")
        effort = (body.get("output_config") or {}).get("effort")
        gcfg = ((body.get("google") or {}).get("thinking_config") or {})
        print(f"[mock] thinking={thinking} enable_thinking={enable_thinking} "
              f"reasoning_effort={level} output_config.effort={effort} "
              f"google={gcfg}", file=sys.stderr)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def emit(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        # 1) 思维链
        for i in range(STATE["think_chunks"]):
            emit({"choices": [{"index": 0, "delta": {"reasoning_content": "思考中" if i == 0 else "…"}}]})
            time.sleep(STATE["think_itl"] / 1000.0)

        # 2) 答案
        for i in range(STATE["answer_chunks"]):
            emit({"choices": [{"index": 0, "delta": {"content": "答案" if i == 0 else "内容"}}]})
            time.sleep(STATE["itl"] / 1000.0)

        # 3) usage
        total_out = STATE["answer_chunks"] + STATE["reasoning_tokens"]
        emit({
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": total_out,
                "total_tokens": 10 + total_out,
                "completion_tokens_details": {"reasoning_tokens": STATE["reasoning_tokens"]},
            },
        })
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18903)
    ap.add_argument("--think-chunks", type=int, default=8)
    ap.add_argument("--answer-chunks", type=int, default=5)
    ap.add_argument("--think-itl", type=float, default=15.0)
    ap.add_argument("--itl", type=float, default=20.0)
    ap.add_argument("--reasoning-tokens", type=int, default=40)
    args = ap.parse_args()
    STATE.update({"think_chunks": args.think_chunks, "answer_chunks": args.answer_chunks,
                  "think_itl": args.think_itl, "itl": args.itl,
                  "reasoning_tokens": args.reasoning_tokens})
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"思考模式 mock 已启动 → http://{args.host}:{args.port}/v1/chat/completions")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
