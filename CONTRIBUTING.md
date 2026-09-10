# 参与开发

## 起步

```sh
npm ci
npm run typecheck
npm test            # 不需要 API Key
npm run build
```

要求 Node ≥ 22。

**跑真模型**（可选，仅用于人工验证）：

```sh
mkdir -p ~/.dsh
printf 'DEEPSEEK_API_KEY: sk-...\n' > ~/.dsh/.credentials.yaml
chmod 600 ~/.dsh/.credentials.yaml      # 权限不对会在启动期失败退出

npm run probe -- "用一句话介绍你自己"   # 不依赖编辑器的最小 ACP 客户端
npm run dump-prompt                     # 打印模型实际拿到的 system prompt / 上下文 / 工具
```

`scripts/acp-probe.mjs` 把 `lib/bin.js` 当子进程驱动一遍完整回合，能看到完整的帧与
stderr。它有两个开关用来在本地复现不同客户端的能力面：

```sh
ACP_PROBE_NO_ELICIT=1 npm run probe -- "..."   # 装成没有表单能力的客户端，走提问降级
ACP_PROBE_FS_READ=1   npm run probe -- "..."   # 声明 fs.readTextFile，走读改道
```

凭据**只放在 `~/.dsh/.credentials.yaml`**。GUI 客户端不继承 shell 环境，`.zshrc` 里的
`export DEEPSEEK_API_KEY` 到不了子进程；而放进仓库的 `.env` 是最常见的泄密路径——
`.gitignore` 已经挡了一层，但别去试它。

**平台依赖**：`tests/sandbox.spec.ts` 与 `tests/composition.spec.ts` 需要平台沙箱后端
（macOS Seatbelt / Linux Landlock 或 bwrap）。后端不可用时它们失败是**对的信号**，
内置组合在那种平台上本来就起不来，不要用 skip 掩过去。

## 五条不能破的约束

这些不是风格偏好，每一条都对应一次真实的故障或一个静默失效面。

1. **stdout 即协议（AC-G1）。** 组合里不得挂 stdout logger，任何诊断输出走 stderr。
   往 stdout 写一个字节就会把 ndJSON 帧流打断，客户端只会显示「连接失败」。
   `tests/stdout-guard.spec.ts` 起**真子进程**守这条——进程内测试用内存流，碰不到
   真的 `process.stdout`。

2. **依赖锁定同一精确版本（约束 C1）。** 所有 `@deepseek-ai/dsh-*` 必须钉在同一个
   精确版本上。上游各包的 `latest` dist-tag 指向不同版本线，用 `latest` 或 `^` 会因
   peer 冲突装不上。`tests/contract.spec.ts` 守这条。

3. **纯下游，不改上游（D4）。** 只消费 `@deepseek-ai/*`，不 patch、不 vendor、
   不往 `node_modules` 里塞东西。缺什么在本项目这一侧适配。

4. **本包无 default export。** Cordis loader 的 unwrapping 会吞掉具名 `inject` 元数据，
   导致注入静默失效——装配成功，第一次用到才炸。

5. **声明与实现同一个真值来源。** `initialize` 里 advertise 的每一项都必须真的实现；
   反过来，实现了的要 advertise。典型反例：`promptCapabilities.embeddedContext` 与
   `promptHasUnsupportedContent` 是同一件事的两半，分开写必然分叉，所以有一条用例
   逐项把它们钉在一起。

## 测试纪律：首次就通过的用例必须做反向对照

一条**第一次跑就绿**的用例，和一条**什么都没测**的用例，从输出上完全分不开。
本项目出过好几次这种：

- 一条断言「客户端没声明能力就一次委托都不发」的用例，因为测试脚手架从没走过那条
  初始化路径，把实现改成 `return true` 它依然是绿的。
- 一条断言「未知参数照常起服务」的用例，实际上根本没传参数。

所以：**新用例第一次就通过时，去把它声称保护的那行实现改坏，确认它真的变红。**

还有一层，比上面那条更容易漏：**先确认你的改动真的落到文件上了。** 曾经有一次
`perl -i` 替换静默没匹配上，于是「改坏后仍然 6 passed」被当成了结论——而实际上
什么都没改。做对照时把改动后的那几行打出来看一眼，或者用带断言的脚本
（`assert old in text`）来改。

## 用例编号与注释

新增用例按 `TC-<域>-<序号>` 编号（`SESS`、`MAP`、`PRE`、`MCP`、`APPR`、`CFG`、
`CMD`、`GUARD`、`CONTRACT`、`PROP` 等），写在 `describe` 标题里。

