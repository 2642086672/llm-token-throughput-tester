# 压测模型的 token 吞吐力

压测大模型接口的**输出吞吐能力**。浏览器端出图，服务端做计时。

![界面预览](shot-light.png)

测的是**输出侧**吞吐——模型每秒能吐多少 token，以及在并发下这个数字怎么变。

## 特性

- **六项核心指标**：聚合吞吐、并发解码吞吐、TTFT、TPOT、输出 token、成功率
- **四张图表**：吞吐曲线（累计 token + 瞬时 tok/s）、TTFT 分布、ITL 分位曲线（p10/p50/p90）、TTFT/TPOT 分位对比
- **Token 口径透明**：每条请求都标明 token 是上游 `usage` 精确值还是本地估算；空 chunk 一律过滤，空帧不会污染 TTFT
- **并发梯度压测**：调并发数看吞吐何时饱和、TTFT 何时开始劣化
- **双协议**：OpenAI 兼容（vLLM / Ollama / LM Studio / 硅基流动 / DeepSeek…）+ Anthropic Messages
- **实时反馈**：每条请求完成即推送，不用等整轮结束
- **零第三方依赖**：Python 标准库即可运行，图表原生 Canvas 手绘，无 CDN
- **深浅双主题**，响应式，手机可用
- 结果导出 JSON / CSV

## 快速开始

```bash
git clone https://github.com/2642086672/llm-token-throughput-tester.git
cd llm-token-throughput-tester
python server.py --host 127.0.0.1 --port 8770
```

浏览器打开 <http://127.0.0.1:8770> ，填 Base URL、路径、模型名、API Key，点「开始压测」。

Python 3.8+，无第三方依赖。

### 不想用真实 Key？本地自测

开两个终端：

```bash
# 终端 1：mock 上游，模拟 ttft=80ms、每 token 间隔 12ms、共 120 token
python mock/mock_server.py --port 18899 --ttft 80 --itl 12 --tokens 120

# 终端 2：压测后端
python server.py --port 8770
```

页面上填 Base URL `http://127.0.0.1:18899`、路径 `/v1/chat/completions`、模型 `mock-fast`、Key 随意填，总请求数 `8`、并发 `4`。

**预期结果**：TTFT ≈ 83ms，解码速率 ≈ 77.5 tok/s（= 1000/12ms − 首字开销），成功率 100%。

## 为什么计时放服务端

浏览器 `fetch` 读 SSE 的时间戳受主线程渲染、GC、后台标签页节流影响，误差能到几十毫秒——而 TTFT 本身也就几十毫秒。放到服务端用 `time.perf_counter()` 逐 chunk 打点，精度是微秒级。顺带解决 CORS：直连 `api.openai.com` 会被浏览器拦掉。

## 目录结构

```
llm-token-throughput-tester/
├── server.py              压测后端：SSE 代理 + 计时 + 统计聚合 + 静态托管
├── config.json            默认配置（前端「保存配置」写入，原子替换）
├── static/
│   ├── index.html         前端页面
│   ├── style.css          样式（含深色主题）
│   └── app.js             前端逻辑：表单绑定、SSE 消费、Canvas 图表
├── mock/
│   ├── mock_server.py      模拟 OpenAI 兼容流式接口，本地自测用
│   ├── mock_edge_cases.py  发「脏 chunk」（空串/null/空对象/空格），验证过滤逻辑
│   └── mock_no_usage.py    只发内容不发 usage，验证本地估算路径
├── e2e_test.js            Playwright 端到端验收脚本（开发用，非运行必需）
└── README.md
```

> `e2e_test.js` 是开发期的端到端验收脚本，依赖 `playwright-core` 与本机 Edge/Chrome，**运行本工具本身不需要它**。

## 依赖

Python 3.8+，**零第三方依赖**，标准库即可。

可选：装 `tiktoken` 后 token 计数更准（`pip install tiktoken`）。没装时退化为启发式估算（CJK 1 字≈1 token，ASCII 4 字符≈1 token），结果里会标 `estimated`；上游给了 `usage` 就用精确值。

```bash
pip install tiktoken   # 可选
```

