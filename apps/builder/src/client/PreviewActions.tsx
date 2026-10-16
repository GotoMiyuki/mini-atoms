import {useRef} from 'react';

type Tab='preview'|'source'|'log';
export function PreviewActions({tab,onTab,available,immersive,onImmersive}:{tab:Tab;onTab:(tab:Tab)=>void;available:boolean;immersive:boolean;onImmersive:()=>void}){
  const menu=useRef<HTMLDetailsElement>(null);
  const choose=(next:Tab)=>{onTab(next);if(menu.current)menu.current.open=false;};
  return <><div className="view-tabs desktop-preview-tabs">{(['preview','source','log'] as const).map(t=><button key={t} className={tab===t?'active':''} onClick={()=>onTab(t)}>{t==='preview'?'预览':t==='source'?'源码':'构建日志'}</button>)}</div>
    <div className="mobile-preview-tools">
      {tab==='preview'?<button type="button" data-testid="preview-immersive" aria-pressed={immersive} disabled={!available} onClick={onImmersive}>{immersive?'返回工作台':'沉浸预览'}</button>:<button type="button" onClick={()=>choose('preview')}>返回预览</button>}
      {!immersive&&<details className="preview-more" ref={menu}><summary>更多</summary><div className="preview-more-menu"><button type="button" aria-pressed={tab==='preview'} onClick={()=>choose('preview')}>查看预览</button><button type="button" aria-pressed={tab==='source'} onClick={()=>choose('source')}>查看源码</button><button type="button" aria-pressed={tab==='log'} onClick={()=>choose('log')}>构建日志</button></div></details>}
    </div>
  </>;
}
