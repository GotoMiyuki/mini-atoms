import type {Requirement} from '../shared/contracts.ts';

export function RequirementEditor({requirement:r,mobile,expanded,onToggle,onChange,onTargetsChange}:{requirement:Requirement;mobile:boolean;expanded:boolean;onToggle:()=>void;onChange:(key:keyof Requirement,value:string)=>void;onTargetsChange:(value:string)=>void}){
  return <article className="requirement-editor">
    <button type="button" className="requirement-toggle" data-testid={`requirement-toggle-${r.id}`} aria-expanded={expanded} aria-controls={`requirement-fields-${r.id}`} onClick={onToggle}>
      <span className="requirement-summary"><span className="tiny-label">{r.id} · {r.priority==='MUST'?'必须':'建议'}</span><strong>{r.text||'未填写需求'}</strong><span className="requirement-preview">{r.acceptance||'点击补充验收条件'}</span></span><span className="requirement-expand" aria-hidden="true">{expanded?'−':'＋'}</span>
    </button>
    <div className="requirement-fields" id={`requirement-fields-${r.id}`} hidden={mobile&&!expanded}>
      <div className="requirement-meta"><span>{r.id}</span><select aria-label={`${r.id} 优先级`} value={r.priority} onChange={e=>onChange('priority',e.target.value)}><option value="MUST">必须</option><option value="SHOULD">建议</option></select></div>
      <input aria-label={`${r.id} 需求`} value={r.text} onChange={e=>onChange('text',e.target.value)}/>
      <textarea aria-label={`${r.id} 验收条件`} value={r.acceptance} onChange={e=>onChange('acceptance',e.target.value)} rows={2}/>
      <select aria-label={`${r.id} 验证方式`} value={r.verificationMode} onChange={e=>onChange('verificationMode',e.target.value)}><option value="AUTOMATED">自动验证意图 · 覆盖另行规划</option><option value="MANUAL">需人工确认</option><option value="UNSUPPORTED">当前不支持</option></select>
      <details className="target-editor"><summary>定位约定 · 修改需保存新版本</summary><input aria-label={`${r.id} 定位标识`} value={(r.targetHints||[]).join(',')} onChange={e=>onTargetsChange(e.target.value)}/></details>
    </div>
  </article>;
}
