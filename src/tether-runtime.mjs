import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {homedir} from "node:os";
import {join} from "node:path";
import {CollectionNetwork} from "./collection-network.mjs";
import {CollectionTransport} from "./collection-transport.mjs";
import {TetherControl} from "./tether-control.mjs";

const execute=promisify(execFile);
const failure=(code,message)=>Object.assign(new Error(message),{code,status:503});

export function createTetherRuntime({store,rootDir,onChange=()=>{},env=process.env,run=execute}) {
  const enabled=env.NC_COLLECTION_TETHER==="1";
  const childEnv={...env};
  const cancellation=new AbortController();
  const control=enabled&&env.NC_TETHER_CONTROL_SOCKET?new TetherControl({socketPath:env.NC_TETHER_CONTROL_SOCKET}):null;
  const serial=env.NC_TETHER_PHONE_SERIAL||"";
  const python=env.NC_TETHER_PYTHON||join(homedir(),".hermes","android_agent",".venv","bin","python");
  async function command(file,args,timeout=90000){
    if(!/^[A-Za-z0-9_.:-]{1,80}$/.test(serial))throw failure("TETHER_PHONE_REQUIRED","테더링 휴대전화의 USB 식별자를 서버에 설정하세요.");
    let result;
    try{result=await run(file,args,{env:childEnv,timeout,maxBuffer:65536,windowsHide:true,signal:cancellation.signal});}
    catch(error){
      let parsed;try{parsed=JSON.parse(error.stdout);}catch{}
      const code=typeof parsed?.code==="string"&&/^[A-Z0-9_]{1,80}$/.test(parsed.code)?parsed.code:"TETHER_CONTROL_FAILED";
      throw failure(code,`테더링 연결 제어에 실패했습니다 (${code}). 서버의 연결 상태를 확인하세요.`);
    }
    let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw failure("TETHER_CONTROL_RESPONSE","테더링 제어 응답 형식을 확인할 수 없습니다.");}
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||parsed.ok===false)throw failure("TETHER_CONTROL_RESPONSE","테더링 제어 결과를 확인할 수 없습니다.");
    return parsed;
  }
  const host=action=>control?control.callHost(action):command(process.execPath,[join(rootDir,"src","tether-host.mjs"),action],120000);
  const phone=action=>control?control.callPhone(action):command(python,[join(rootDir,"src","hermes-tether.py"),action],1900000);
  const probe=async()=>{
    const route=await host("status");if(!route.ready)return{ready:false};
    const device=await phone("status");
    return{ready:device.usbConnected===true&&device.tethering===true&&device.cellular===true&&device.validated===true};
  };
  let transport;
  const network=new CollectionNetwork({enabled,store,pollMs:5000,probe,connect:()=>host("connect"),
    phone:async action=>{
      const epoch=network.epoch;
      const current=()=>{if(network.closed||network.epoch!==epoch)throw failure("TETHER_CONTROL_CANCELLED","테더링 연결 작업이 중단됐습니다.");};
      current();
      if(action==="on"){
        const prepared=await host("prepare");current();
        if(prepared.prepared!==true)throw failure("TETHER_PREPARE_REQUIRED","휴대전화 전용 네트워크 보호 설정을 확인할 수 없습니다.");
      }
      const state=await phone(action);
      if(typeof state.tethering!=="boolean")throw failure("TETHER_PHONE_STATE","휴대전화의 테더링 상태를 확인할 수 없습니다.");
      return{enabled:state.tethering};
    },
    onChange:async state=>{if(state.active)transport?.disconnect();await onChange(state);},
  });
  transport=new CollectionTransport({network,...(env.NC_TETHER_PROXY_SOCKET?{socketPath:env.NC_TETHER_PROXY_SOCKET}:{})});
  return{network,transport,close:async()=>{network.close();cancellation.abort();control?.close();await transport.close();}};
}
