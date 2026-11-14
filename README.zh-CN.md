# deepseek-acp

[English](README.md) | **简体中文**

[![npm 版本](https://img.shields.io/npm/v/deepseek-acp)](https://www.npmjs.com/package/deepseek-acp)
[![npm 月下载量](https://img.shields.io/npm/dm/deepseek-acp)](https://www.npmjs.com/package/deepseek-acp)
[![CI 状态](https://github.com/xintaofei/deepseek-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/xintaofei/deepseek-acp/actions/workflows/ci.yml)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接成一个**面向编辑器的完整编码 Agent**，
通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与客户端通话。

**可用客户端**：任何实现 ACP 的编辑器。开发期在 **[codeg](https://github.com/xintaofei/codeg)** 里实测；
**[Zed](https://zed.dev)** 走同一套协议、配置方式见下，但尚未逐项验收过。

---

## DSH 0.2 兼容范围

本分支将全部 DSH 包精确锁定到 **0.2.2-rc.3**，要求 **Node ≥ 22.19.0**。
上游 DSH 自 0.2.1-alpha.4 起要求 Node 24.9，那条下限来自本适配器不加载的部分（OAR 子代理库与
CLI 脚本）。本项目的 CI 仍在 Node 22 上跑全量用例，哪次 DSH 升级弄坏了 Node 22，会先在这里变红。
仍由 ACP 适配器在进程内组装 DSH，并未改为启动官方桌面运行时。
新会话写入原生 v4 日志；上游持久化后端可恢复其迁移策略支持的 v3 日志，
生成 v4 后继文件并保留原始 v3 字节。旧内核不能读取生成的 v4 日志。

原有编辑器功能仍在范围内：流式输出、工具卡片、审批、提问、会话恢复与分叉、
模型选择、MCP 和 provider 配置。ACP provider 配置写在
`$DSH_HOME/deepseek-acp/settings.yaml`（密钥进凭据存储），不修改原生 DSH profile。
原来的 `$DSH_HOME/settings.yaml` 不再写入：上游 DSH 0.2 启动时会把它改名成
`settings.yaml.imported`。0.9.0 配好的路由会从这两个文件之一只读导入，直到第一次修改。
官方 API Key 路由由部署配置管理，在 ACP provider 编辑器内只读。

升级后的第一次 `session/list` 要把每条 v3 旧日志读一遍，而在 DSH 0.2 上每读一条都要
扫一遍整个会话根。列表在约两秒内先应答，来不及读的会话这一次没有标题；剩下的在后台
读完，存进会话根旁边的索引，之后的列表标题齐全，没变过的日志也不再重读。

**内核升级不等于接入官方全部能力。** 本次没有新增原生后台任务、子 agent 委派、
官方账号登录与搜索、桌面扩展组合。表单提问也取决于客户端能力：授权按钮降级
支持选项题，不能收集自由文本。此次升级保留项目现有的组合边界。

---

## 为什么存在

DeepSeek Harness 自带一个 ACP server（`@deepseek-ai/dsh-acp`），但它的定位是
**automation-only**——给程序用的，不是给人用的。上游自己的说明写得很直白：

> This package is a transport adapter, not a UI integration or a capability seam.
> It does not expose editor navigation, transcript replay, commands, modes,
> configuration pickers, elicitation, reasoning, plans, titles, or tool presentation.

它的主要客户端是 `dsh-subagent-acp`——一个父 harness 派生子 agent 的通道。对这个用途，
它的设计是对的：只发**已提交**的助手消息，不漏未提交的中间态，拿到的是干净的自动化结果。

但同一套设计放进编辑器就不成立了：

- **看不到模型在干什么。** 工具调用、命令输出、文件改动全部只留在会话日志里，界面上
  只有最后一段文字。模型改了你的文件，你得自己去 `git diff` 才知道。
- **没有逐字流式。** 只在整段消息提交后才推一次，长回答期间界面是静止的。
- **一次性会话。** 关掉就没了——没有恢复、没有列表、没有标题。
- **控制面全无。** 换模型、调文件权限、开计划模式、执行 slash 命令，都没有入口。
- **拒绝 MCP。** `mcpServers` 只要非空就直接报错。

官方其实实现过一版完整的编辑器向 bridge，又在 2026-07-24 主动删掉了——理由是产品定位，
不是技术不可行。**本项目填的就是这块被让出的生态位**：同一个 harness 内核，换一张
为人准备的协议面。

---

## 与内置 ACP 的能力对比

| | `@deepseek-ai/dsh-acp`（内置） | **deepseek-acp**（本项目） |
|---|---|---|
| 定位 | automation-only 传输适配器 | 面向编辑器的完整 Agent |
| 回复流式 | 仅整段提交后推送 | 逐 token |
| 思考过程 | ✗ 留在日志里 | ✅ `agent_thought_chunk` |
| 工具调用 | ✗ 不呈现 | ✅ 卡片 + 状态流转 |
| 文件 diff | ✗ | ✅ 编辑器原生 diff 视图 |
| 终端输出 | ✗ | ✅ 终端卡片（Zed `_meta` 约定） |
| 待办计划 | ✗ | ✅ `plan` + 计划模式 |
| 会话恢复 / 列表 | ✗ 关掉即消失 | ✅ `load` / `list` / `resume` / `close`，带标题 |
| 会话分叉 | ✗ | ✅ `session/fork`，父子各写各的日志；客户端指名时从那条消息分叉 |
| 会话内换模型 | ✗ | ✅ 模型、推理档位、文件权限三个选择器 |
| slash 命令 | ✗ | ✅ 命令目录，不进模型 |
| 技能（skills） | ✗ | ✅ 模型按需加载；用户可调用的进斜杠补全 |
| 模型向你提问 | ✗ | ✅ 表单征询；客户端不支持时降级成按钮 |
| MCP server | ✗ 非空即拒绝 | ✅ 按会话挂载，stdio + HTTP，会话间隔离 |
| 上下文用量 | ✗ | ✅ `usage_update` 进度条 |
| 读未保存的缓冲区 | ✗ | ✅ `fs/read_text_file` 改道到编辑器 |
| 内嵌上下文（@ 文件） | ✗ `embeddedContext: false` | ✅ 整段内联 |
| 图片输入 | ✗ `image: false` | ✅ 按线序进模型，字节落内容寻址库 |
| 授权提示 | ✅ 一次性 allow / reject | ✅ 同左，另含沙箱越界提权 |
| 多会话 | ✅ | ✅ |

**请求重试。** 模型请求遇到网络错误、超时、限流（429）或服务端 5xx 时自动重试，最多 5 次，
间隔从 0.5 秒起指数增长、单次至多 10 秒；服务端给了 `Retry-After` 就照它等，超过这个上限则不再重试。
等待期间回答里会出现一行「模型请求失败：…，N 秒后第 k/5 次重试」，取消随时生效。认证失败、
余额不足、请求本身有误不重试——重试也是计费请求，注定失败的不该再发。

**沙箱。** 命令与文件操作同在一道围栏之下（默认 `workspace-write`，可写集是
`{会话 cwd, 系统临时目录}`），shell 与文件工具共用同一份定义。越界会被拒绝，
模型可以就该次操作发起提权，提示走 `session/request_permission`。

Windows 使用系统 PowerShell（优先 PowerShell 7，回退 Windows PowerShell 5.1），工具名为
`pwsh`，不需要 Git Bash；Linux 与 macOS 使用 `bash`。Windows ACL 后端报告
`enforcement: partial`：它限制常规 NTFS 写入，不限制读取、网络与进程可见性，也不承诺覆盖
WSL、FAT、Everyone ACL 或硬链接边界；沙箱不可用时会拒绝执行，不会静默转成完全访问。

**内置工具**：平台 shell（Windows 为 `pwsh`，Linux/macOS 为 `bash`）、`read`、`write`、`edit`、`glob`、`grep`、`todo_write`、
`ask_user_question`、`exit_plan_mode`，以及**按机器现有情况**决定的 `lsp`（见下）。

**上下文压缩。** 长会话撞到窗口上限时自动把较早的一段总结成一条替换消息，而不是让下一次
请求以「上下文超限」失败；也可以手动敲 `/compact`。声明了 `session.compaction` 的客户端会
收到 `compaction_update` / `compaction_summary_chunk`，能看到压了哪一段、摘要是什么；没声明的
客户端照常压缩，只是看不到进度。

**死循环护栏。** 模型连续用同样的参数调同一个工具时注入一条升级提示。不进工具表、不否决
调用、不改写入参——决定权仍在模型手里，合法的重复调用不受任何影响。

**指令文件与技能。** 从项目根（最近的 `.git`）到会话 cwd 的每一级目录里，`AGENTS.md`、
`CLAUDE.md` 及其 `.local.md` 覆盖层都会进模型上下文。另有两份用户级文件：`$DSH_HOME/AGENTS.md`
（即 `~/.dsh/AGENTS.md`），以及 **DSH 0.2 新增的** `$DSH_AGENTS_HOME/AGENTS.md`（默认
`~/.agents/AGENTS.md`）。项目文件与用户级文件各有 40,000 字节的上限，互不挤占。技能从 `<项目>/.dsh/skills`、`<项目>/.agents/skills`、
`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 四处发现，新增或修改技能不用重连就生效。

**`~/.agents` 是与其它 agent 工具共用的目录。** 别的工具（或你跑过的脚本）放进
`~/.agents/AGENTS.md`、`~/.agents/skills` 的东西，同样会进 DeepSeek 的上下文。先看看里面有
什么，或者在客户端的环境变量配置里把 `DSH_AGENTS_HOME` 指到你自己管的目录。

**图片输入。** 贴图或拖图进来即可，文本与图片**按线序**进模型（「改之前 [图] 改之后 [图]」
不会被拍成「改之前改之后 [图][图]」）。字节落进 `$DSH_HOME/attachments/` 的内容寻址库，
会话日志里只留引用——base64 直接写进日志会让一条日志涨到几十 MB，而每次恢复都要整份读回来。
默认模型 `deepseek-flash` **收图片**；切到纯文本路由上发图会被拒绝，拒绝信息里带着当前模型名，
你据此去模型选择器里换。接受 PNG / JPEG / WebP / GIF，单条消息最多 20 张。

**代码导航（`lsp`）。** 装了语言服务器就自动接上，没装就当它不存在——启动时按 `PATH`
查一遍内置候选（`typescript-language-server`、`pyright-langserver`、`gopls`、
`rust-analyzer`），一个都找不到就整套不挂。这不是偷懒：上游的 stdio 宿主在**插件加载时**
解析每一项的可执行文件，任何一项找不到就没有 provider 注册得上，写死一张默认表等于
「少装一个 gopls 就连不上编辑器」。要用别的服务器（`deno lsp`、项目本地的
`node_modules/.bin/…`、自研的），设 `DEEPSEEK_ACP_LSP_SERVERS` 为一份 servers JSON，
它**整表替换**内置候选。工具本身是只读的四个操作：`goToDefinition`、`findReferences`、
`goToImplementation`、`hover`。

**刻意不做的**：`fs/write_text_file` 委托（会绕开沙箱围栏，让「文件权限」选择器形同虚设）、
后台任务（自发回合发出的更新没有对应的 `stopReason` 归属）、上游的 `packages/extensions/`
（`cordis_define` / `cordis_run` 那套「模型改写自身运行时」——它在 `node:vm` 里跑、拿到活的
服务门面，绕开上面那道围栏；且它的启动控件是浏览器半边，没发布到 npm）。**受阻于上游的**：
`session/delete`（持久化后端至今没有 delete/purge API）、MCP 的 `sse` / `acp` 传输。

---

## 注册到编辑器

可执行文件是 `deepseek-acp`，通过 stdio 说 ACP。**起服务不需要任何参数**——编辑器直接
拉起即可；`--setup` / `--version` / `--help` 三个开关都是「跑完就退」，不进服务模式，
其余参数一律照常起服务（编辑器可能出于自己的理由多传点什么，为此拒绝启动会把一个
能跑的集成变成一句「连接失败」）。

API Key 有两条路，二选一：

- **`deepseek-acp --setup`** —— 交互式粘一次，存进 `$DSH_HOME/.credentials.yaml`
  （`0600`）。见下面「登录」一节。
- **客户端的环境变量** —— 下面两份配置都有位置。已经用 `--setup` 存过 Key 的话，用的是存下
  的那个。

**别指望 `.zshrc` 里的 `export`**——编辑器是 GUI 应用，不继承登录 shell 的环境，
它派生的子进程同样拿不到。这也正是 `--setup` 存在的理由：凭据落在文件里，与启动
方式无关。

### 登录

`initialize` 里可能 advertise 一条 ACP 的 **Terminal Auth**：

```json
{ "id": "terminal", "type": "terminal", "args": ["--setup"] }
```

**只发给声明认得它的客户端**——`clientCapabilities.auth.terminal === true`，或
`_meta["terminal-auth"] === true`（先于能力位存在的约定）。两者都没有时 `authMethods`
是空数组，与这个功能存在之前一模一样：终端登录是 opt-in 的方法类型，塞给没准备好的
客户端只会添乱。顺带一提，顶层的 `clientCapabilities.terminal` **不算**——那一位说的
是「实现了 `terminal/*` 那组方法」（终端卡片），是另一件事。

支持这条的客户端会用**同一个二进制**加上 `--setup` 另起一个交互式终端进程，等它
退出——**退出码 0 即成功**——再重连。手动跑也是同一条：

```sh
deepseek-acp --setup      # 粘 Key，回车。终端下不回显
```

写入的引用名是 `DEEPSEEK_API_KEY`，落点 `$DSH_HOME/.credentials.yaml`。**DSH 0.2 起这里存的
Key 压过环境变量**，包括编辑器传给智能体的 `DEEPSEEK_API_KEY`（0.9.0 及以前正好相反）。跑过
`--setup` 之后，在编辑器配置里改 Key 不会生效：要换就再跑一次 `--setup`，或者把那个文件里的
`DEEPSEEK_API_KEY` 条目删掉，改回用环境变量。两处都有且不一致时，智能体启动时会在 stderr
提示一行用的是哪一处，不打印任何一边的值。`.env` 文件不读。

声明这条**不代表会拦住建会话**：本项目从不返回 `auth_required`，缺 Key 的失败照旧
发生在第一个回合（`MISSING_CREDENTIAL`）。它只是给客户端一个登录入口。

### Zed

`settings.json` 里加一个 `agent_servers` 条目：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "deepseek-acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

装到全局（`npm i -g deepseek-acp`）的话，`command` 填 `deepseek-acp`、`args` 留空即可。

### codeg

codeg **已经内置**这个智能体，不用再手动添加自定义条目：设置 → 智能体，在列表里
找到 **DeepSeek Harness**，点 **安装**；装过之后同一处变成 **升级**，跟着 codeg 内置
注册表里的版本走。装的就是上面那条 npx 分发，不需要先 `npm i -g`。

Key 填在同一页的 **DeepSeek Harness 配置** 面板：

| 字段 | 说明 |
|---|---|
| API 端点 | 留空即官方端点 |
| API 密钥 | 以 `DEEPSEEK_API_KEY` 传给智能体；**用过 `--setup` 的话这里填了也不生效**——DSH 0.2 起凭据文件压过环境变量 |

**保存 DeepSeek 配置** 只对**新建**的会话生效，正在跑的会话要重连才换得过来。模型与
推理档位不在这张表里——它们是会话级选择器，在输入框里切，而且随会话保存：重新打开一条
会话，用的还是它上次的模型与档位，不会回到默认值。

旧版 codeg 没有这个内置条目，仍可走 设置 → 智能体 → **添加自定义智能体** →
**手动填写**：注册表 ID `deepseek-acp`、分发信息
`{"npx": {"package": "deepseek-acp@0.9.0", "cmd": "deepseek-acp"}}`、环境变量
`DEEPSEEK_API_KEY=sk-...`，版本查询命令留空。「版本」一栏要与分发信息里的版本一致
——codeg 的 preflight 会对账，对不上的表现是连接阶段失败而不是报错。

MCP 开着时，`codeg-mcp` 会作为 server 挂进来，模型看到的工具名带**会话前缀**
（`mcp__a1_codeg-mcp__<tool>`）：`serverName` 在进程内全局唯一，而 ACP 的
`mcpServers` 是每会话参数，不加前缀时第二个会话会挂不上。

### 会话日志

默认写在 `$DSH_HOME/sessions`（即 `~/.dsh/sessions`），可用
`DEEPSEEK_ACP_SESSIONS_ROOT` 覆盖。会话恢复、列表与标题都从这里读。

---

## 致谢

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 本项目的内核。
  没有它就没有这层适配器；曾经存在过的那版编辑器向 bridge 也给了本项目大量参考。
- **[LinuxDO](https://linux.do)** —— 本项目的起源社区。

---

## 许可

本项目 MIT，见 [`LICENSE`](LICENSE)。**这是一个非官方的社区适配器，与 DeepSeek
无隶属关系，亦未获其背书。**

仓库不含任何第三方源码的逐字副本。但**测试套件与设计**有相当一部分派生自
DeepSeek Harness 曾经存在的编辑器向 ACP bridge（`packages/ui/acp`，2026-07-24 被删除）。
**该快照适用 BSD-3-Clause 而不是仓库今天的 MIT**——上游是在删除之后才换的许可。
其原始版权声明与许可正文按 BSD 第 1 条的要求随附在 [`LICENSE`](LICENSE) 里。

想参与开发见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
