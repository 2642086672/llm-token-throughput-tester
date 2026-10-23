#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
思考模式参数映射 —— 各家 API 的思考开关与强度参数写法完全不同，
这里统一成两个抽象概念，再翻译成各家 wire 格式。

抽象：
  thinking_enabled : bool | None   None = 不下发任何参数（用模型默认）
  thinking_level   : str | None    见 THINKING_LEVELS

各家实际参数（均已核对官方文档，2026-10）：
  OpenAI   : reasoning.effort = none|minimal|low|medium|high|xhigh
             无独立开关 —— none 即关闭思考
  Claude   : thinking = {type: adaptive}
             output_config.effort = low|medium|high|xhigh|max
  DeepSeek : thinking = {type: enabled|disabled}
             reasoning_effort = low|high|max
  GLM      : thinking = {type: enabled|disabled}
             reasoning_effort = none|minimal|low|medium|high|xhigh|max (GLM-5.2+)
  Qwen     : enable_thinking = true|false
             reasoning_effort = low|medium|xhigh  或  thinking_budget = int
  Gemini   : google.thinking_config.thinking_level = minimal|low|medium|high
             include_thoughts = true
  小米 MiMo : thinking = {type: enabled|disabled}   —— 只有开关，无强度档位
  LongCat  : thinking = {type: enabled|disabled}
             thinking_budget = int (token 数，最大 262144)
"""

from __future__ import annotations

# 统一强度档位 → 各家可接受的值
# 值为 None 表示该家不支持这一档
LEVELS = {
    "none":    "none",
    "minimal": "minimal",
    "low":     "low",
    "medium":  "medium",
    "high":    "high",
    "xhigh":   "xhigh",
    "max":     "max",
}

# 各家支持的档位集合（用于前端置灰提示）
SUPPORT = {
    "openai":    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "anthropic": ["low", "medium", "high", "xhigh", "max"],
    "deepseek":  ["low", "high", "max"],
    "glm":       ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    "qwen":      ["low", "medium", "xhigh"],
    "gemini":    ["minimal", "low", "medium", "high"],
    "mimo":      [],          # 只有开关
    "longcat":   [],          # 只有开关 + token 预算
}

# 思考级别写在哪一层：顶层 / body 顶层 / extra_body
# 绝大多数 OpenAI 兼容网关都接受顶层字段（不是包在 extra_body 里），
# 所以统一放顶层，只有 Gemini 需要包一层 google.thinking_config。


def _norm(level):
    if not level:
        return None
    return str(level).strip().lower()


def apply_thinking(body: dict, cfg: dict) -> dict:
    """按服务商把思考开关与级别写进请求体。原地修改并返回 body。"""
    provider = (cfg.get("thinking_provider") or "").strip().lower()
    enabled = cfg.get("thinking_enabled")
    level = _norm(cfg.get("thinking_level"))
    if enabled is None and level is None:
        return body          # 用户没配 → 完全不下发，用模型默认

    if provider == "openai":
        # 无独立开关：none 即关闭
        if level:
            body["reasoning"] = {"effort": level}
        elif enabled is False:
            body["reasoning"] = {"effort": "none"}
        return body

    if provider == "anthropic":
        if enabled is not None:
            # adaptive 是当前推荐模式；关闭时用 disabled
            body["thinking"] = {"type": "adaptive"} if enabled else {"type": "disabled"}
        if level:
            body["output_config"] = {"effort": level}
        return body

    if provider == "deepseek":
        if enabled is not None:
            body["thinking"] = {"type": "enabled" if enabled else "disabled"}
        if level:
            body["reasoning_effort"] = level
        return body

    if provider == "glm":
        if enabled is not None:
            body["thinking"] = {"type": "enabled" if enabled else "disabled"}
        if level:
            body["reasoning_effort"] = level
        return body

    if provider == "qwen":
        if enabled is not None:
            body["enable_thinking"] = bool(enabled)
        # qwen3.8 系列不支持 reasoning_effort 与 thinking_budget 同时设置
        budget = cfg.get("thinking_budget")
        if level:
            body["reasoning_effort"] = level
        elif budget:
            body["thinking_budget"] = int(budget)
        return body

    if provider == "gemini":
        cfg_thinking = {}
        if level:
            cfg_thinking["thinking_level"] = level
        if enabled is not None:
            cfg_thinking["include_thoughts"] = bool(enabled)
        if cfg_thinking:
            body["google"] = {"thinking_config": cfg_thinking}
        return body

    if provider == "mimo":
        # 只有开关，没有强度档位
        if enabled is not None:
            body["thinking"] = {"type": "enabled" if enabled else "disabled"}
        return body

    if provider == "longcat":
        if enabled is not None:
            body["thinking"] = {"type": "enabled" if enabled else "disabled"}
        budget = cfg.get("thinking_budget")
        if budget:
            body["thinking_budget"] = int(budget)
        return body

    return body


def thinking_note(cfg: dict) -> str:
    """生成一句人类可读的说明，贴在页面上让人知道实际发出去什么。"""
    provider = (cfg.get("thinking_provider") or "").strip().lower()
    enabled = cfg.get("thinking_enabled")
    level = _norm(cfg.get("thinking_level"))
    budget = cfg.get("thinking_budget")
    bits = []
    if provider == "openai":
        if level:
            bits.append(f"reasoning.effort = {level}")
        elif enabled is False:
            bits.append("reasoning.effort = none")
        else:
            bits.append("使用模型默认")
    elif provider == "anthropic":
        if enabled is not None:
            bits.append("thinking.type = " + ("adaptive" if enabled else "disabled"))
        if level:
            bits.append(f"output_config.effort = {level}")
    elif provider in ("deepseek", "glm"):
        if enabled is not None:
            bits.append("thinking.type = " + ("enabled" if enabled else "disabled"))
        if level:
            bits.append(f"reasoning_effort = {level}")
    elif provider == "qwen":
        if enabled is not None:
            bits.append("enable_thinking = " + str(bool(enabled)).lower())
        if level:
            bits.append(f"reasoning_effort = {level}")
        elif budget:
            bits.append(f"thinking_budget = {budget}")
    elif provider == "gemini":
        if level:
            bits.append(f"google.thinking_config.thinking_level = {level}")
        if enabled is not None:
            bits.append(f"include_thoughts = {str(bool(enabled)).lower()}")
    elif provider in ("mimo", "longcat"):
        if enabled is not None:
            bits.append("thinking.type = " + ("enabled" if enabled else "disabled"))
        if provider == "longcat" and budget:
            bits.append(f"thinking_budget = {budget}")
        if provider == "mimo" and level:
            bits.append("（该模型无强度档位，档位已忽略）")
    else:
        bits.append("未配置")
    return " · ".join(bits) if bits else "未配置"
