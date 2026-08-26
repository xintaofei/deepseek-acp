import { nativeShellToolName } from '../src/composition/shell.js'

export const NATIVE_SHELL_TOOL = nativeShellToolName()

export function nativeCommand(commands: { bash: string; pwsh: string }): string {
  return NATIVE_SHELL_TOOL === 'pwsh' ? commands.pwsh : commands.bash
}

export function shellLiteral(value: string): string {
  return NATIVE_SHELL_TOOL === 'pwsh'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

export function stdoutCommand(text: string): string {
  const value = shellLiteral(text)
  return nativeCommand({ bash: `printf '%s\\n' ${value}`, pwsh: `Write-Output ${value}` })
}

/**
 * 往 stderr 写一行并以指定码退出。
 *
 * pwsh 侧用 **cmdlet 而不是 .NET 静态方法**：沙箱的 `read-only` 模式下
 * PowerShell 跑在 ConstrainedLanguage 里（它无法在临时目录建 AppLocker 探针，
 * 于是保守降级），那里 `[Console]::Error.WriteLine(...)` 这类非核心静态调用会以
 * `Cannot invoke method` 失败。`$host.UI.WriteErrorLine()` 同样是方法调用，
 * 一样会被拦，所以也不能用。
 *
 * 退出码由**显式的 `exit`** 给：`Write-Error` 在默认的
 * `$ErrorActionPreference = 'Continue'` 下既不终止脚本也不设退出码。
 *
 * 代价：`Write-Error` 打出来的是 PowerShell 的 ErrorRecord 渲染（5.1 下还跟着
 * `+ CategoryInfo` 等若干行），`text` 在其中但不是裸串——调用方断言要用
 * `toContain` 而不是全等。
 */
export function stderrAndExitCommand(text: string, exitCode: number): string {
  const value = shellLiteral(text)
  return nativeCommand({
    bash: `printf '%s\\n' ${value} >&2; exit ${exitCode}`,
    pwsh: `Write-Error ${value}; exit ${exitCode}`,
  })
}

export function cwdCommand(): string {
  return nativeCommand({ bash: 'pwd', pwsh: '(Get-Location).Path' })
}

export function writeFileCommand(path: string, content: string): string {
  const file = shellLiteral(path)
  const value = shellLiteral(content)
  return nativeCommand({
    bash: `printf '%s' ${value} > ${file}`,
    pwsh: `Set-Content -LiteralPath ${file} -Value ${value} -NoNewline`,
  })
}
