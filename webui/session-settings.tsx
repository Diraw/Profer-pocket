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

export interface SessionSettingsMenuProps {
  models: ModelOption[]
  currentModelId: string | undefined
  strength: StrengthState
  /** 会话正在跑：模型与档位都不接受修改 */
  running: boolean
  busy: boolean
  onPickModel: (option: ModelOption) => void
  onPickStrength: (value: string) => void
  onClose: () => void
}

export function SessionSettingsMenu({
  models, currentModelId, strength, running, busy, onPickModel, onPickStrength, onClose,
}: SessionSettingsMenuProps): React.ReactElement {
  const groups = groupModelsByChannel(models)
  const singleChannel = groups.length <= 1
  const locked = running || busy

  return (
    <>
      <div className="menu-scrim" onClick={onClose} />
      <div className="menu wide" role="menu" aria-label="模型与推理强度">
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
      </div>
    </>
  )
}

/** 顶栏那颗 chip 的文案：`Sonnet 4.5 · 高`。 */
export function describeSessionModel(currentModelId: string | undefined, models: ModelOption[], strength: StrengthState): string {
  const name = modelLabelFor(currentModelId, models)
  const parts = [name, strength.label].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '选择模型'
}
