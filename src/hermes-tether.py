"""Fixed Android network APIs under the shared Hermes phone-task lease."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

RUNTIME = Path('/run/novel-collector-tether')
ORIGINAL_FUNCTIONS = {'mtp', 'ptp', 'midi'}


class TetherError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise TetherError('PHONE_CONTROL_LOCK_UNSAFE')


@contextmanager
def phone_lock(directory=RUNTIME):
    try:
        import fcntl
        _private_directory(directory)
        fd = os.open(directory/'phone.lock', os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    except (ImportError, OSError):
        raise TetherError('PHONE_CONTROL_LOCK_UNAVAILABLE') from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise TetherError('PHONE_CONTROL_LOCK_UNSAFE')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TetherError('PHONE_CONTROL_BUSY') from None
        yield
    finally:
        os.close(fd)


def validate_bridge_url(value):
    try:
        u = urlsplit(value)
        if (u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1') or
                u.username or u.password or u.query or u.fragment or u.path not in ('', '/') or not u.port):
            raise ValueError()
    except ValueError:
        raise TetherError('HERMES_BRIDGE_URL_INVALID') from None
    return value.rstrip('/')


def _adb(serial, *args, include_stderr=False):
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', serial or ''):
        raise TetherError('PHONE_SERIAL_REQUIRED')
    try:
        result = subprocess.run(['adb', '-s', serial, *args], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise TetherError('PHONE_ADB_UNAVAILABLE') from None
    combined = result.stdout + '\n' + result.stderr
    if re.search(r'SecurityException|Permission Denial|permission denied|not allowed', combined, re.I):
        raise TetherError('PHONE_NETWORK_API_DENIED')
    if result.returncode:
        raise TetherError('PHONE_ADB_UNAVAILABLE')
    return combined if include_stderr else result.stdout


def parse_connectivity(text):
    match = re.search(r'Active default network:\s*(\d+)', text)
    row = re.search(r'NetworkAgentInfo\{network\{' + match[1] + r'\}[^\n]*', text) if match else None
    value = row[0] if row else ''
    return {'cellular': bool(re.search(r'ni\{MOBILE|Transports:\s*CELLULAR', value)),
            'validated': bool(re.search(r'\b(?:IS_VALIDATED|VALIDATED)\b', value))}


def parse_keyguard(text):
    values = re.findall(r'\b(?:mIsShowing|isKeyguardShowing|keyguardShowing)=(true|false)', text)
    return any(v == 'true' for v in values) if values else None


def parse_usb_tethered(text):
    return bool(re.search(r'^\s*(?:rndis|usb|ncm)[A-Za-z0-9_.:-]*\s+-\s+TetheredState\s+-\s+lastError\s*=\s*0\b', text, re.M))


def read_phone(serial, bridge_port=18750):
    adb = lambda *args: _adb(serial, *args)
    devices = adb('devices', '-l')
    row = next((line for line in devices.splitlines() if line.split()[:1] == [serial]), '')
    connected = bool(re.search(r'\bdevice\s.*\busb:', row)) and sum(' usb:' in l for l in devices.splitlines()) == 1
    if not connected:
        raise TetherError('PHONE_USB_REQUIRED')
    functions = adb('shell', 'getprop', 'sys.usb.config').strip().split(',')
    active = any(f in functions for f in ('rndis', 'ncm'))
    tethered = parse_usb_tethered(adb('shell', 'dumpsys', 'tethering'))
    reverse = adb('reverse', '--list')
    version = re.search(r'\bversionName=([^\s]+)', adb('shell', 'dumpsys', 'package', 'org.hermes.mobile'))
    return {'usbConnected': connected, 'hardwareMatches': adb('shell', 'getprop', 'ro.serialno').strip() == serial,
            'bridgeReverseBound': any(l.split()[-2:] == [f'tcp:{bridge_port}', f'tcp:{bridge_port}'] for l in reverse.splitlines()),
            'companionVersion': version[1] if version else None, 'usbFunctionActive': active,
            'usbTethered': tethered, 'tethering': active and tethered,
            **parse_connectivity(adb('shell', 'dumpsys', 'connectivity')),
            'locked': parse_keyguard(adb('shell', 'dumpsys', 'window', 'policy'))}


def restore_reverse(serial, bridge_port, *, previously_bound=False, adb=None):
    if not previously_bound or not isinstance(bridge_port, int) or not 1 <= bridge_port <= 65535:
        raise TetherError('PHONE_REVERSE_RESTORE_UNAUTHORIZED')
    adb = adb or (lambda *args: _adb(serial, *args))
    devices = adb('devices', '-l')
    row = next((l for l in devices.splitlines() if l.split()[:1] == [serial]), '')
    if not re.search(r'\bdevice\s.*\busb:', row) or sum(' usb:' in l for l in devices.splitlines()) != 1:
        raise TetherError('PHONE_USB_REQUIRED')
    if adb('shell', 'getprop', 'ro.serialno').strip() != serial:
        raise TetherError('PHONE_DEVICE_BINDING_UNVERIFIED')
    port = f'tcp:{bridge_port}'
    rows = [l.split() for l in adb('reverse', '--list').splitlines()]
    if any(r[-2:] == [port, port] for r in rows):
        return False
    if any(len(r) >= 2 and r[-2] == port for r in rows):
        raise TetherError('PHONE_REVERSE_BINDING_CONFLICT')
    adb('reverse', port, port)
    if not any(l.split()[-2:] == [port, port] for l in adb('reverse', '--list').splitlines()):
        raise TetherError('PHONE_REVERSE_VERIFY_FAILED')
    return True


class UsbFunctionStore:
    def __init__(self, path=RUNTIME/'original-usb-function'):
        self.path = path

    def read(self):
        try:
            _private_directory(self.path.parent)
            fd = os.open(self.path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        except OSError:
            raise TetherError('PHONE_USB_ORIGINAL_INVALID') from None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
                raise TetherError('PHONE_USB_ORIGINAL_INVALID')
            value = os.read(fd, 32).decode('ascii').strip()
            if info.st_size > 32 or value not in ORIGINAL_FUNCTIONS:
                raise TetherError('PHONE_USB_ORIGINAL_INVALID')
            return value
        except UnicodeError:
            raise TetherError('PHONE_USB_ORIGINAL_INVALID') from None
        finally:
            os.close(fd)

    def save(self, value):
        if value not in ORIGINAL_FUNCTIONS:
            raise TetherError('PHONE_USB_ORIGINAL_INVALID')
        current = self.read()
        if current is not None:
            return current
        try:
            _private_directory(self.path.parent)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        except OSError:
            raise TetherError('PHONE_USB_ORIGINAL_INVALID') from None
        try:
            os.write(fd, (value + '\n').encode('ascii'))
            os.fsync(fd)
        finally:
            os.close(fd)
        return value


class AndroidUsbApi:
    def __init__(self, serial, *, adb=None, original=None):
        self.adb = adb or (lambda *args, **kwargs: _adb(serial, *args, **kwargs))
        self.original = original or UsbFunctionStore()

    def get_function(self):
        value = self.adb('shell', 'svc', 'usb', 'getFunctions', include_stderr=True).strip()
        if value not in ORIGINAL_FUNCTIONS | {'', 'rndis', 'ncm'}:
            raise TetherError('PHONE_USB_FUNCTION_INVALID')
        return value

    def capture_original(self, tethering=False):
        current = self.original.read()
        if current is not None:
            return current
        # Unknown original while tethering uses the hardware-verified safe MTP restore.
        value = 'mtp' if tethering else self.get_function() or 'mtp'
        return self.original.save(value)

    def wifi_off(self):
        self.adb('shell', 'svc', 'wifi', 'disable', include_stderr=True)

    def set_usb(self, function):
        if function not in ORIGINAL_FUNCTIONS | {'rndis'}:
            raise TetherError('PHONE_USB_FUNCTION_INVALID')
        self.adb('shell', 'svc', 'usb', 'setFunctions', function, include_stderr=True)


class HermesTether:
    def __init__(self, client, phone_read, network_api, *, expected_device_id,
                 reverse_repair=None, clock=time.monotonic, sleep=time.sleep):
        self.client, self.phone_read, self.api = client, phone_read, network_api
        self.expected_device_id, self.reverse_repair = expected_device_id, reverse_repair
        self.clock, self.sleep = clock, sleep
        self.version = None
        self.native_guard = self.in_call = self.task_active = self.usb_pending = False

    def _bridge(self):
        code, body = self.client.status()
        payload = body.get('payload') if isinstance(body, dict) else None
        if code in (401, 403):
            raise TetherError('HERMES_AUTH_UNAVAILABLE')
        if code != 200 or not isinstance(payload, dict) or not isinstance(payload.get('bridge_state'), dict):
            raise TetherError('HERMES_BRIDGE_UNAVAILABLE')
        heartbeat = payload['bridge_state'].get('last_heartbeat') or {}
        if not heartbeat.get('device_id'):
            raise TetherError('HERMES_DEVICE_HEARTBEAT_PENDING')
        if not self.expected_device_id or heartbeat['device_id'] != self.expected_device_id:
            raise TetherError('HERMES_DEVICE_PIN_MISMATCH')
        data = heartbeat.get('payload') or {}
        self.version = data.get('app_ver')
        self.native_guard = ((data.get('capabilities') or {}).get('touch') or {}).get('expected_package_guard') is True
        self.in_call = (payload.get('active_call') is True or data.get('in_call') is True or
                        (payload.get('session') or {}).get('active') is not None)

    def _phone(self):
        state = self.phone_read()
        if state.get('usbConnected') is not True:
            raise TetherError('PHONE_USB_REQUIRED')
        if state.get('hardwareMatches') is not True or state.get('bridgeReverseBound') is not True:
            raise TetherError('PHONE_DEVICE_BINDING_UNVERIFIED')
        version = state.get('companionVersion')
        if not version or self.version not in (version, 'hermes_mobile_agent-' + version):
            raise TetherError('PHONE_COMPANION_VERSION_MISMATCH')
        return state

    def _repair(self):
        if self.task_active and self.usb_pending and self.reverse_repair:
            self.reverse_repair()

    def _wait(self, predicate, code, seconds=40):
        deadline = self.clock() + seconds
        while self.clock() < deadline:
            try:
                self._repair()
                state = self._phone()
                if predicate(state):
                    return state
            except TetherError as error:
                if error.code not in ('PHONE_ADB_UNAVAILABLE', 'PHONE_USB_REQUIRED'):
                    raise
            self.sleep(0.5)
        raise TetherError(code)

    @staticmethod
    def _needs(action, state):
        mobile = state.get('cellular') and state.get('validated')
        return (action == 'prepare' and not mobile or action == 'on' and not (state.get('tethering') and mobile)
                or action == 'off' and (state.get('usbFunctionActive') or state.get('usbTethered')))

    def _result(self, action, state, changed=False):
        return {'ok': True, 'action': action, 'backend': 'android-usb-api', **state,
                'wifiChanged': changed, 'nativePackageGuard': self.native_guard}

    def _perform(self, action, state):
        changed = False
        needs_mobile = action in ('on', 'prepare') and not (state.get('cellular') and state.get('validated'))
        if needs_mobile and self.in_call:
            raise TetherError('PHONE_BUSY')
        original = self.api.capture_original(state.get('usbFunctionActive', False)) if action in ('on', 'off') else None
        if needs_mobile:
            self.api.wifi_off()
            state = self._wait(lambda s: s.get('cellular') and s.get('validated'), 'PHONE_CELLULAR_REQUIRED', 25)
            changed = True
        if action in ('on', 'off') and self._needs(action, state):
            self._phone()  # Capture the existing reverse binding before the mode changes.
            self.usb_pending = True
            try:
                self.api.set_usb('rndis' if action == 'on' else original)
            except TetherError as error:
                if error.code not in ('PHONE_ADB_UNAVAILABLE', 'PHONE_USB_REQUIRED'):
                    raise
            predicate = (lambda s: s.get('tethering') and s.get('cellular') and s.get('validated')) if action == 'on' else (
                lambda s: not s.get('usbFunctionActive') and not s.get('usbTethered'))
            state = self._wait(predicate, 'PHONE_TETHER_VERIFY_FAILED')
        return self._result(action, state, changed)

    def run(self, action):
        if action not in ('status', 'prepare', 'on', 'off'):
            raise TetherError('INVALID_ACTION')
        self._bridge()
        state = self._phone()
        if action == 'status' or not self._needs(action, state):
            return self._result(action, state)
        task = getattr(self.client, 'phone_task', None)
        if not callable(task):
            raise TetherError('HERMES_TASK_QUEUE_REQUIRED')
        with task(owner=f'novel:tether-{action}', timeout_s=1800, ttl_seconds=60, strict=True):
            self.task_active = True
            try:
                self._bridge()
                return self._perform(action, self._phone())
            finally:
                self.task_active = self.usb_pending = False


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    previous_signal = signal.getsignal(signal.SIGTERM)

    def interrupted(_signum, _frame):
        raise TetherError('PHONE_CONTROL_CANCELLED')

    try:
        signal.signal(signal.SIGTERM, interrupted)
        if len(args) != 1 or args[0] not in ('status', 'prepare', 'on', 'off'):
            raise TetherError('INVALID_ACTION')
        serial = os.environ.get('NC_TETHER_PHONE_SERIAL', '')
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', serial):
            raise TetherError('PHONE_SERIAL_REQUIRED')
        base = validate_bridge_url(os.environ.get('NC_HERMES_BRIDGE_URL', 'http://127.0.0.1:18750'))
        root = Path(os.environ.get('NC_HERMES_ROOT', str(Path.home()/'.hermes/android_agent'))).resolve()
        if not (root/'shared/bridge_client.py').is_file():
            raise TetherError('HERMES_CLIENT_UNAVAILABLE')
        sys.path.insert(0, str(root))
        from shared.bridge_client import BridgeClient, load_bridge_config
        device_id = (load_bridge_config().get('phone') or {}).get('device_id_expect')
        if not device_id:
            raise TetherError('HERMES_DEVICE_PIN_REQUIRED')
        port = urlsplit(base).port
        adapter = HermesTether(BridgeClient(base=base, timeout=8), lambda: read_phone(serial, port), AndroidUsbApi(serial),
                               expected_device_id=device_id,
                               reverse_repair=lambda: restore_reverse(serial, port, previously_bound=True))
        if args[0] == 'status':
            result = adapter.run(args[0])
        else:
            with phone_lock():
                result = adapter.run(args[0])
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except TetherError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'message': '테더링 연결을 확인할 수 없어 수집을 대기합니다.'}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'code': 'HERMES_TETHER_UNAVAILABLE', 'message': 'Hermes 테더링 연결을 확인하세요.'}, ensure_ascii=False))
    finally:
        signal.signal(signal.SIGTERM, previous_signal)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
