import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const modulePath=fileURLToPath(new URL('../src/hermes-tether.py',import.meta.url));
const python=process.env.CAPTCHA_PYTHON||'python3';
const common=String.raw`
import importlib.util,json,sys
from contextlib import contextmanager
s=importlib.util.spec_from_file_location('tether',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Fake:
 def __init__(self):
  self.state={'usbConnected':True,'hardwareMatches':True,'bridgeReverseBound':True,'companionVersion':'0.8.12','usbFunctionActive':False,'usbTethered':False,'cellular':True,'validated':True,'locked':True};self.jobs=[];self.active=False;self.now=0;self.calls=[];self.device='phone-id';self.in_call=False;self.mobile=True;self.actual=True;self.denied=False;self.reenumerate=False;self.repairs=0;self.original='mtp'
 def phone(self):return {**self.state,'tethering':self.state['usbFunctionActive'] and self.state['usbTethered']}
 def status(self):return 200,{'payload':{'session':{'active':{} if self.in_call else None},'bridge_state':{'last_heartbeat':{'device_id':self.device,'payload':{'app_ver':'hermes_mobile_agent-0.8.12','in_call':self.in_call}}}}}
 def cmd(self,*a,**k):raise AssertionError('No UI commands allowed')
 @contextmanager
 def phone_task(self,owner,*,timeout_s,ttl_seconds,strict):
  assert timeout_s==1800 and ttl_seconds==60 and strict is True and not self.active;self.active=True;self.jobs.append(('start',owner))
  try:yield self
  except BaseException:self.jobs.append(('failed',owner));raise
  finally:self.active=False;self.jobs.append(('end',owner))
 def capture_original(self,tethering=False):assert self.active;return self.original
 def wifi_off(self):
  assert self.active;self.calls.append(('wifi','disable'))
  if self.denied:raise m.TetherError('PHONE_NETWORK_API_DENIED')
  self.state.update(cellular=self.mobile,validated=self.mobile)
 def set_usb(self,value):
  assert self.active;self.calls.append(('usb',value))
  if self.denied:raise m.TetherError('PHONE_NETWORK_API_DENIED')
  self.state.update(usbFunctionActive=value=='rndis',usbTethered=value=='rndis' and self.actual)
  if self.reenumerate:self.state['bridgeReverseBound']=False
 def repair(self):
  assert self.active
  if not self.state['bridgeReverseBound']:self.state['bridgeReverseBound']=True;self.repairs+=1
 def clock(self):return self.now
 def sleep(self,t):self.now+=t
 def adapter(self):return m.HermesTether(self,self.phone,self,expected_device_id='phone-id',reverse_repair=self.repair,clock=self.clock,sleep=self.sleep)
`;
function run(code){const r=spawnSync(python,['-c',common+'\n'+code,modulePath],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr||r.stdout);}
test('status and already-desired states are read-only, with Android OS backend',()=>run(`f=Fake();assert f.adapter().run('status')['backend']=='android-usb-api';f.phone_task=None;assert not f.adapter().run('off')['tethering'];f.state.update(usbFunctionActive=True,usbTethered=True);assert f.adapter().run('on')['tethering'];assert not f.jobs and not f.calls`));
test('locked phone can use authorized network APIs under one strict job, without UI',()=>run(`f=Fake();f.state.update(cellular=False,validated=False);r=f.adapter().run('on');assert r['tethering'] and r['cellular'] and r['wifiChanged'] and r['locked'];assert f.calls==[('wifi','disable'),('usb','rndis')];assert f.jobs==[('start','novel:tether-on'),('end','novel:tether-on')]`));
test('active call and missing cellular validation prevent USB change',()=>run(`f=Fake();f.in_call=True;f.state.update(cellular=False,validated=False)
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='PHONE_BUSY'
assert not f.calls
f=Fake();f.mobile=False;f.state.update(cellular=False,validated=False)
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='PHONE_CELLULAR_REQUIRED'
assert f.calls==[('wifi','disable')] and not f.active`));
test('off restores original pure USB function and clears partial configurations',()=>run(`f=Fake();f.original='ptp';f.state.update(usbFunctionActive=True,usbTethered=False);r=f.adapter().run('off');assert not r['usbFunctionActive'] and not r['usbTethered'];assert f.calls==[('usb','ptp')];assert f.jobs==[('start','novel:tether-off'),('end','novel:tether-off')]`));
test('API denial and incomplete Android tethering fail closed and release job',()=>run(`
for denied,actual,code in [(True,True,'PHONE_NETWORK_API_DENIED'),(False,False,'PHONE_TETHER_VERIFY_FAILED')]:
 f=Fake();f.denied=denied;f.actual=actual
 try:f.adapter().run('on');assert False
 except m.TetherError as e:assert e.code==code
 assert len(f.calls)==1 and not f.active and f.jobs[-2:]==[('failed','novel:tether-on'),('end','novel:tether-on')]`));
