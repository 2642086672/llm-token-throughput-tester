#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
无 usage mock —— 只发内容，不发 usage 块，验证工具的本地估算路径。

启动：
  python mock/mock_no_usage.py --port 18902 --tokens 10 --itl 20
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

STATE = {"tokens": 10, "itl": 20.0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        for _ in range(STATE["tokens"]):
            obj = {"choices": [{"index": 0, "delta": {"content": "token"}}]}
            self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode("utf-8"))
            self.wfile.flush()
            time.sleep(STATE["itl"] / 1000.0)

        # 刻意不发 usage 块
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18902)
    ap.add_argument("--tokens", type=int, default=10)
    ap.add_argument("--itl", type=float, default=20.0)
    args = ap.parse_args()
    STATE.update({"tokens": args.tokens, "itl": args.itl})
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"无 usage mock 已启动 → http://{args.host}:{args.port}/v1/chat/completions")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
