export function createUpdatesRouter({updates}){
  return async({request,response,url,send,readBody})=>{
    if(!url.pathname.startsWith("/api/updates/"))return false;const name=url.pathname.slice("/api/updates/".length);
    if(!((request.method==="GET"&&name==="status")||(request.method==="POST"&&["check","apply"].includes(name))))return false;
    if(!updates)throw Object.assign(new Error("업데이트 기능을 사용할 수 없습니다."),{status:503});
    const input=request.method==="POST"?await readBody(request):{};
    if(Object.keys(input).some(k=>name!=="apply"||k!=="version"))throw Object.assign(new Error("업데이트 입력을 확인하세요."),{status:400});
    const result=name==="status"?await updates.status():name==="check"?await updates.check({force:true}):await updates.apply(input.version);
    send(response,name==="apply"?202:200,result);return true;
  };
}
