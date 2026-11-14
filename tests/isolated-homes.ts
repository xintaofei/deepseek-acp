/**
 * 整套用例共用的隔离家目录，由两份 vitest 配置经 `test.env` 注入。
 *
 * 不隔离时有三条路会读到、甚至写进开发者本机的目录：
 *
 * - `composeAgent()` 挂的 `agent-instructions` 会把 `$DSH_HOME/AGENTS.md` 与
 *   `$DSH_AGENTS_HOME/AGENTS.md`（缺省 `~/.dsh`、`~/.agents`）读进上下文。后者是
 *   DSH 0.2 新加的，**与其它 agent 工具共用**，开发机上多半有东西。
 * - 同一个组合里的技能提供方会扫 `$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills`。
 * - 起真实二进制的用例（`stdout-guard`）照抄 `process.env`，于是那个子进程按生产
 *   默认值读 `~/.dsh` 下的设置与凭据，上面两条也在它里面再走一遍。
 *
 * 断言因此随「这台机器上有什么」而变：本机配过 pi-ai 路由，启动路径就多加载一个
 * 5 秒的包；凭据文件里有 key，就多一条 stderr 提示。harness
 * 自己的组合早已显式传路径；这里兜住的是**按生产默认值解析**的那些路径。需要
 * 自己的家目录的用例（`cli.spec`、`upgrade.spec`）照旧自己设，优先于这里。
 *
 * 每次加载配置建一个新目录，不清理：它和各用例自己 `mkdtemp` 的目录一样落在系统
 * 临时目录里。
 * @module
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 建一组新的隔离家目录。
 * @returns 要注入用例进程的环境变量
 */
export function isolatedHomes(): Record<'DSH_HOME' | 'DSH_AGENTS_HOME', string> {
  const root = mkdtempSync(join(tmpdir(), 'dsacp-test-home-'))
  return { DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents') }
}
