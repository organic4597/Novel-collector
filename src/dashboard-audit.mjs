const roots=new Set(["session","login","logout","status","settings","jobs","books","discover","updates","extraction-presets","site-accounts","site-browser","captcha-session","downloads","activity","dashboard-log","preferences","password"]);
const actions=new Set(["status","check","apply","open","close","input","frame","retry","retry_failed","pause","resume","cancel","queue","start","stop","events","chapters","metadata","overview","cover","export","exports","download","download-all","batch","test","snapshot","progress"]);
export function dashboardRoute(path){
  const parts=path.split("/").filter(Boolean);if(parts[0]!=="api"||!roots.has(parts[1]))return"/api/unknown";
  return"/api/"+parts.slice(1).map((p,i)=>i===0||actions.has(p)?p:":id").join("/");
}
export function clientEvents(input){
  if(!input||Object.keys(input).some(k=>k!=="events")||!Array.isArray(input.events)||input.events.length>20)throw Object.assign(Error("대시보드 로그 입력을 확인하세요."),{status:400});
  return input.events.map(event=>{
    if(!event||typeof event!=="object"||Object.keys(event).some(k=>!["kind","level","message","element"].includes(k))||!["action","navigation","console","error","resource","rejection"].includes(event.kind)||typeof event.message!=="string"||event.message.length>4000)throw Object.assign(Error("대시보드 이벤트 형식을 확인하세요."),{status:400});
    return{scope:"dashboard",level:["debug","info","warn","error"].includes(event.level)?event.level:"info",message:event.message,details:{action:event.kind,...(typeof event.element==="string"&&/^[\w-]{1,80}$/.test(event.element)?{component:event.element}:{})}};
  });
}
