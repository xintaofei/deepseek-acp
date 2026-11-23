/**
 * `session/set_config_option` —— 会话内切模型与切权限（US-16 / US-17）。
 * @module
 */

import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams } from '../codec/errors.js'
import type { ConfigInputs, RouteChoice } from '../config/options.js'
import {
  MODEL_OPTION,
  REASONING_OPTION,
  SANDBOX_OPTION,
  configOptions,
  decodeRouteValue,
  providerDefaultValue,
} from '../config/options.js'
import type { SessionRecord } from '../session/table.js'

/**
 * 读取某会话当前的全部配置项。
 *
 * `session/new`、`session/load`、`set_config_option` 三处共用：三处各算一遍
 * 迟早会出现「新建时有模型项、切换后应答里没有」这种客户端侧看着像 bug 的分叉。
 * @param bridge - 运行时
 * @param record - 会话记录
 * @returns 配置项数组
 */
export async function routesFor(bridge: Bridge): Promise<RouteChoice[]> {
  // 列的是**当前活着的**全部 provider，而不是建会话时那一个：模型下拉现在跨
  // provider，用户配了第二条路由就该在同一个框里看到它。
  //
  // 各 provider **并发**列模型：列目录可能是一次网络往返，串行会让 N 个 provider
  // 各等一遍。单个 provider 取不到目录时 `listModels` 自己回空数组（不抛），于是
  // 一条坏路由只会让它自己从下拉框里消失，不会带塌整份配置项。
  const providers = bridge.port.listProviders()
  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      const models = await bridge.port.listModels(provider.id)
      return models.map((model) => ({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
      }))
    }),
  )
  return perProvider.flat()
}

export async function optionsFor(bridge: Bridge, record: SessionRecord): Promise<SessionConfigOption[]> {
  return configOptions(await optionInputsFor(bridge, record))
}

async function optionInputsFor(bridge: Bridge, record: SessionRecord): Promise<ConfigInputs> {
  // 档位词表按会话**当前**路由查，而不是部署的初始 provider —— 换过 provider 之后
  // 两者会分叉，用旧的会给出一份别人的词表。
  const provider = record.handle.controls.provider() ?? bridge.config.provider
  const model = record.handle.controls.model()
  // 切模型的应答走的也是这个函数，所以列表在同一次往返里就换成新模型的了
  // ——不需要另开一条 `config_option_update` 推送。
  const reasoning =
    provider === undefined || model === undefined
      ? undefined
      : await bridge.port.reasoningEfforts(provider, model)
  return {
    controls: record.handle.controls,
    routes: await routesFor(bridge),
    sandboxModes: bridge.port.sandboxModes,
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 变更后的**全部**配置项
 */
export async function handleSetConfigOption(
  bridge: Bridge,
  params: SetSessionConfigOptionRequest,
): Promise<SetSessionConfigOptionResponse> {
  bridge.assertOpen()
  const record = bridge.table.get(params.sessionId as SessionId)
  if (record === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

  const inputs = await optionInputsFor(bridge, record)
  const current = configOptions(inputs)
  const target = current.find((option) => option.id === params.configId)
  // 未 advertise 的配置项一律拒绝。静默接受会让客户端以为设置生效了。
  if (target === undefined) throw invalidParams(`unknown config option: ${params.configId}`)

  if ('type' in params && params.type === 'boolean') {
    throw invalidParams(`config option "${params.configId}" is a select, not a boolean`)
  }
  const value = params.value as string

  // 值必须在 advertise 过的候选里。不校验的话，一个拼错的模型 id 会一路带到
  // 下一步的请求里，表现为「换了模型之后就报 404」。
  if (target.type === 'select' && !selectValues(target).includes(value)) {
    throw invalidParams(`config option "${params.configId}" has no value "${value}"`)
  }

  switch (params.configId) {
    case MODEL_OPTION: {
      // 取值可能是裸模型 id（单 provider）也可能带 provider 前缀（多 provider），
      // 由 `decodeRouteValue` 按同一份路由表还原成一对。上面那道词表校验已经保证
      // 它在候选里，所以解不出来只可能是路由表在这两步之间变了（用户刚好在这一
      // 瞬间改了 settings）——那种情况拒绝掉，好过按半个路由发请求。
      const route = decodeRouteValue(value, await routesFor(bridge))
      if (route === undefined) {
        throw invalidParams(`config option "${params.configId}" has no value "${value}"`)
      }
      record.handle.controls.setRoute(route.provider, route.model)
      break
    }
    case REASONING_OPTION:
      record.handle.controls.setReasoningEffort(value === providerDefaultValue(inputs.reasoning) ? undefined : value)
      break
    case SANDBOX_OPTION:
      record.handle.controls.setSandboxMode(value)
      break
    default:
      throw invalidParams(`config option "${params.configId}" is not settable`)
  }

  // 回**全部**配置项而非只回改动的那个：协议要求应答带完整列表，客户端据此
  // 整体重绘；只回一项会让别的控件保持在旧值上。
  return { configOptions: await optionsFor(bridge, record) }
}

/** 某个 select 配置项的合法值集合（options 可能是分组形式）。 */
function selectValues(option: Extract<SessionConfigOption, { type: 'select' }>): string[] {
  return option.options.flatMap((entry) => ('group' in entry ? entry.options.map((o) => o.value) : [entry.value]))
}