**注释写「为什么」，不写「做了什么」。** 这个代码库里绝大多数注释解释的是某个写法
背后踩过的坑——哪种写错法不会报错、只会静默失效。加代码时把你当时查明白的那件事
留下来，那通常比代码本身更难重建。

## 提 PR 之前

```sh
npm run typecheck && npm run build && npm test
```

CI 会在 ubuntu 与 macos × Node 22/24 上跑同样这三步。

> `tsconfig.json` 与 `vitest.config.ts` 里排除了 `reference/` 与 `spikes/`。
> 这两个目录**不在版本库里**（维护者本地保留的上游参考副本与一次性技术验证），
> 你的检出里不会有，那两条 exclude 因此是空转的。留着是防 `include` 哪天放宽——
> 现在两处的 `include` 都只圈了 `src/` 与 `tests/`，exclude 并不承担实际作用。

## 发布（维护者）

日常发布只有两条命令：

```sh
npm version patch        # 或 minor / major：改 package.json 并打上 vX.Y.Z
git push --follow-tags
```

推上 tag 后 `.github/workflows/release.yml` 接手：校验 tag 与 `package.json`
版本一致 → typecheck / build / test → `npm publish` → 建 GitHub Release。

认证走 **npm trusted publishing（OIDC）**，仓库里不存 npm token——凭证由 GitHub
在运行时现签，npm 按「哪个仓库的哪个工作流文件」核对身份，顺带自动生成溯源证明。

一次性设置（只做一次）：

1. **首发手工来一次。** npmjs.com 的 trusted publisher 配在**包的 settings 页**，
   包不存在时没有那个页面。本地 `npm publish` 发出 `0.1.0` 即可——`prepublishOnly`
   会先跑完整闸门。
2. npmjs.com → 该包 → Settings → Trusted Publisher → GitHub Actions，填
   Organization/user、Repository、**Workflow filename 填 `release.yml`**
   （只填文件名，带扩展名），Environment 留空。
3. Settings → **Publishing access** 选 **"Require two-factor authentication and disallow
   bypass 2fa tokens"**。它禁掉的是**绕过 2FA 的 token**，不是本机发布：维护者本人
   带 2FA 照样能发，只是无人值守发布从此只剩「本仓库的 `release.yml` 走 OIDC」这一条路。

几个会让人查半天的点：

- **改工作流文件名等于换身份。** npm 保存配置时不做任何校验，填错只在发布那一刻
  以鉴权失败的形式暴露。
- **`package.json` 的 `repository.url` 必须与 GitHub 仓库完全对得上**，否则溯源
  证明生成不出来。
- 发布任务跑在 macOS 上（沙箱用例走系统自带的 Seatbelt），CI 那条仍然覆盖 ubuntu。

## 设计札记

下面每一条都对应一次真实的排查，绝大多数记的是**写错了也不报错**的那一类：
装配照常成功、用例照常绿，故障出现在离原因很远的地方。改到相关代码时先扫一眼。

