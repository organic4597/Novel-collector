import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const modulePath=fileURLToPath(new URL('../src/hermes-tether.py',import.meta.url));
const python=process.env.CAPTCHA_PYTHON||'python3';
const common=String.raw`
import importlib.util,json,sys
from contextlib import contextmanager
spec=importlib.util.spec_from_file_location('hermes_tether',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def screen(label,checked):
 return {'package':'com.android.settings','foregroundPackage':'com.android.settings','truncated':False,'nodes':[
  {'id':0,'parent':None,'text':None,'enabled':True,'checkable':False},
  {'id':1,'parent':0,'text':label,'enabled':True,'checkable':False},
  {'id':2,'parent':0,'text':None,'enabled':True,'checkable':True,'checked':checked,'class_name':'android.widget.Switch','bounds':[100,200,200,300]}]}
class Fake:
 def __init__(self):
  self.state={'usbConnected':True,'hardwareMatches':True,'bridgeReverseBound':True,'companionVersion':'0.8.11','tethering':False,'cellular':True,'validated':True,'locked':False};self.now=0;self.calls=[];self.all_calls=[];self.pending=None;self.checked=False;self.wifi=True;self.action='';self.deny=False;self.stale=False;self.bridge_code=200;self.device='test-phone';self.native_guard=True;self.jobs=[];self.active=False;self.reenumerate=False;self.repairs=0;self.cancel=False
 def phone(self):return dict(self.state)
 def clock(self):return self.now
 def sleep(self,n):self.now+=n
 def authorize(self):
  if self.deny:raise m.TetherError('HERMES_POLICY_DENIED')
 @contextmanager
 def phone_task(self,owner,*,timeout_s,ttl_seconds,strict):
  assert timeout_s==1800 and ttl_seconds==60 and strict is True
  assert not self.active;self.jobs.append(('start',owner));self.active=True
  try:yield self
  except BaseException:self.jobs.append(('failed',owner));raise
  finally:self.active=False;self.jobs.append(('end',owner))
 def repair(self):
  assert self.active
  if not self.state['bridgeReverseBound']:self.state['bridgeReverseBound']=True;self.repairs+=1
 def status(self):return self.bridge_code,{'payload':{'bridge_state':{'last_cmd_result':self.pending,'last_heartbeat':{'device_id':self.device,'payload':{'app_ver':'hermes_mobile_agent-0.8.11','capabilities':{'touch':{'expected_package_guard':self.native_guard}}}}}}}
 def ui(self):return screen('Wi-Fi' if self.action=='android.settings.WIFI_SETTINGS' else 'USB 테더링',self.wifi if self.action=='android.settings.WIFI_SETTINGS' else self.checked)
 def cmd(self,name,payload=None):
  assert self.active;assert name=='recipe.run';self.all_calls.append(payload)
  if any(s['op']!='ui.snapshot' for s in payload['steps']):self.calls.append(payload)
  if self.cancel:raise m.TetherError('PHONE_CONTROL_CANCELLED')
  assert payload['ensure_home'] is False and payload['cleanup_apps'] is False and payload['capture_final'] is False
  results=[]
  for step in payload['steps']:
   op=step['op'];p=step.get('with',{});detail={}
   if op=='app.launch':self.action=p['action']
   if op in ['touch.click_text','touch.tap']:
    assert p['expected_package']=='com.android.settings'
    if op=='touch.click_text':assert p['exact'] is True
    else:assert (p['x'],p['y'])==(150,250)
    if self.action=='android.settings.WIFI_SETTINGS':self.wifi=not self.wifi;self.state.update(cellular=not self.wifi,validated=not self.wifi)
    else:
     self.checked=not self.checked;self.state['tethering']=self.checked
     if self.reenumerate:self.state['bridgeReverseBound']=False
   if op=='ui.snapshot':
    assert p['expected_package']=='com.android.settings'
    detail=self.ui()
   results.append({'op':op,'ok':True,'detail':detail})
  self.pending={'device_id':self.device,'payload':{'cmd':'recipe.run','ok':True,'detail':{'run_id':'stale' if self.stale else payload['run_id'],'steps_total':len(results),'step_results':results}}}
  return 200,{'payload':{'ok':True}}
 def adapter(self):return m.HermesTether(self,self.phone,self.authorize,expected_device_id='test-phone',reverse_repair=self.repair,clock=self.clock,sleep=self.sleep)
`;
function run(code){
 const r=spawnSync(python,['-c',common+'\n'+code,modulePath],{encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr||r.stdout);
}
test('status is read-only and accepts existing authenticated bridge envelope',()=>run(`f=Fake();r=f.adapter().run('status');assert r['ok'] and not r['tethering'];assert not f.calls`));
test('on uses exact guarded Hermes clicks and verifies USB + cellular',()=>run(`f=Fake();r=f.adapter().run('on');assert r['tethering'] and r['cellular'];assert len(f.calls)==2`));
test('already-on state does not toggle off and off is idempotent',()=>run(`f=Fake();f.state['tethering']=True;f.checked=True;a=f.adapter();assert a.run('on')['tethering'];assert not f.calls;assert not a.run('off')['tethering'];n=len(f.calls);assert not a.run('off')['tethering'];assert len(f.calls)==n`));
test('prepare disables Wi-Fi through Hermes and validates cellular without enabling tether',()=>run(`f=Fake();f.state.update(cellular=False,validated=False);r=f.adapter().run('prepare');assert r['wifiChanged'] and r['cellular'] and r['validated'];assert not r['tethering'];assert all(s.get('with',{}).get('text')!='USB 테더링' for p in f.calls for s in p['steps'])`));
test('on prepares cellular and enables USB under one shared phone job',()=>run(`f=Fake();f.state.update(cellular=False,validated=False);r=f.adapter().run('on');assert r['cellular'] and r['validated'] and r['tethering'] and r['wifiChanged'];assert f.jobs==[('start','novel:tether-on'),('end','novel:tether-on')];assert len(f.calls)==4;assert not f.active`));
test('locked screen, missing USB and denied policy fail closed',()=>run(`
for changes,code in [({'locked':True},'PHONE_LOCKED'),({'locked':None},'PHONE_LOCK_STATE_UNKNOWN'),({'usbConnected':False},'PHONE_USB_REQUIRED')]:
 f=Fake();f.state.update(changes)
 try:f.adapter().run('on');assert False
 except m.TetherError as e:assert e.code==code
 assert not f.calls
f=Fake();f.deny=True
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='HERMES_POLICY_DENIED'
assert not f.calls`));
test('old command results cannot confirm a fresh operation',()=>run(`f=Fake();f.stale=True
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='HERMES_COMMAND_TIMEOUT'`));
test('a successful UI click does not substitute for USB state verification',()=>run(`f=Fake();f.phone=lambda:{**f.state,'tethering':False}
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='PHONE_TETHER_VERIFY_FAILED'`));
test('transient USB reconnect is awaited without repeating the toggle',()=>run(`f=Fake();reads=[0]
def phone():
 if f.checked and reads[0]<2:
  reads[0]+=1;raise m.TetherError('PHONE_USB_REQUIRED')
 return dict(f.state)
f.phone=phone;r=f.adapter().run('on');assert r['tethering'];assert len(f.calls)==2;assert f.now>0`));
test('ambiguous, disabled and foreign-package snapshots are rejected',()=>run(`
for kind in ['ambiguous','disabled','foreign','truncated']:
 s=screen('USB 테더링',False)
 if kind=='ambiguous':s['nodes'].append({'id':3,'parent':0,'checkable':True,'checked':False,'enabled':True,'class_name':'android.widget.Switch'})
 if kind=='disabled':s['nodes'][2]['enabled']=False
 if kind=='foreign':s['package']='com.example.other'
 if kind=='truncated':s['truncated']=True
 try:m.find_switch(s,('USB 테더링','USB tethering'));assert False
 except m.TetherError:pass`));
test('connectivity and keyguard parsers use the actual default network',()=>run(String.raw`s='Active default network: 100\nNetworkAgentInfo{network{100} ni{WIFI CONNECTED} nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED ]}\nNetworkAgentInfo{network{103} ni{MOBILE CONNECTED} nc{[ Transports: CELLULAR Capabilities: INTERNET&VALIDATED ]}'
assert m.parse_connectivity(s)=={'cellular':False,'validated':True}
assert m.parse_connectivity(s.replace('network: 100','network: 103'))=={'cellular':True,'validated':True}
assert m.parse_keyguard('KeyguardServiceDelegate\nshowing=false\nKeyguardStateMonitor\nmIsShowing=false') is False
assert m.parse_keyguard('mIsShowing=true') is True
assert m.parse_keyguard('unknown') is None`));
test('invalid actions, bridge credentials and unsafe targets cannot mutate phone',()=>run(`f=Fake();f.bridge_code=401
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='HERMES_AUTH_UNAVAILABLE'
assert not f.calls
for a in ['shell','rotate','on; reboot']:
 try:Fake().adapter().run(a);assert False
 except m.TetherError as e:assert e.code=='INVALID_ACTION'
for u in ['http://example.com:18750','http://user:pass@127.0.0.1:18750','http://127.0.0.1:18750/?token=secret']:
 try:m.validate_bridge_url(u);assert False
 except m.TetherError as e:assert e.code=='HERMES_BRIDGE_URL_INVALID'`));
test('device pin, USB binding and app version mismatch prevent all commands',()=>run(`
for key,value,code in [('hardwareMatches',False,'PHONE_DEVICE_BINDING_UNVERIFIED'),('bridgeReverseBound',False,'PHONE_DEVICE_BINDING_UNVERIFIED'),('companionVersion','other','PHONE_COMPANION_VERSION_MISMATCH')]:
 f=Fake();f.state[key]=value
 try:f.adapter().run('on');assert False
 except m.TetherError as e:assert e.code==code
 assert not f.calls
f=Fake();f.device='different-device'
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='HERMES_DEVICE_PIN_MISMATCH'
assert not f.calls`));
test('UI reads use guarded native snapshots under the same lease without ADB UI automation',()=>run(`
def no_adb(*args):raise AssertionError('UI reads must not use adb')
m._adb=no_adb
f=Fake();f.adapter().run('on')
snapshots=[s for p in f.all_calls for s in p['steps'] if s['op']=='ui.snapshot']
assert snapshots and all(s['with']=={'expected_package':'com.android.settings'} for s in snapshots)
assert f.jobs==[('start','novel:tether-on'),('end','novel:tether-on')]
f=Fake();original=f.ui
def foreign():
 s=original();s['package']='com.example.private';return s
f.ui=foreign
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='PHONE_UI_UNVERIFIED'
assert len(f.calls)==1`));
test('USB taps derive fresh verified bounds and reject missing or changed UI',()=>run(`
f=Fake();f.adapter().run('on');tap=f.calls[-1]['steps'][0];assert tap['op']=='touch.tap' and tap['with']['x']==150 and tap['with']['y']==250
for bounds in [[],[-1,0,10,10],[0,0,0,0],[10,10,5,5]]:
 f=Fake();original=f.ui
 def ui():
  s=original();s['nodes'][2]['bounds']=bounds;return s
 f.ui=ui
 try:f.adapter().run('on');assert False
 except m.TetherError as e:assert e.code=='PHONE_SWITCH_BOUNDS_UNVERIFIED'
 assert len(f.calls)==1
f=Fake();original=f.ui;reads=[0]
def changed():
 reads[0]+=1;s=original()
 if reads[0]>1:s['nodes'][2]['checked']=True
 return s
f.ui=changed
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='PHONE_UI_CHANGED'
assert len(f.calls)==1`));
test('OS phone mutation lock is exclusive, released, and rejects unsafe directories or symlinks',{skip:process.platform==='win32'},()=>run(`
import tempfile, pathlib, os
with tempfile.TemporaryDirectory() as tmp:
 p=pathlib.Path(tmp);os.chmod(p,0o700)
 with m.phone_lock(p):
  try:
   with m.phone_lock(p):assert False
  except m.TetherError as e:assert e.code=='PHONE_CONTROL_BUSY'
 with m.phone_lock(p):pass
 assert (p/'phone.lock').stat().st_mode&0o777==0o600
 (p/'phone.lock').unlink();target=p/'target';target.write_text('private');os.symlink(target,p/'phone.lock')
 try:
  with m.phone_lock(p):assert False
 except m.TetherError as e:assert e.code=='PHONE_CONTROL_LOCK_UNAVAILABLE'
 (p/'phone.lock').unlink();os.chmod(p,0o755)
 try:
  with m.phone_lock(p):assert False
 except m.TetherError as e:assert e.code=='PHONE_CONTROL_LOCK_UNSAFE'`));
test('legacy companion cannot mutate UI but manually enabled tether can be adopted',()=>run(`f=Fake();f.native_guard=False
assert f.adapter().run('status')['nativePackageGuard'] is False
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='HERMES_NATIVE_PACKAGE_GUARD_REQUIRED'
assert not f.calls
f.state['tethering']=True;assert f.adapter().run('on')['tethering'];assert not f.calls
f.state.update(cellular=False,validated=False)
try:f.adapter().run('prepare');assert False
except m.TetherError as e:assert e.code=='HERMES_NATIVE_PACKAGE_GUARD_REQUIRED'
assert not f.calls`));
test('mutation requires shared SDK while status and already-desired state are read-only',()=>run(`f=Fake();f.phone_task=None
assert f.adapter().run('status')['ok']
try:f.adapter().run('on');assert False
except m.TetherError as e:assert e.code=='HERMES_TASK_QUEUE_REQUIRED'
assert not f.calls and not f.jobs
f.state['tethering']=True;assert f.adapter().run('on')['tethering'];assert not f.calls and not f.jobs
f.state['tethering']=False;assert not f.adapter().run('off')['tethering'];assert not f.calls and not f.jobs`));
test('shared phone job releases on failure and cancellation, with no remaining UI authority',()=>run(`
for cancellation in [False,True]:
 f=Fake();f.cancel=cancellation;f.deny=not cancellation;a=f.adapter()
 try:a.run('on');assert False
 except m.TetherError as e:assert e.code==('PHONE_CONTROL_CANCELLED' if cancellation else 'HERMES_POLICY_DENIED')
 assert not f.active and not a.task_active and not a.usb_operation_pending
 assert f.jobs==[('start','novel:tether-on'),('failed','novel:tether-on'),('end','novel:tether-on')]
 try:a._recipe([{'op':'app.launch'}]);assert False
 except m.TetherError as e:assert e.code=='HERMES_TASK_QUEUE_REQUIRED'`));
test('USB reenumeration restores the existing reverse only inside its active switch job',()=>run(`f=Fake();f.reenumerate=True;r=f.adapter().run('on');assert r['tethering'];assert f.repairs==1;assert not f.active;assert f.jobs==[('start','novel:tether-on'),('end','novel:tether-on')]
f=Fake();f.adapter().run('status');assert f.repairs==0 and not f.jobs`));
test('reverse repair never overwrites a changed destination or creates an unverified mapping',()=>run(String.raw`
calls=[];mapping=['UsbFfs tcp:18750 tcp:18750']
def adb(*args):
 calls.append(args)
 if args==('devices','-l'):return 'List of devices attached\nphone device usb:3-3 product:x'
 if args[:3]==('shell','getprop','ro.serialno'):return 'phone'
 if args==('reverse','--list'):return '\n'.join(mapping)
 if args==('reverse','tcp:18750','tcp:18750'):mapping.append('UsbFfs tcp:18750 tcp:18750');return ''
 return ''
assert m.restore_reverse('phone',18750,previously_bound=True,adb=adb) is False
assert not any(c==('reverse','tcp:18750','tcp:18750') for c in calls)
mapping.clear();assert m.restore_reverse('phone',18750,previously_bound=True,adb=adb) is True
for verified,rows,code in [(False,[],'PHONE_REVERSE_RESTORE_UNAUTHORIZED'),(True,['UsbFfs tcp:18750 tcp:9999'],'PHONE_REVERSE_BINDING_CONFLICT')]:
 mapping[:]=rows;calls.clear()
 try:m.restore_reverse('phone',18750,previously_bound=verified,adb=adb);assert False
 except m.TetherError as e:assert e.code==code
 assert not any(c==('reverse','tcp:18750','tcp:18750') for c in calls)`));
test('CLI SIGTERM handler emits one sanitized JSON and releases shared job plus local lock',()=>run(`
import types,tempfile,pathlib,os,signal,io,contextlib
f=Fake();locks=[]
@contextmanager
def lock():
 locks.append('enter')
 try:yield
 finally:locks.append('exit')
def cancel(name,payload=None):signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
f.cmd=cancel
bridge=types.ModuleType('shared.bridge_client');bridge.BridgeClient=lambda **kwargs:f;bridge.load_bridge_config=lambda:{'phone':{'device_id_expect':'test-phone'}}
policy=types.ModuleType('skill_registry.policy');policy.check_package=lambda *a,**k:{'ok':True}
sys.modules['shared']=types.ModuleType('shared');sys.modules['shared.bridge_client']=bridge
sys.modules['skill_registry']=types.ModuleType('skill_registry');sys.modules['skill_registry.policy']=policy
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);(root/'shared').mkdir();(root/'shared/bridge_client.py').touch()
 os.environ['NC_HERMES_ROOT']=tmp;os.environ['NC_TETHER_PHONE_SERIAL']='phone'
 m.phone_lock=lock;m.read_phone=lambda *a:f.phone()
 before=signal.getsignal(signal.SIGTERM);out=io.StringIO()
 with contextlib.redirect_stdout(out):code=m.main(['on'])
 assert code==1 and json.loads(out.getvalue())['code']=='PHONE_CONTROL_CANCELLED'
 assert len(out.getvalue().splitlines())==1 and signal.getsignal(signal.SIGTERM)==before
 assert locks==['enter','exit'] and not f.active
 assert f.jobs==[('start','novel:tether-on'),('failed','novel:tether-on'),('end','novel:tether-on')]`));
test('missing post-restart heartbeat stays pending and never weakens the device pin',()=>run(`f=Fake();f.status=lambda:(200,{'payload':{'bridge_state':{'last_heartbeat':None}}})
try:f.adapter().run('status');assert False
except m.TetherError as e:assert e.code=='HERMES_DEVICE_HEARTBEAT_PENDING'
assert not f.calls and not f.jobs`));
