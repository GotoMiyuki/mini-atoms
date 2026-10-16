import {AppError} from '../shared/contracts.ts';
export function configuredOrigin(value:string|undefined,port:number){
  if(!value)return `http://127.0.0.1:${port}`;
  let url:URL;try{url=new URL(value);}catch{throw new AppError('PUBLIC_ORIGIN','公开来源必须是唯一、规范的 HTTPS Origin',503);}
  if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value.includes('*')||/[\s\x00-\x1f]/.test(value)||!url.hostname)throw new AppError('PUBLIC_ORIGIN','公开来源必须是唯一、规范的 HTTPS Origin，不能含路径、凭据或通配符',503);
  return value;
}