- **stdout 即协议**。组合中不得挂 stdout logger，诊断一律走 stderr。有子进程级测试守护。
- **但也要真的挂一个 stderr logger**。cordis 的 `ctx.logger` 没有 exporter 就什么都不输出——此前组合里一个都没挂，于是 bridge 里所有 `warn`（通知失败、断连时的审批拒绝、呈现器抛错）在真实二进制里全是落空的，而那些恰恰是出问题时唯一的线索。`boot()` 现在注册一个 stderr exporter；`composeAgent()` 不注册，免得每个用例都吐一遍日志淹掉真正的失败输出。
- **握手时记一行客户端能力位**。排查一切降级行为的起点都是「它 advertise 了吗」。摘要如实回显原始值：`（未声明）` 与 `false` 是两种不同的信号——前者是客户端压根不认识这个位，后者是它明确说不支持。
- **本包无 default export**。Cordis loader 的 unwrapping 会吞掉具名 `inject` 元数据。
- **`ScopeKey` 是 `handle.agent`**，不是 `agents.create()` 返回的句柄。传错不报错，只静默返回空集。
- **依赖锁定同一精确版本**。上游各包的 `latest` dist-tag 指向不同版本线，用 `latest` 会因 peer 冲突装不上。有契约测试守护。
- **prompt 结算等 whole-agent idle，再等一次落盘**，不是 `turn/end`。steering 与注入工作可能在 idle 前继续贡献消息，所以不能看 `turn/end`；而 idle 也不排空写入缓冲，所以之后还要 `ctx.sessions.flush()`。落盘失败时这次 prompt 以错误应答——报 `end_turn` 而历史没保住，是这条链上最坏的结果。
- **GUI 客户端不继承 shell 环境**。`.zshrc` 里的 `export DEEPSEEK_API_KEY` 到不了子进程，凭据要落在 `~/.dsh/.credentials.yaml`。
- **上游各包的 `latest` 指向不同版本线**。`dsh-llm-deepseek@latest` 是 `0.0.1-rc.1`，本项目要的 `0.1.0-rc.6` 得显式写出来。
- **卡片类型由工具自己声明**（`presentCall` / `presentResult`），bridge 绝不按工具名嗅探。
- **呈现层没有 `assertNever`**。`ToolResultView` 自上游那份 bridge 写成以来已长出 `search` / `read` / `web` 三个新变体；穷尽 switch 会在上游加变体的那天把整条流式打掉。未识别变体一律降级为通用文本卡片。
- **`tool_call_update.content` 会整体替换调用侧装好的内容**。终端结果因此只走 `_meta`，不带 `content`。
- **终端输出的 `_meta` 载荷键是 `data`，不是 `output`**。写错不报错：客户端照样按 `terminal_info` 建出终端，然后永远收不到内容。纯函数用例照着实现写会一起错，是端到端用例抓到的。
- **`dsh-subprocess` 只是 seam**。要挂的是 `dsh-subprocess-local`（它继承前者并注册同一个服务）。两个都挂 → 「服务已注册」；只挂 seam → 装配成功，第一条命令才炸 `spawn is not a function`。
- **`session-query` 是抽象类，没有独立实现**。`session/list` 只需元数据，直接走 `ctx.sessionPersistence.list()`，不必为此拉进 sqlite 全文检索。
- **会话落盘是批量合并的**（默认 200ms 窗口）。回合结束、乃至 agent 离开注册表，都不等于日志已在磁盘上。这条真的咬过一次：客户端拿到 `session/prompt` 的应答立刻退出，最后一轮的 `assistant/message` 与 `turn/end` 还在缓冲里，重开会话只剩用户那半句话，**且没有任何错误**——看起来像模型忘了自己说过什么。修法是结算前显式 flush（见上面 prompt 结算那条），TC-SESS-09 守着它，判据是应答之后**立刻**读物理存储：中间加任何等待都会把这个竞态掩盖掉。
- **重放要过滤注入的上下文**。`dsh-agent-instructions` 把整份 AGENTS.md / CLAUDE.md 包成一条 `kind: 'plugin'` 的用户消息塞进回合；不按 `source.kind === 'user'` 过滤，用户会在自己的对话记录里读到一段从没打过的话。
- **ACP 没有「支持配置项」的能力位**。声明方式就是在 `session/new` / `session/load` 的应答里带回 `configOptions`；空数组等价于没有可配置项。
- **沙箱模式的覆盖写在会话日志里**，不是内存。因此它随 `session/load` 一起恢复——恢复一个当初放宽过权限的会话，控件如实显示放宽后的状态，而不是显示部署默认让人以为是安全的。
- **模型切换装在 agent 作用域的选择 ref 上**，在下一步进入 prompt 装配时生效。不会把正在跑的那一步劈成两半（一半用旧模型的提示词、一半发给新模型）。
- **MCP 的 `serverName` 是进程内全局唯一的，而 ACP 的 `mcpServers` 是每会话参数**。两个会话配同名 server 时后者 `session/new` 直接失败。解法是会话前缀（`a1_github`），代价是模型看到的工具名带前缀。
- **前缀还要覆盖字符集规整**，不只是超长。ACP 的 `McpServer.name` 无字符约束而上游只收 `[A-Za-z0-9_-]`；直接规整会让 `a.b` 与 `a b` 双双变成 `a_b`，同一会话内第二个 server 挂载失败——正是前缀要解决的冲突换个地方重现。
- **`session/new` 的命令快照必须排在应答之后**。会话 id 是服务端生成的，客户端第一次知道它就在那份应答里；抢在前面发的 `session/update` 指向一个它还不认识的会话，多数客户端直接丢弃，表现是「命令目录时有时无」。SDK 里处理器返回与写出应答之间只隔一个 microtask，因此一个 macrotask 就是确定的分界，不是碰运气。有线上顺序用例守护。
- **`current_mode_update` 携带完整状态而非增量**，所以乐观回显与已提交的 `plan/mode` 事件各发一条同值更新是幂等的，不必去重。少了事件那条，模型自己调 `exit_plan_mode` 退出时选择器会一直停在「计划」上。
- **计划模式是引导，不是强制**。上游明确说 plan mode 只贡献提示词段，沙箱与审批各自独立执行限制。因此模式说明里不承诺「不会改文件」——一个假的保险比没有保险更危险。
- **`exit_plan_mode` 的通过条件是 `selected` 恰好一项且 `custom` 不存在**。给每个选项题都塞一个空 `custom` 会让任何计划都通不过评审，而这种错误在「表单弹出来了」这层完全看不见。因此不在选项表里的字符串才进 `custom`，空串等同于不存在。两条提问通道各自守住这一条。
- **授权通道是提问的可靠退路**。ACP 里 `session/request_permission` 在 `Client` 接口上是**必选**方法、不受能力位约束，而 `elicitation/create` 是可选的（`unstable_createElicitation?`）且要客户端 advertise `elicitation.form` —— 前者可能不存在，后者一定存在。没有这条降级，`ask_user_question` 与 `exit_plan_mode`（计划评审只有提问这一个出口）在不支持表单的客户端上整个不可用。
- **降级时选项 id 用下标而不是标签**。表单路径可以直接用标签（`const` 就是回传值），但授权通道的 `optionId` 一旦重名就会静默串答案；标签由映射层按下标还原。同理，未知 `optionId` 一律报错而不取近似值——在计划评审里猜错等于替用户点了「批准」。
- **降级的授权提示挂在提问工具自己的卡片上**。提问时该工具就是唯一在飞的调用，据此取真实 `toolCallId`；并行调用而判定不了时才合成一个。宁可多出一张卡片，也不要把提示挂到隔壁工具头上。
- **没有选项就不发降级请求**。一颗按钮都没有的授权请求等于一个点不动的弹窗。而且要在问第一题之前把整组问题验完——放在循环里检查的话，用户会答完第一题才撞上失败，那次作答完全白费。
- **plan 引导段要写明方案以 `# ` 标题开头**。`exit_plan_mode` 用 `/^#\s+\S/` 硬校验，提示里不写模型只能撞几次墙才知道。两处是同一条规则的两半，有用例把它们钉在一起。
- **命令执行未必不起回合**。`/plan <消息>` 会先开计划模式再 `steer()` 提交，那条消息的 id 由上游铸造、bridge 拿不到，因此命令路径按「本会话的下一个回合结束」结算（I1 保证不存在第二个候选）。否则一次被截断的回答会静默报成正常结束。
- **`session/list` 的标题要把每条日志读一遍**。header 里既没有标题也没有最后活动时间，两者都只能从事件折出来。有并发上限，单条日志损坏时该会话仍会列出、只是没有标题——整份列表不该因为一条坏日志失败。
- **`session/resume` 与 `session/load` 只差回放**。前者的应答与 `session/new` 同构（`modes` + `configOptions`），历史不流回客户端——客户端自己就有转录，几百轮的会话没必要让它把已有内容再画一遍。两条路径共用 `restoreSession()`：cwd 校验、seq 分配、MCP 挂载全一样，写成两份迟早只改一边。
- **`session/close` 无条件声明，不跟随持久化**。它释放的是进程内资源（agent、MCP 子进程、订阅），与会话能不能从日志恢复无关。没有它，`SessionTable` 唯一的移除路径是断连时的 `drain()`——编辑器里开十几个会话就是十几个活 agent 常驻。
- **`close` 里的 `settlePrompt` 是兜底，不是唯一出口**。`handlePrompt` 挂在 `whenIdle` 上的回调最终也会把在途 prompt 判成 `cancelled`；区别在时机——那条要等释放跑完（MCP 子进程退出、日志刷盘），而那期间客户端的 `session/prompt` 是一个开着的请求。
- **推理档位的词表随模型变**，不是全局常量（有的路由只剩 `off`）。因此切模型时**清空**会话的档位选择：`LlmRuntime` 会校验有效档位在新词表里，留着旧值的后果是下一次请求抛 `UNSUPPORTED_REASONING_EFFORT`。清空等于回到新模型的默认档，也正是上游对「未选中档位」的定义。
- **不需要 `config_option_update`**。模型/档位的唯一变更路径就是 `session/set_config_option`，而它的应答本来就带回**全部**配置项——同一次往返里列表就换成新模型的了。`optionsFor` 是 async 的，所以档位词表直接 await 解析，不像上下文窗口那样被同步映射逼着读缓存。
- **文件工具的沙箱要靠 `dsh-fs-sandbox`，`dsh-fs-local` 不约束任何东西**。`dsh-tool-fs` 是拿 `ctx.fs.sandboxMode` 决定要不要执行策略的：报 `undefined` 就连 `sandboxPolicy` 都不去取，每次写都是无围栏的 `writeText`，而 `write` / `edit` 也不会 advertise `sandbox_permissions`。这个缺口在本项目真实存在过——那时 `bash` 已经被 Seatbelt 管住、配置项也写着「命令与文件工具共用这一条边界」，唯独文件工具没有。实测一次越界写会直接打到内核（`EACCES … mkdir '/private/etc/…'`），也就是说**只有操作系统的文件权限拦得住它**：凡是进程有权写的地方（`~/.ssh`、另一个项目的源码树）都会静默成功。可观测的判据是 `ctx.fs.sandboxMode` 与 `write` 的参数表，有 TC-COMP-05 守护。
- **对照实验要选对目标**。第一次验证这个缺口时我把「工作区之外」的目标建在了系统临时目录里——那属于 `workspace-write` 的可写集，写成功是**设计如此**，那次探测毫无意义。有效的目标必须同时在 `{workspace, /tmp, tmpdir()}` 之外；用 `/etc` 还能顺带把「围栏拒绝」（`FS_SANDBOX_DENIED`，syscall 之前）与「内核拒绝」（`EACCES`）区分开。
- **`usage_update` 是上下文占用，不是累计花费**。`used` / `size` 描述当前窗口占了多少，所以各步**不能相加**——那会让数字一路涨到超过 `size`。输入侧三项要全加（上游明确 `inputTokens` 只算未命中缓存的部分，计费输入是三者之和），`reasoningTokens` 不加（它是产出的一部分）。
- **分母不知道就整条不发**。ACP 的 `size` 是必填项，编一个默认值会画出一根看起来权威、刻度却是错的进度条，比没有进度条更坏。窗口大小要向适配器异步解析而映射是同步的，所以建会话与切模型时各预热一次——否则用量条会在会话开头和切换后各空一轮。
- **`embeddedContext` 与放行集合是同一件事的两半**。`handleInitialize` 声明什么，`promptHasUnsupportedContent` 就得放行什么。分开写必然分叉：那边多声明一项而这边不放行，客户端会收到「你说你支持」的困惑错误；这边多放行而那边不声明，规矩的客户端根本不会发过来。有一条用例逐项把两者钉在一起。

