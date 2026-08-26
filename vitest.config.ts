import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // 编码用例要临时改**控制台的全局代码页**，与任何并发跑着的 shell 用例互斥。
    // 它由 `npm run test:encoding` 单独跑（`vitest.encoding.config.ts`，单 worker）。
    // 排除它是 `npm test` 能安全并发的前提，两处必须同时存在。
    exclude: ['reference/**', 'spikes/**', 'node_modules/**', 'tests/pwsh-encoding.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Windows shell tests start real ACL runners and Windows PowerShell
    // processes. Four-way file parallelism saturates small CI/dev machines and
    // turns fixed lifecycle deadlines into load tests instead of regressions.
    ...(process.platform === 'win32' ? { maxWorkers: 2, minWorkers: 2 } : {}),
  },
})
