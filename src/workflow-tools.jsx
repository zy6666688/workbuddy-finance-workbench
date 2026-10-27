import React from 'react'
import { BRIEF_FIELDS } from './workflow-tools.js'

export function TaskBrief({ value, onChange }) {
  return <section className="wbPro_brief" aria-label="填写本次任务要求">
    <header><div><small>TASK BRIEF · 任务准备</small><h3>把这次要做的事，说清楚</h3><p>选填即可。填写内容同步到完整提示词；准备好后带入对话，由你确认发送。</p></div><button type="button" onClick={() => onChange({})}>清空填写</button></header>
    <div className="wbPro_briefGrid">{BRIEF_FIELDS.map(([key, label, placeholder]) => <label key={key} className={key === 'goal' || key === 'requirements' ? 'is-wide' : ''}>{label}{key === 'requirements' ? <textarea aria-label={label} value={value[key] || ''} maxLength={2000} placeholder={placeholder} onChange={event => onChange({ ...value, [key]: event.target.value })}/> : <input aria-label={label} value={value[key] || ''} maxLength={500} placeholder={placeholder} onChange={event => onChange({ ...value, [key]: event.target.value })}/>}</label>)}</div>
    <footer>仅用于本次任务 · 原始文件保持不变 · 切换工作流后清空填写</footer>
  </section>
}
export function WorkflowFilter({ value, onChange }) {
  return <div className="wbPro_filters" role="group" aria-label="工作流筛选">{[['all', '全部场景'], ['favorites', '我的收藏'], ['recent', '最近查看']].map(([key, label]) => <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>{label}</button>)}</div>
}
export function WorkbenchPolish() {
  return null
}
export { WORKBENCH_POLISH_CSS } from './workflow-tools-styles.js'
