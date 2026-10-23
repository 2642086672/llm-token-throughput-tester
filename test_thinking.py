#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
思考参数映射单元测试 —— 验证各家 wire 格式是否与官方文档一致。

运行：python test_thinking.py
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from thinking import apply_thinking, thinking_note, SUPPORT

FAILED = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILED.append(f"{name}\n     实际: {got}\n     期望: {want}")
    mark = "OK  " if ok else "FAIL"
    print(f"  [{mark}] {name}")
    if not ok:
        print(f"         实际: {got}")
        print(f"         期望: {want}")


def base():
    return {"model": "m", "messages": [{"role": "user", "content": "hi"}],
            "stream": True, "max_tokens": 512}


print("=== OpenAI：reasoning.effort ===")
b = base()
apply_thinking(b, {"thinking_provider": "openai", "thinking_level": "high"})
check("openai/high → reasoning.effort", b.get("reasoning"), {"effort": "high"})

b = base()
apply_thinking(b, {"thinking_provider": "openai", "thinking_level": "xhigh"})
check("openai/xhigh", b.get("reasoning"), {"effort": "xhigh"})

b = base()
apply_thinking(b, {"thinking_provider": "openai", "thinking_enabled": False})
check("openai/关闭 → effort=none", b.get("reasoning"), {"effort": "none"})

b = base()
apply_thinking(b, {"thinking_provider": "openai"})
check("openai/未配置 → 不下发", "reasoning" in b, False)

print("\n=== Claude：thinking.type=adaptive + output_config.effort ===")
b = base()
apply_thinking(b, {"thinking_provider": "anthropic", "thinking_enabled": True, "thinking_level": "max"})
check("anthropic/开+max", (b.get("thinking"), b.get("output_config")),
      ({"type": "adaptive"}, {"effort": "max"}))

b = base()
apply_thinking(b, {"thinking_provider": "anthropic", "thinking_enabled": False})
check("anthropic/关", b.get("thinking"), {"type": "disabled"})

print("\n=== DeepSeek：thinking.type + reasoning_effort ===")
b = base()
apply_thinking(b, {"thinking_provider": "deepseek", "thinking_enabled": True, "thinking_level": "max"})
check("deepseek/开+max", (b.get("thinking"), b.get("reasoning_effort")),
      ({"type": "enabled"}, "max"))

b = base()
apply_thinking(b, {"thinking_provider": "deepseek", "thinking_enabled": False})
check("deepseek/关", b.get("thinking"), {"type": "disabled"})

print("\n=== GLM：thinking.type + reasoning_effort ===")
b = base()
apply_thinking(b, {"thinking_provider": "glm", "thinking_enabled": True, "thinking_level": "xhigh"})
check("glm/开+xhigh", (b.get("thinking"), b.get("reasoning_effort")),
      ({"type": "enabled"}, "xhigh"))

b = base()
apply_thinking(b, {"thinking_provider": "glm", "thinking_level": "none"})
check("glm/none", b.get("reasoning_effort"), "none")

print("\n=== Qwen：enable_thinking + reasoning_effort ===")
b = base()
apply_thinking(b, {"thinking_provider": "qwen", "thinking_enabled": True, "thinking_level": "xhigh"})
check("qwen/开+xhigh", (b.get("enable_thinking"), b.get("reasoning_effort")),
      (True, "xhigh"))

b = base()
apply_thinking(b, {"thinking_provider": "qwen", "thinking_enabled": True, "thinking_budget": 4096})
check("qwen/开+budget", (b.get("enable_thinking"), b.get("thinking_budget")),
      (True, 4096))

b = base()
apply_thinking(b, {"thinking_provider": "qwen", "thinking_enabled": False})
check("qwen/关", b.get("enable_thinking"), False)

print("\n=== Gemini：google.thinking_config ===")
b = base()
apply_thinking(b, {"thinking_provider": "gemini", "thinking_enabled": True, "thinking_level": "low"})
check("gemini/开+low", b.get("google"),
      {"thinking_config": {"thinking_level": "low", "include_thoughts": True}})

b = base()
apply_thinking(b, {"thinking_provider": "gemini", "thinking_level": "high"})
check("gemini/仅级别", b.get("google"),
      {"thinking_config": {"thinking_level": "high"}})

print("\n=== 小米 MiMo：只有开关 ===")
b = base()
apply_thinking(b, {"thinking_provider": "mimo", "thinking_enabled": True})
check("mimo/开", b.get("thinking"), {"type": "enabled"})

b = base()
apply_thinking(b, {"thinking_provider": "mimo", "thinking_enabled": True, "thinking_level": "high"})
check("mimo/带档位→只发开关", b.get("thinking"), {"type": "enabled"})

print("\n=== LongCat：thinking.type + thinking_budget ===")
b = base()
apply_thinking(b, {"thinking_provider": "longcat", "thinking_enabled": True, "thinking_budget": 8192})
check("longcat/开+budget", (b.get("thinking"), b.get("thinking_budget")),
      ({"type": "enabled"}, 8192))

print("\n=== 未知服务商：不动 body ===")
b = base()
apply_thinking(b, {"thinking_provider": "unknown", "thinking_enabled": True})
check("未知/原样", "thinking" in b, False)

print("\n=== 档位支持表 ===")
for k, v in SUPPORT.items():
    print(f"  {k:10s} → {v}")
check("mimo 无档位", SUPPORT["mimo"], [])
check("mimo 档位为空列表", len(SUPPORT["mimo"]), 0)

print("\n=== 说明文案 ===")
n = thinking_note({"thinking_provider": "anthropic", "thinking_enabled": True, "thinking_level": "high"})
check("anthropic 文案", n, "thinking.type = adaptive · output_config.effort = high")
n = thinking_note({"thinking_provider": "mimo", "thinking_enabled": True, "thinking_level": "high"})
check("mimo 文案提示忽略档位", "无强度档位" in n, True)

print()
if FAILED:
    print(f"=== 失败 {len(FAILED)} 项 ===")
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
print("=== 全部通过 ===")
