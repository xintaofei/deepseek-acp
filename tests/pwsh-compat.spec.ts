import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.js'

const WINDOWS_POWERSHELL = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const POWERSHELL_7 = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')

function unicodeWorkdir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsacp-pwsh-')))
  const cwd = join(root, 'workspace with spaces - 中文')
  mkdirSync(cwd)
  return cwd
}

function pathWithoutGitBash(): string {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((entry) => !/[\\/]Git[\\/](?:bin|usr[\\/]bin)$/i.test(entry.replace(/^"|"$/g, '')))
    .join(delimiter)
}

function pwshLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

describe.skipIf(process.platform !== 'win32')('TC-PWSH Windows PowerShell compatibility', () => {
  const localCase = async (pwshPath: string): Promise<void> => {
    const h = await createHarness({ shell: 'local', pwshPath })
    try {
      expect(h.ctx.tools.get('pwsh')).toBeDefined()
      expect(h.ctx.tools.get('bash')).toBeUndefined()

      const result = await (await h.ctx.shell.execute(h.ctx.shell.resolve({
        command: "Write-Output '中文 output'; exit 7",
        workdir: unicodeWorkdir(),
        env: { PATH: pathWithoutGitBash() },
      }))).result()
      expect(result.stdout.text).toContain('中文 output')
      expect(result.exitCode).toBe(7)
    } finally {
      await h.retire()
    }
  }

  it.skipIf(!existsSync(WINDOWS_POWERSHELL))('runs Unicode commands through Windows PowerShell 5.1', async () => {
    await localCase(WINDOWS_POWERSHELL)
  }, 120_000)

  it.skipIf(!existsSync(POWERSHELL_7))('runs Unicode commands through PowerShell 7', async () => {
    await localCase(POWERSHELL_7)
  }, 120_000)

  it.skipIf(!existsSync(WINDOWS_POWERSHELL))(
    'does not execute the forbidden Console encoding setter in ConstrainedLanguage',
    async () => {
      const h = await createHarness({ shell: 'sandbox', pwshPath: WINDOWS_POWERSHELL })
      try {
        const result = await (await h.ctx.shell.execute(h.ctx.shell.resolve({
          command: "Write-Output $ExecutionContext.SessionState.LanguageMode; Write-Output '受限中文'",
          workdir: unicodeWorkdir(),
        }))).result()
        expect(result.exitCode).toBe(0)
        expect(result.stdout.text).toContain('ConstrainedLanguage')
        expect(result.stdout.text).toContain('受限中文')
        expect(result.stderr.text).not.toContain('PropertySetterNotSupportedInConstrainedLanguage')
        expect(result.stderr.text).not.toContain('Cannot set property')
      } finally {
        await h.retire()
      }
    },
    180_000,
  )

  it.skipIf(!existsSync(WINDOWS_POWERSHELL))(
    'runs node.exe, cmd.exe, and npm.cmd as confined child processes',
    async () => {
      const npmCmd = join(dirname(process.execPath), 'npm.cmd')
      const cmdExe = process.env['ComSpec'] ?? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
      expect(existsSync(npmCmd)).toBe(true)
      expect(existsSync(cmdExe)).toBe(true)

      const commands = [
        {
          command: `& ${pwshLiteral(process.execPath)} -e ${pwshLiteral('process.stdout.write(String.fromCharCode(110,111,100,101,45,99,104,105,108,100))')}`,
          output: 'node-child',
        },
        { command: `& ${pwshLiteral(cmdExe)} /d /s /c ${pwshLiteral('echo cmd-child')}`, output: 'cmd-child' },
        { command: `& ${pwshLiteral(npmCmd)} --version`, output: /^\d+\.\d+\.\d+/m },
      ]

      const h = await createHarness({ shell: 'sandbox', pwshPath: WINDOWS_POWERSHELL })
      try {
        const workdir = unicodeWorkdir()
        for (const probe of commands) {
          const result = await (await h.ctx.shell.execute(h.ctx.shell.resolve({ command: probe.command, workdir }))).result()
          expect(result.exitCode, result.stderr.text).toBe(0)
          expect(result.stdout.text).toMatch(probe.output)
        }
      } finally {
        await h.retire()
      }
    },
    180_000,
  )
})