test('missing queue SDK, identity and physical binding never issue network changes',()=>run(`
for field,value,code in [('phone_task',None,'HERMES_TASK_QUEUE_REQUIRED'),('device','other','HERMES_DEVICE_PIN_MISMATCH')]:
 f=Fake();setattr(f,field,value)
 try:f.adapter().run('on');assert False
 except m.TetherError as e:assert e.code==code
 assert not f.calls
f=Fake();f.state['hardwareMatches']=False
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='PHONE_DEVICE_BINDING_UNVERIFIED'
assert not f.jobs and not f.calls`));
test('USB reverse is repaired only during the owned mode transition',()=>run(`f=Fake();f.reenumerate=True;assert f.adapter().run('on')['tethering'];assert f.repairs==1 and not f.active`));
test('live Android tether parser excludes historical entries and errors',()=>run(String.raw`assert m.parse_usb_tethered('  rndis0 - TetheredState - lastError=0\n');assert m.parse_usb_tethered('ncm0 - TetheredState - lastError=0')
for text in ['2026-11-09 - [rndis0] TetheredState lastError=0','rndis0 - TetheredState - lastError=5','wlan0 - TetheredState - lastError=0','rndis0 - AvailableState - lastError=0']:assert not m.parse_usb_tethered(text)`));
test('only fixed network APIs are allowed and getFunctions reads real stderr format',()=>run(`import subprocess
calls=[]
def process(args,**kw):calls.append(tuple(args));return subprocess.CompletedProcess(args,0,stdout='',stderr='mtp')
m.subprocess.run=process;api=m.AndroidUsbApi('phone');assert api.get_function()=='mtp';api.wifi_off();api.set_usb('rndis');api.set_usb('mtp')
assert calls==[('adb','-s','phone','shell','svc','usb','getFunctions'),('adb','-s','phone','shell','svc','wifi','disable'),('adb','-s','phone','shell','svc','usb','setFunctions','rndis'),('adb','-s','phone','shell','svc','usb','setFunctions','mtp')]
for bad in ['rndis,adb','mtp;reboot','adb','ncm','unknown']:
 try:api.set_usb(bad);assert False
 except m.TetherError as e:assert e.code=='PHONE_USB_FUNCTION_INVALID'
assert len(calls)==4`));
test('original pure USB state is private, persistent and rejects malformed combinations',{skip:process.platform==='win32'},()=>run(`import tempfile,pathlib,os
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);os.chmod(p,0o700);store=m.UsbFunctionStore(p/'original');assert store.read() is None;assert store.save('ptp')=='ptp';assert m.UsbFunctionStore(p/'original').read()=='ptp';assert (p/'original').stat().st_mode&0o777==0o600
 (p/'original').write_text('mtp,adb')
 try:store.read();assert False
 except m.TetherError as e:assert e.code=='PHONE_USB_ORIGINAL_INVALID'
 for bad in ['rndis','ncm','adb','mtp;reboot']:
  try:store.save(bad);assert False
  except m.TetherError as e:assert e.code=='PHONE_USB_ORIGINAL_INVALID'`));
test('OS lock and reverse restoration reject unsafe or conflicting state',{skip:process.platform==='win32'},()=>run(String.raw`import tempfile,pathlib,os
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);os.chmod(p,0o700)
 with m.phone_lock(p):
  try:
   with m.phone_lock(p):assert False
  except m.TetherError as e:assert e.code=='PHONE_CONTROL_BUSY'
def adb(*a):
 if a==('devices','-l'):return 'phone device usb:3-3 product:x'
 if a[:3]==('shell','getprop','ro.serialno'):return 'phone'
 if a==('reverse','--list'):return 'UsbFfs tcp:18750 tcp:9999'
 raise AssertionError('must not mutate conflicting reverse')
try:m.restore_reverse('phone',18750,previously_bound=True,adb=adb);assert False
except m.TetherError as e:assert e.code=='PHONE_REVERSE_BINDING_CONFLICT'`));
test('CLI SIGTERM emits one sanitized JSON and releases both locks',()=>run(`import types,tempfile,pathlib,os,signal,io,contextlib
f=Fake();locks=[]
@contextmanager
def lock():
 locks.append('enter')
 try:yield
 finally:locks.append('exit')
def cancel(value):signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
f.set_usb=cancel
b=types.ModuleType('shared.bridge_client');b.BridgeClient=lambda **kw:f;b.load_bridge_config=lambda:{'phone':{'device_id_expect':'phone-id'}};sys.modules['shared']=types.ModuleType('shared');sys.modules['shared.bridge_client']=b
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);(p/'shared').mkdir();(p/'shared/bridge_client.py').touch();os.environ['NC_HERMES_ROOT']=d;os.environ['NC_TETHER_PHONE_SERIAL']='phone';m.phone_lock=lock;m.read_phone=lambda *a:f.phone();m.AndroidUsbApi=lambda *a,**kw:f
 previous=signal.getsignal(signal.SIGTERM);out=io.StringIO()
 with contextlib.redirect_stdout(out):code=m.main(['on'])
 assert code==1 and json.loads(out.getvalue())['code']=='PHONE_CONTROL_CANCELLED';assert len(out.getvalue().splitlines())==1 and signal.getsignal(signal.SIGTERM)==previous;assert locks==['enter','exit'] and not f.active and f.jobs[-2:]==[('failed','novel:tether-on'),('end','novel:tether-on')]`));
