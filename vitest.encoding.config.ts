import { defineConfig } from 'vitest/config'

/**
 * `tests/pwsh-encoding.spec.ts` 专用：**单 worker 跑这一个文件**。
 *
 * 为什么不能靠命令行过滤（`vitest run tests/pwsh-encoding.spec.ts`）：主配置的
 * `exclude` 在**发现阶段**就生效，早于位置参数过滤，那次调用一个用例都收不到，
 * 并以退出码 1 失败——把「没跑」伪装成「跑挂了」，一样不能接受。（本机用仓库
 * 自带的 vitest 2.1.9 实测确认。）所以走独立配置。
 *
 * 为什么单 worker：那个文件要临时改**控制台的全局代码页**，任何并发跑着的
 * shell 用例都会被它污染。`poolOptions` 隔离的是 JavaScript 状态，不是控制台。
 */
export default defineConfig({
  test: {
    include: ['tests/pwsh-encoding.spec.ts'],
    // 不继承主配置的排除项 —— 主配置正是靠排除这个文件才让 `npm test` 安全的。
    exclude: [],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // 独立配置**不继承**主配置。不带上这两个就退回 vitest 默认的 5s/10s，而这
    // 些用例要起真的 ACL runner 与 PowerShell 进程。
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
