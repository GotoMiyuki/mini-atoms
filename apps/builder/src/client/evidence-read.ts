// Bounded read-only polling. Mutations/verification/model requests never retry.
export function readUntilSettled<T>({load,receive,active,failed,signal,interval=1000,retries=3,maxReads=240}:{load:()=>Promise<T>;receive:(v:T)=>void;active:(v:T)=>boolean;failed:(message:string)=>void;signal:AbortSignal;interval?:number;retries?:number;maxReads?:number}){
 let timer:ReturnType<typeof setTimeout>|undefined,failures=0,reads=0;
 const stop=()=>clearTimeout(timer);signal.addEventListener('abort',stop,{once:true});
 async function next(){if(signal.aborted)return;if(++reads>maxReads){failed('已达到本次状态读取上限；任务状态未被修改，可点击“重新读取”。');signal.removeEventListener('abort',stop);return;}try{const value=await load();if(signal.aborted)return;failures=0;receive(value);if(active(value))timer=setTimeout(()=>void next(),interval);else signal.removeEventListener('abort',stop);}catch(e:any){if(signal.aborted)return;failures++;if(failures<=retries){failed(`读取暂时失败，正在有限重试（${failures}/${retries}）。`);timer=setTimeout(()=>void next(),interval*2**(failures-1));}else{failed(e.message+'；已停止自动重试，可点击“重新读取”。');signal.removeEventListener('abort',stop);}}}
 void next();return stop;
}
export function displayText(value:unknown){return String(value??'记录未提供').replace(/\b[A-Za-z]:[\\/][^\s"'<>，。]+/g,'[内部路径已隐藏]').replace(/\/(?:home|root|tmp|var|etc|workspace|app)\/[^\s"'<>，。]+/g,'[内部路径已隐藏]');}
