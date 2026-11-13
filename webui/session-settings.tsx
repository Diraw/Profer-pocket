/**
 * 「模型 + 推理强度」选择菜单。
 *
 * 一个菜单放两件事，是因为它们语义相邻（换模型常常要连档位一起调），
 * 而且手机上多一层二级页面就多一次往返。分区用细线与小标题隔开。
 *
 * 运行中一律禁用：服务端对 model / effort 的更新都有「运行中拒绝」的校验，
 * 与其让用户点完吃一个错误横幅，不如直接说明。
 */
import * as React from 'react'
import {
  groupModelsByChannel,
  modelLabelFor,
  type ModelOption,
  type StrengthState,
} from './model-selection'
import { presetBadges, type WebPreset } from './preset-model'

export interface SessionSettingsMenuProps {
  models: ModelOption[]
  currentModelId: string | undefined
  strength: StrengthState
  /** 当前工作区可选的预设（已过滤明确停用项） */
  presets: WebPreset[]
  currentPresetId: string | undefined
  /** 会话正在跑：模型与档位都不接受修改 */
  running: boolean
  busy: boolean
  onPickModel: (option: ModelOption) => void
  onPickStrength: (value: string) => void
  onPickPreset: (presetId: string) => void
  onManagePresets: () => void
  onClose: () => void
}

export function SessionSettingsMenu({
  models, currentModelId, strength, presets, currentPresetId,
  running, busy, onPickModel, onPickStrength, onPickPreset, onManagePresets, onClose,
}: SessionSettingsMenuProps): React.ReactElement {
  const groups = groupModelsByChannel(models)
  const singleChannel = groups.length <= 1
  const locked = running || busy

  return (
    <>
      <div className="menu-scrim" onClick={onClose} />
      <div className="menu wide" role="menu" aria-label="模型、推理强度与预设">
        {running && <div className="menu-note">运行中不能切换，等这轮结束再改</div>}

        <div className="menu-label">模型</div>
        {groups.length === 0 && <div className="menu-note">还没有取到可用模型</div>}
        {groups.map((group) => (
          <React.Fragment key={group.channelId}>
            {/* 只有一个渠道时不加分组标题，省一行也少一层噪音 */}
            {!singleChannel && <div className="menu-group">{group.channelName || group.channelId}</div>}
            {group.models.map((option) => {
              const active = option.modelId === currentModelId
              // 倍率是唯一值得占一行的附加信息（决定这条模型贵不贵）
              const hint = option.multiplier ? `${option.multiplier}x` : ''
              return (
                <button
                  key={`${option.channelId}:${option.modelId}`}
                  className={`menu-item ${active ? 'active' : ''}`}
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={locked}
                  onClick={() => onPickModel(option)}
                >
                  <span className="menu-item-text">
                    <span className="menu-item-label">{option.name}</span>
                    {hint && <span className="menu-item-hint">{hint}</span>}
                  </span>
                  {active && <span className="menu-check" aria-hidden="true">✓</span>}
                </button>
              )
            })}
          </React.Fragment>
        ))}

        <div className="menu-sep" />
        <div className="menu-label">推理强度</div>
        {strength.options.map((option) => {
          const active = option.value === strength.value
          return (
            <button
              key={option.value}
              className={`menu-item ${active ? 'active' : ''}`}
              role="menuitemradio"
              aria-checked={active}
              disabled={locked}
              onClick={() => onPickStrength(option.value)}
            >
              <span className="menu-item-text">
                <span className="menu-item-label">{option.label}</span>
                {option.hint && <span className="menu-item-hint">{option.hint}</span>}
              </span>
              {active && <span className="menu-check" aria-hidden="true">✓</span>}
            </button>
          )
        })}

        <div className="menu-sep" />
        <div className="menu-label">预设（岗位）</div>
        {presets.length === 0 && <div className="menu-note">当前工作区暂无可选预设</div>}
        {presets.map((preset) => {
          const active = preset.id === currentPresetId
          const badges = presetBadges(preset)
          return (
            <button
              key={`${preset.scope}:${preset.id}`}
              className={`menu-item ${active ? 'active' : ''}`}
              role="menuitemradio"
              aria-checked={active}
              disabled={locked}
              onClick={() => onPickPreset(preset.id)}
            >
              <span className="menu-item-text">
                <span className="menu-item-label">{preset.name}</span>
                <span className="menu-item-hint">
                  {[preset.description, ...badges].filter(Boolean).join(' · ')}
                </span>
              </span>
              {active && <span className="menu-check" aria-hidden="true">✓</span>}
            </button>
          )
        })}
        <button className="menu-item" onClick={onManagePresets}>
          <span className="menu-item-text">
            <span className="menu-item-label">管理预设…</span>
            <span className="menu-item-hint">新建 / 复制 / 编辑 / 设为默认</span>
          </span>
        </button>
      </div>
    </>
  )
}

/** 顶栏那颗 chip 的文案：`预设 · Sonnet 4.5 · 高`；会话没绑预设时提醒先选。 */
export function describeSessionModel(
  currentModelId: string | undefined,
  models: ModelOption[],
  strength: StrengthState,
  preset?: WebPreset | null,
  presetRequired = false,
): string {
  const parts: string[] = []
  if (preset?.name) parts.push(preset.name)
  else if (presetRequired) parts.push('选择预设')
  const name = modelLabelFor(currentModelId, models)
  if (name) parts.push(name)
  if (strength.label) parts.push(strength.label)
  return parts.length > 0 ? parts.join(' · ') : '设置会话'
}
