import {updateChannel} from './update-channels.mjs';
export function createUpdatesRouter({updates,activity}){
  return async({request,response,url,send,readBody})=>{
    if(!url.pathname.startsWith("/api/updates/"))return false;const name=url.pathname.slice("/api/updates/".length);
    if(!((request.method==="GET"&&["status","log","history"].includes(name))||(request.method==="POST"&&["check","apply"].includes(name))))return false;
    if(!updates)throw Object.assign(new Error("업데이트 기능을 사용할 수 없습니다."),{status:503});
    if(name==="history"){send(response,200,updates.history());return true;}
    if(name==="log"){
      const after=Number(url.searchParams.get("after")||0);
      if(!Number.isSafeInteger(after)||after<0)throw Object.assign(Error("로그 조회 범위를 확인하세요."),{status:400});
      if(activity?.externalPath)await activity.syncExternal?.(activity.externalPath);
      send(response,200,activity?.query({after,scope:"update",limit:100})||{items:[],latestId:0,hasMore:false});return true;
    }
    const input=request.method==="POST"?await readBody(request):{};
    const fields=name==='apply'?['version','channel','commit']:name==='check'?['channel']:[];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))throw Object.assign(new Error("업데이트 입력을 확인하세요."),{status:400});
    const channel=updateChannel(input.channel??url.searchParams.get('channel')??'stable');
    if(name==='apply'&&(typeof input.version!=='string'||channel!=='stable'&&!/^[a-f0-9]{40}$/.test(input.commit||'')||channel==='stable'&&input.commit!=null))throw Object.assign(new Error("업데이트 버전과 패치를 확인하세요."),{status:400});
    let result;
    try{result=name==="status"?await updates.status({channel}):name==="check"?await updates.check({force:true,channel}):await updates.apply({...input,channel});}
    catch(error){
      if(name==="apply")activity?.add({scope:"update",level:"error",message:"업데이트 요청 실패: "+error.message,
        details:{step:error.step||"REQUEST_APPLY",errorCode:error.errorCode||error.code,status:error.status||500}});
      throw error;
    }
    send(response,name==="apply"?202:200,result);return true;
  };
}