- **三条映射不变量用属性测试而非样例测试**。「对任何事件序列都成立」不是几个样例能证明的，而映射面现在有 9 种输出变体。其中 TC-PROP-03（重放等于实时）守的是整个 bridge 的核心约束——`session/load` 与实时流走同一个 `mapEvent`，所以「恢复出来的会话和当时看到的一样」不靠两处代码保持同步，是结构上不可能分叉。属性测试最典型的失效方式不是断错而是生成器覆盖不到，所以另有一条用例断言**每种合法变体都真的被产出过**。

- **只把读委托给编辑器，写和 edit 不委托**。委托读的收益是看得见未保存的缓冲区；委托写的代价是绕开 `dsh-fs-sandbox` 的策略围栏。codeg 自己也有围栏（连接日志里那行 `fs policy read=unrestricted write=…`），但那是**它的**围栏，两道围栏各判各的，「文件权限」配置项就不再说了算。已知代价：读到缓冲区之后同一轮里的 `edit` 仍对磁盘做字面匹配，不一致时以 `FS_NO_MATCH` 失败——一次响亮的失败，不是静默改错文件。

- **文件工具装在会话作用域，不装在根组合上**。`dsh-tool-fs` 是依赖树里唯一读 `ctx.fs` 的插件，而它的 `apply(ctx)` 闭包捕获自己的挂载 context；装在根上，会话级的 `fs` 替换就永远看不到。装饰器本身必须经 `ctx.plugin()` 装配而非直接 `new`——会话装配跑在一个尚未 commit 的 fiber 里，直接构造时服务还没发布，`inject: ['fs']` 会永远等下去，表现成四个文件工具**一个都不注册**。

- **装饰器是组合不是继承**。`LocalFileSystem` 的写锁是 per-instance per-targetKey 的；每个会话各继承出一个 `SandboxedFileSystem`，两个会话写同一个文件时就各拿各的锁，把「一个赢、其余判 stale」变成一场竞态。转发给根实例，锁才仍是全进程唯一的一份。

- **能力声明跟着组合走**。`loadSession` / `sessionCapabilities.list` 只在挂了持久化时 advertise，两个方法在缺持久化时也直接 `methodNotFound` —— 声明与实现同一个真值来源。
- **冷启动约 900ms**，编辑器每建一条连接付一次。其中约 590ms 是加载依赖树的 `import`，`composeAgent` 本身只要 ~70ms —— 再挂几个插件不会明显变慢，**多引一棵大依赖树会**。M1-b 期间这个数字从 ~365ms 涨到 ~900ms，最先暴露的方式是一个用固定 sleep 等启动的用例开始随机失败。
