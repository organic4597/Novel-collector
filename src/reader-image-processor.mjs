import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultPython=fileURLToPath(new URL(process.platform==="win32"?"../.venv-captcha/Scripts/python.exe":"../.venv-captcha/bin/python",import.meta.url));
// Bundled as managed source so existing updaters can install it in one transaction.
const worker=String.raw`
import sys,json,hashlib,math,os
from pathlib import Path
try:
 import cv2,numpy as np
 cv2.setNumThreads(1)
 job=json.load(sys.stdin)
 source=Path(job['source']); meta=job['image']; g=job['geometry']
 if source.stat().st_size>8*1024**2: raise ValueError('LIMIT')
 raw=source.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=meta['sha256']: raise ValueError('SOURCE_MISMATCH')
 w,h=meta['width'],meta['height']
 if not(0<w and 0<h and w*h<=100000000): raise ValueError('LIMIT')
 if g['width']!=min(w,1280) or g['height']!=math.floor(h*g['width']/w+0.5): raise ValueError('LIMIT')
 image=cv2.imdecode(np.frombuffer(raw,np.uint8),cv2.IMREAD_UNCHANGED)
 if image is None or image.dtype!=np.uint8: raise ValueError('UNSUPPORTED')
 if image.shape[:2]!=(h,w): raise ValueError('SOURCE_MISMATCH')
 if (w,h)!=(g['width'],g['height']):
  image=cv2.resize(image,(g['width'],g['height']),interpolation=cv2.INTER_AREA)
 output=[]; total=0
 for i,top in enumerate(range(0,g['height'],2048)):
  ok,encoded=cv2.imencode('.webp',image[top:top+2048],[cv2.IMWRITE_WEBP_QUALITY,90])
  if not ok: raise ValueError('UNSUPPORTED')
  raw=encoded.tobytes(); total+=len(raw)
  if total>32*1024**2 or i>=128: raise ValueError('LIMIT')
  name=str(i+1)+'.webp'
  fd=os.open(str(Path(job['directory'])/name),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as file: file.write(raw)
  output.append({'filename':name,'width':g['width'],'height':min(2048,g['height']-top),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
 print(json.dumps(output))
except Exception as error:
 code=str(error) if str(error) in ['LIMIT','UNSUPPORTED','SOURCE_MISMATCH'] else 'FAILED'
 print(json.dumps({'error':code}))
 sys.exit(1)
`;
const failed=code=>Object.assign(new Error("보기용 이미지를 준비할 수 없습니다. 원본으로 다시 시도하세요."),{code,status:code==="VIEWER_SOURCE_MISMATCH"?409:503});
export function renderViewerImage(input,{signal,python=process.env.CAPTCHA_PYTHON||defaultPython}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(failed("VIEWER_CANCELLED"));
    const child=spawn(python,["-c",worker],{windowsHide:true,stdio:["pipe","pipe","ignore"],env:{...process.env,PYTHONUTF8:"1",OPENBLAS_NUM_THREADS:"1",OMP_NUM_THREADS:"1",OPENCV_IO_MAX_IMAGE_PIXELS:"100000000"}});
    let output="",problem=null;
    const stop=code=>{problem??=failed(code);child.kill("SIGKILL");};
    const abort=()=>stop("VIEWER_CANCELLED");
    signal?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(()=>stop("VIEWER_TIMEOUT"),20000);
    child.on("error",()=>{problem??=failed("VIEWER_RUNTIME_UNAVAILABLE");});
    child.stdin.on("error",()=>{problem??=failed("VIEWER_GENERATION_FAILED");});
    child.stdout.on("data",chunk=>{output+=chunk;if(output.length>256*1024)stop("VIEWER_OUTPUT_LIMIT");});
    child.on("close",code=>{
      clearTimeout(timer);signal?.removeEventListener("abort",abort);
      if(problem)return reject(problem);
      try{const data=JSON.parse(output);if(code!==0||!Array.isArray(data))throw failed(data.error==="SOURCE_MISMATCH"?"VIEWER_SOURCE_MISMATCH":"VIEWER_GENERATION_FAILED");resolve(data);}
      catch(error){reject(error.code?error:failed("VIEWER_GENERATION_FAILED"));}
    });
    child.stdin.end(JSON.stringify(input));
    if(signal?.aborted)abort();
  });
}