## 启动

```bash
cd llm-token-throughput-tester

# 压测后端
python server.py --host 127.0.0.1 --port 8770

# 浏览器打开
# http://127.0.0.1:8770
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址。局域网内别人访问用 `0.0.0.0` |
| `--port` | `8770` | 监听端口 |
| `--config` | `./config.json` | 配置文件路径 |

## 本地自测（不需要真实 API Key）

见上文「快速开始 → 不想用真实 Key？本地自测」。

## 指标口径

| 指标 | 公式 | 说明 |
|---|---|---|
| TTFT | 首 chunk 时间 − 请求发起时间 | 首 token 延迟 |
| TPOT | 生成段时长 ÷ (输出 token − 1) | 每 token 平均生成间隔 |
| ITL | 相邻 chunk 时间差 | 逐 token 间隔，比 TPOT 细，能看抖动 |
| 解码吞吐 | 输出 token ÷ 生成段时长 | 排除 TTFT 的纯生成速率 |
| 端到端吞吐 | 输出 token ÷ 总耗时 | 含首字延迟 |
| **聚合吞吐** | 总输出 token ÷ 墙钟时长 | **多并发下系统整体吐字速率，核心指标** |
| 并发解码吞吐 | 总输出 token ÷ 各请求生成段之和 | 并发流量的平均速率 |

单请求 TTFT 里是否含 TCP/TLS 握手，取决于「复用连接」开关：

- 关（默认）：每次新建连接，TTFT 含握手，贴近真实用户的首次调用体验
- 开：连接常驻，TTFT 只反映服务端排队 + 首字计算，反映服务本身的处理能力

## Token 计数口径

工具只有两种口径，每条请求明细都带 `token_source` 字段标明用了哪种：

| 口径 | 条件 | 来源 |
|---|---|---|
| `usage` | 勾了「请求 usage」**且**上游返回了 usage | 上游 `completion_tokens`，精确值 |
| `estimated` | 其余情况 | 本地计算（见下） |

本地估算优先级：装了 `tiktoken` 就用 `cl100k_base` 精确编码；没装则用启发式（CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token）。

**注意**：勾选「请求 usage」只影响"要不要向上游索要"这个动作。若上游忽略该参数返回了 usage，工具**仍会采信**上游值——因为上游给的数就是准的。反过来，取消勾选后工具会**改用本地估算**，即使上游仍返回了 usage 也不采信，这样口径与你的设置始终一致。

### 空 chunk 的处理

SSE 流里常见的空帧会被过滤，**不计入 token、不参与 ITL 统计、不影响 TTFT**：

| 上游发的帧 | 处理 |
|---|---|
| `{"delta":{"role":"assistant","content":""}}` | 丢弃（content 为空串） |
| `{"delta":{"content":null}}` | 丢弃（content 为 null） |
| `{"delta":{}}` | 丢弃（无 content 字段） |
| `{"choices":[],"usage":{...}}` | 只取 usage，不算 chunk |
| `data: [DONE]` | 结束标记 |
| `: ping` 注释行 | 丢弃 |
| `{"delta":{"content":" "}}` | **保留**（空格是真实字符，算 1 token） |

关键点：**空帧不会提前触发 TTFT**。TTFT 只在收到第一个非空 content 时打点，所以「先发 role 再发内容」这种两段式响应，测出来的 TTFT 是内容真正开始的时间，不是 role 帧的时间。

**空格帧保留是有意为之**——它是一枚真实的 token，把它算进去才能让 ITL 序列与上游实际吐字节奏对齐。如果全滤掉，ITL 会出现虚假的间隔跳变。

`chunks` 字段是**有效 chunk 数**（过滤后），ITL 长度 = chunks − 1。

## 协议支持

**OpenAI 兼容**（`/v1/chat/completions` 等）——主流网关都吃这套：

```bash
# vLLM
http://127.0.0.1:8000
# Ollama
http://127.0.0.1:11434
# LM Studio
http://127.0.0.1:1234
# 硅基流动
https://api.siliconflow.cn
# DeepSeek
https://api.deepseek.com
```

**Anthropic Messages**（`/v1/messages`）——协议下拉切换，路径自动改成 `/v1/messages`。

部分网关不支持 `stream_options`，后端遇到 400 会自动去掉重试一次。

## 配置说明

| 字段 | 含义 |
|---|---|
| Base URL | 根地址，不含接口路径 |
| 路径 | 完整接口路径，OpenAI 兼容一般 `/v1/chat/completions` |
| Prompt | 支持 `{i}`（请求序号）、`{n}`（总请求数）占位符 |
| max_tokens | 每次请求的输出上限，**直接决定压测时长** |
| 额外请求体 JSON | 追加字段，如 `{"top_p":0.9,"stop":["\n"]}` |
| 请求 usage | OpenAI 兼容下请求返回 token 统计，拿到就是精确值 |
| 校验 TLS 证书 | 自签名证书的本地服务要关掉 |
| 复用连接 | 见上文 TTFT 口径说明 |
| 预热 | 先跑 N 条不计入统计，把连接建立、TLS 握手、首次 JIT 等一次性开销挪出去 |
| 曲线采样桶 | 吞吐曲线的时间粒度，默认 100ms |

**API Key 默认不落盘**。只有勾了「记住 Key」才会写进 `config.json`（本机文件，注意 `config.json` 别进版本库）。

## 页面功能

- 6 张 KPI 卡：聚合吞吐、并发解码吞吐、TTFT 均值、TPOT 均值、输出 token、成功率
- 4 张图表：吞吐曲线（累计 token + 瞬时 tok/s）、TTFT 分布、ITL 分位曲线（p10/p50/p90）、TTFT/TPOT 分位对比
- 请求明细表：每条请求的完整计时
- 实时日志：逐条请求到达即打印
- 导出 JSON / CSV
- 单次探测：弹窗看原文 + 计时，不跑压测
- 深浅色主题，响应式（手机可用）

## 怎么读结果

**聚合吞吐**是主指标，它随并发数变化：

- 并发从 1 提到 N，聚合吞吐应大致线性上升
- 涨不动了 → 服务端已经饱和，瓶颈在推理算力或限流
- 反而下降 → 出现排队堆积或超时

**TTFT 分位差**（p95 − p50）反映抖动。差值大说明服务端在抢占或被其他负载干扰。

**ITL p90 远高于 p50** 说明输出不稳定，逐 token 间隔忽快忽慢。

**先看「口径」列**。明细表里每行都标了这条请求的 token 是 `usage`（上游精确值）还是 `估算`（本地算的）：

- 全是 `usage` → 数字可以直接横向对比，可信度最高
- 出现 `估算` → token 数是本地推算的，**绝对值有偏差，但同一批次内横向比较仍然有效**（偏差对所有请求是同向的）
- 全部 `估算` 且你关心绝对值 → 装 `tiktoken` 提高精度，或确认上游支持 `stream_options.include_usage`

估算口径下**吞吐的相对趋势依然可信**——比如"并发从 1 到 8 吞吐涨了 4 倍"这个结论不会因为 token 计数有 5% 的系统性偏差而改变。

## 常见问题

**压测结果全失败**
先点「单次探测」看具体错误。连接被拒 → 服务没起或地址错；404 → 路径不对；401 → Key 无效。

**TTFT 特别大**
检查是不是没开「复用连接」——每次新建连接会多出握手时间。想测服务本身能力就打开。

**token 数不准**
没勾「请求 usage」时是估算值，结果里标 `estimated`。装 `tiktoken` 能提升估算精度。

**压测很慢**
`max_tokens` 越大越慢。测吞吐用 128~512 够了，测长文本能力再调大。

**中途想停**
点「停止」，用 AbortController 掐断 SSE 连接。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端页面 |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 读当前配置 |
| POST | `/api/config` | 写配置（原子替换） |
| POST | `/api/probe` | 单次流式探测，SSE 返回 |
| POST | `/api/bench` | 并发压测，SSE 返回 |

压测的 SSE 事件类型：`phase`（阶段切换）、`progress`（单条请求完成）、`result`（最终聚合）、`error`、`done`。
