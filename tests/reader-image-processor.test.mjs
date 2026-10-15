import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { renderViewerImage } from "../src/reader-image-processor.mjs";
import { webtoonImageInfo } from "../src/webtoon-images.mjs";

const exec=promisify(execFile),python=process.env.CAPTCHA_PYTHON||fileURLToPath(new URL(process.platform==="win32"?"../.venv-captcha/Scripts/python.exe":"../.venv-captcha/bin/python",import.meta.url));
async function fixture(t,extension=".png"){
  const root=await mkdtemp(join(tmpdir(),"reader-processor-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"source"+extension),directory=join(root,"parts");await mkdir(directory);
  await exec(python,["-c",`import cv2,numpy as np,sys
cv2.setNumThreads(1)
im=np.full((4101,1600,3),255,np.uint8)
for y in range(50,4100,100):
 cv2.putText(im,'Readable text 0123456789',(30,y),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),2)
 cv2.line(im,(0,y+10),(1599,y+10),(80,120,160),1)
cv2.imencode(sys.argv[2],im)[1].tofile(sys.argv[1])`,source,extension]);
  const bytes=await readFile(source),image=webtoonImageInfo(bytes);
  return{source,directory,image,geometry:{width:1280,height:3281,parts:[{width:1280,height:2048},{width:1280,height:1233}]}};
}
for(const extension of [".png",".jpg"])test(`the real ${extension} processor preserves every resized row across tile boundaries and readable strokes`,async t=>{
  const input=await fixture(t,extension),original=await readFile(input.source);
  const parts=await renderViewerImage(input);
  assert.deepEqual(parts.map(p=>[p.width,p.height]),[[1280,2048],[1280,1233]]);
  for(const part of parts){const bytes=await readFile(join(input.directory,part.filename));assert.equal(createHash("sha256").update(bytes).digest("hex"),part.sha256);assert.equal(webtoonImageInfo(bytes).height,part.height);}
  const {stdout}=await exec(python,["-c",`import cv2,numpy as np,sys,json,os
cv2.setNumThreads(1)
source=cv2.imdecode(np.fromfile(sys.argv[1],np.uint8),cv2.IMREAD_UNCHANGED)
expected=cv2.resize(source,(1280,3281),interpolation=cv2.INTER_AREA)
actual=np.concatenate([cv2.imdecode(np.fromfile(os.path.join(sys.argv[2],str(i)+'.webp'),np.uint8),cv2.IMREAD_UNCHANGED) for i in [1,2]])
print(json.dumps({'psnr':cv2.PSNR(expected,actual),'rows':actual.shape[0]}))`,input.source,input.directory]);
  const measured=JSON.parse(stdout);assert.equal(measured.rows,3281);assert.ok(measured.psnr>35,`lossy text fixture PSNR ${measured.psnr}`);
  assert.deepEqual(await readFile(input.source),original);
});
test("the processor rejects wrong source hashes and pre-aborted work",async t=>{
  const input=await fixture(t);
  await assert.rejects(renderViewerImage({...input,image:{...input.image,sha256:"0".repeat(64)}}));
  const controller=new AbortController();controller.abort();
  await assert.rejects(renderViewerImage(input,{signal:controller.signal}));
});
