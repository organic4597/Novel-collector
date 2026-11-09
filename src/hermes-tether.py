"""Fixed Hermes Android settings recipes; USB ADB is verification only."""
import json
from contextlib import contextmanager
import os
from pathlib import Path
import re
import subprocess
import stat
import signal
import sys
import time
from urllib.parse import urlsplit
import uuid

SETTINGS = "com.android.settings"
USB_LABELS = ("USB 테더링", "USB tethering")
WIFI_LABELS = ("Wi-Fi", "와이파이", "Wi‑Fi")


class TetherError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@contextmanager
def phone_lock(directory=Path("/run/novel-collector-tether")):
    try:
        import fcntl
    except ImportError:
        raise TetherError("PHONE_CONTROL_LOCK_UNSUPPORTED") from None
    try:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise TetherError("PHONE_CONTROL_LOCK_UNSAFE")
        fd = os.open(directory / "phone.lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise TetherError("PHONE_CONTROL_LOCK_UNAVAILABLE") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise TetherError("PHONE_CONTROL_LOCK_UNSAFE")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TetherError("PHONE_CONTROL_BUSY") from None
        yield
    finally:
        os.close(fd)


def validate_bridge_url(value):
    try:
        u = urlsplit(value)
        if (u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1")
                or u.username or u.password or u.query or u.fragment
                or u.path not in ("", "/") or not u.port):
            raise ValueError()
    except ValueError:
        raise TetherError("HERMES_BRIDGE_URL_INVALID") from None
    return value.rstrip("/")


def parse_connectivity(text):
    default = re.search(r"Active default network:\s*(\d+)", text)
    if not default:
        return {"cellular": False, "validated": False}
    network = re.search(r"NetworkAgentInfo\{network\{" + default[1] + r"\}[^\n]*", text)
    line = network[0] if network else ""
    return {
        "cellular": bool(re.search(r"ni\{MOBILE|Transports:\s*CELLULAR", line)),
        "validated": bool(re.search(r"\b(?:IS_VALIDATED|VALIDATED)\b", line)),
    }


def parse_keyguard(text):
    states = re.findall(r"\b(?:mIsShowing|isKeyguardShowing|keyguardShowing)=(true|false)", text)
    if not states:
        section = re.search(r"KeyguardServiceDelegate[^\n]*\n(?P<body>[\s\S]{0,800})", text)
        states = re.findall(r"\bshowing=(true|false)", section["body"]) if section else []
    return any(s == "true" for s in states) if states else None


def _adb(serial, *args):
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", serial or ""):
        raise TetherError("PHONE_SERIAL_REQUIRED")
    try:
        p = subprocess.run(["adb", "-s", serial, *args], capture_output=True,
                           text=True, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise TetherError("PHONE_ADB_UNAVAILABLE") from None
    if p.returncode:
        raise TetherError("PHONE_ADB_UNAVAILABLE")
    return p.stdout


def read_phone(serial, bridge_port=18750):
    adb = lambda *args: _adb(serial, *args)
    devices = adb("devices", "-l")
    row = next((l for l in devices.splitlines() if l.split()[:1] == [serial]), "")
    connected = bool(re.search(r"\bdevice\s.*\busb:", row)) and sum(" usb:" in l for l in devices.splitlines()) == 1
    if not connected:
        raise TetherError("PHONE_USB_REQUIRED")
    functions = adb("shell", "getprop", "sys.usb.config").strip().split(",")
    reverse = adb("reverse", "--list")
    version = re.search(r"\bversionName=([^\s]+)", adb("shell", "dumpsys", "package", "org.hermes.mobile"))
    return {
        "usbConnected": connected,
        "hardwareMatches": adb("shell", "getprop", "ro.serialno").strip() == serial,
        "bridgeReverseBound": any(l.split()[-2:] == [f"tcp:{bridge_port}", f"tcp:{bridge_port}"] for l in reverse.splitlines()),
        "companionVersion": version[1] if version else None,
        "tethering": any(x in functions for x in ("rndis", "ncm")),
        **parse_connectivity(adb("shell", "dumpsys", "connectivity")),
        "locked": parse_keyguard(adb("shell", "dumpsys", "window", "policy")),
    }


def restore_reverse(serial, bridge_port, *, previously_bound=False, adb=None):
    if not previously_bound or not isinstance(bridge_port, int) or not 1 <= bridge_port <= 65535:
        raise TetherError("PHONE_REVERSE_RESTORE_UNAUTHORIZED")
    adb = adb or (lambda *args: _adb(serial, *args))
    devices = adb("devices", "-l")
    row = next((l for l in devices.splitlines() if l.split()[:1] == [serial]), "")
    if not re.search(r"\bdevice\s.*\busb:", row) or sum(" usb:" in l for l in devices.splitlines()) != 1:
        raise TetherError("PHONE_USB_REQUIRED")
    if adb("shell", "getprop", "ro.serialno").strip() != serial:
        raise TetherError("PHONE_DEVICE_BINDING_UNVERIFIED")
    port = f"tcp:{bridge_port}"
    rows = [l.split() for l in adb("reverse", "--list").splitlines()]
    if any(r[-2:] == [port, port] for r in rows):
        return False
    if any(len(r) >= 2 and r[-2] == port for r in rows):
        raise TetherError("PHONE_REVERSE_BINDING_CONFLICT")
    adb("reverse", port, port)
    if not any(l.split()[-2:] == [port, port] for l in adb("reverse", "--list").splitlines()):
        raise TetherError("PHONE_REVERSE_VERIFY_FAILED")
    return True


def find_switch(snapshot, labels):
    if (snapshot.get("package") != SETTINGS or snapshot.get("foregroundPackage") != SETTINGS
            or snapshot.get("truncated")):
        raise TetherError("PHONE_UI_UNVERIFIED")
    nodes = snapshot.get("nodes", [])
    by_id = {n.get("id"): n for n in nodes}
    labels = set(labels)
    candidates = {}
    for label in nodes:
        text = label.get("text") if label.get("text") in labels else label.get("description")
        if text not in labels or label.get("redacted"):
            continue
        parent = label
        for _ in range(4):
            matches = []
            for switch in nodes:
                if switch.get("checkable") is not True or not isinstance(switch.get("checked"), bool):
                    continue
                ancestor = switch
                visited = set()
                while ancestor and ancestor.get("id") not in visited:
                    visited.add(ancestor.get("id"))
                    if ancestor.get("id") == parent.get("id"):
                        matches.append(switch)
                        break
                    ancestor = by_id.get(ancestor.get("parent"))
            if len(matches) == 1:
                candidates[matches[0]["id"]] = (text, matches[0], label)
                break
            parent = by_id.get(parent.get("parent"))
            if parent is None:
                break
    if len(candidates) != 1:
        raise TetherError("PHONE_SWITCH_AMBIGUOUS")
    text, switch, label = next(iter(candidates.values()))
    if switch.get("enabled") is not True or label.get("enabled") is not True:
        raise TetherError("PHONE_SWITCH_DISABLED")
    return text, switch["checked"], switch


def switch_center(node):
    bounds = node.get("bounds")
    if (not isinstance(bounds, list) or len(bounds) != 4
            or not all(isinstance(n, int) and n >= 0 for n in bounds)
            or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]):
        raise TetherError("PHONE_SWITCH_BOUNDS_UNVERIFIED")
    return (bounds[0] + bounds[2]) // 2, (bounds[1] + bounds[3]) // 2


class HermesTether:
    def __init__(self, client, phone_read, authorize, *, expected_device_id,
                 reverse_repair=None, clock=time.monotonic, sleep=time.sleep):
        self.client, self.phone_read, self.authorize = client, phone_read, authorize
        self.expected_device_id = expected_device_id
        self.companion_version = None
        self.native_package_guard = False
        self.reverse_repair = reverse_repair
        self.usb_operation_pending = False
        self.task_active = False
        self.clock, self.sleep = clock, sleep

    def _bridge_state(self):
        code, body = self.client.status()
        if code in (401, 403):
            raise TetherError("HERMES_AUTH_UNAVAILABLE")
        payload = body.get("payload") if isinstance(body, dict) else None
        if code != 200 or not isinstance(payload, dict) or not isinstance(payload.get("bridge_state"), dict):
            raise TetherError("HERMES_BRIDGE_UNAVAILABLE")
        state = payload["bridge_state"]
        heartbeat = state.get("last_heartbeat") or {}
        if not isinstance(heartbeat, dict) or not heartbeat.get("device_id"):
            raise TetherError("HERMES_DEVICE_HEARTBEAT_PENDING")
        if not self.expected_device_id or heartbeat.get("device_id") != self.expected_device_id:
            raise TetherError("HERMES_DEVICE_PIN_MISMATCH")
        self.companion_version = (heartbeat.get("payload") or {}).get("app_ver")
        capabilities = (heartbeat.get("payload") or {}).get("capabilities") or {}
        self.native_package_guard = (capabilities.get("touch") or {}).get("expected_package_guard") is True
        return state

    def _phone(self, *, ui=False):
        state = self.phone_read()
        if state.get("usbConnected") is not True:
            raise TetherError("PHONE_USB_REQUIRED")
        if state.get("hardwareMatches") is not True or state.get("bridgeReverseBound") is not True:
            raise TetherError("PHONE_DEVICE_BINDING_UNVERIFIED")
        version = state.get("companionVersion")
        if not version or self.companion_version not in (version, "hermes_mobile_agent-" + version):
            raise TetherError("PHONE_COMPANION_VERSION_MISMATCH")
        if ui and state.get("locked") is not False:
            raise TetherError("PHONE_LOCKED" if state.get("locked") else "PHONE_LOCK_STATE_UNKNOWN")
        return state

    def _recipe(self, steps, expected_switch=None):
        if not self.task_active:
            raise TetherError("HERMES_TASK_QUEUE_REQUIRED")
        if not self.native_package_guard:
            raise TetherError("HERMES_NATIVE_PACKAGE_GUARD_REQUIRED")
        self._phone(ui=True)
        self.authorize()
        if expected_switch:
            labels, checked = expected_switch
            _, current_checked, node = find_switch(self._screen(), labels)
            if current_checked != checked:
                raise TetherError("PHONE_UI_CHANGED")
            if labels == USB_LABELS:
                x, y = switch_center(node)
                steps = [{**step, "with": {**step.get("with", {}), "x": x, "y": y}}
                         if step.get("op") == "touch.tap" else step for step in steps]
        run_id = str(uuid.uuid4())
        # Native Hermes recipes retain companion policy, authentication and lease checks.
        payload = {"run_id": run_id, "ensure_home": False, "cleanup_apps": False,
                   "capture_final": False, "stop_on_fail": True, "steps": steps}
        code, receipt = self.client.cmd("recipe.run", payload=payload)
        if code not in (200, 201) or not isinstance(receipt, dict):
            raise TetherError("HERMES_COMMAND_REJECTED")
        if expected_switch and expected_switch[0] == USB_LABELS:
            self.usb_operation_pending = True
        deadline = self.clock() + 45
        while self.clock() < deadline:
            try:
                self._repair_reverse()
            except TetherError as error:
                if error.code not in ("PHONE_ADB_UNAVAILABLE", "PHONE_USB_REQUIRED"):
                    raise
                self.sleep(0.5)
                continue
            event = self._bridge_state().get("last_cmd_result") or {}
            result = event.get("payload") or {}
            detail = result.get("detail") or {}
            if result.get("cmd") == "recipe.run" and detail.get("run_id") == run_id:
                if event.get("device_id") != self.expected_device_id:
                    raise TetherError("HERMES_DEVICE_PIN_MISMATCH")
                if result.get("ok") is not True or detail.get("failed_step"):
                    raise TetherError("HERMES_PHONE_COMMAND_FAILED")
                if detail.get("steps_total") != len(steps):
                    raise TetherError("HERMES_RESULT_UNVERIFIED")
                outcomes = detail.get("step_results") or []
                if len(outcomes) != len(steps) or not all(r.get("ok") is True for r in outcomes):
                    raise TetherError("HERMES_RESULT_UNVERIFIED")
                return outcomes[-1].get("detail") or {}
            self.sleep(0.5)
        raise TetherError("HERMES_COMMAND_TIMEOUT")

    def _repair_reverse(self):
        if self.usb_operation_pending and self.task_active and self.reverse_repair:
            self.reverse_repair()

    def _screen(self):
        deadline = self.clock() + 25
        while self.clock() < deadline:
            try:
                self._repair_reverse()
                return self._recipe([{"id": "state_only", "op": "ui.snapshot",
                                      "with": {"expected_package": SETTINGS}, "sleep_ms": 0}])
            except TetherError as error:
                if error.code not in ("PHONE_ADB_UNAVAILABLE", "PHONE_USB_REQUIRED"):
                    raise
                self.sleep(0.5)
        raise TetherError("PHONE_ADB_UNAVAILABLE")

    def _set_switch(self, action, labels, wanted):
        self._recipe([
            {"id": "open_settings", "op": "app.launch", "with": {"action": action}, "sleep_ms": 700},
        ])
        label, checked, _ = find_switch(self._screen(), labels)
        if checked == wanted:
            return False
        self._recipe([
            {"id": "set_switch", "op": "touch.tap" if labels == USB_LABELS else "touch.click_text",
             "with": {"expected_package": SETTINGS} if labels == USB_LABELS else
                     {"text": label, "exact": True, "expected_package": SETTINGS}, "sleep_ms": 700},
        ], expected_switch=(labels, checked))
        _, checked, _ = find_switch(self._screen(), labels)
        if checked != wanted:
            raise TetherError("PHONE_SWITCH_VERIFY_FAILED")
        return True

    def _verified(self, predicate, code):
        deadline = self.clock() + 25
        while self.clock() < deadline:
            try:
                self._repair_reverse()
                state = self._phone()
            except TetherError as error:
                if error.code not in ("PHONE_ADB_UNAVAILABLE", "PHONE_USB_REQUIRED"):
                    raise
                self.sleep(0.5)
                continue
            if predicate(state):
                return state
            self.sleep(0.5)
        raise TetherError(code)

    def _perform(self, action, state):
        changed = False
        if action in ("prepare", "on"):
            if not (state.get("cellular") and state.get("validated")):
                changed = self._set_switch("android.settings.WIFI_SETTINGS", WIFI_LABELS, False)
                state = self._verified(lambda s: s.get("cellular") and s.get("validated"), "PHONE_CELLULAR_REQUIRED")
        if action in ("on", "off"):
            wanted = action == "on"
            if wanted and not (state.get("cellular") and state.get("validated")):
                raise TetherError("PHONE_CELLULAR_REQUIRED")
            if state.get("tethering") != wanted:
                self._set_switch("android.settings.TETHER_SETTINGS", USB_LABELS, wanted)
                state = self._verified(lambda s: s.get("tethering") == wanted and
                                       (not wanted or s.get("cellular") and s.get("validated")),
                                       "PHONE_TETHER_VERIFY_FAILED")
        return {"ok": True, "action": action, **state, "wifiChanged": changed,
                "nativePackageGuard": self.native_package_guard}

    @staticmethod
    def _needs_mutation(action, state):
        mobile = state.get("cellular") and state.get("validated")
        return (action == "prepare" and not mobile or action == "on" and
                not (state.get("tethering") and mobile) or action == "off" and state.get("tethering"))

    def run(self, action):
        if action not in ("status", "on", "off", "prepare"):
            raise TetherError("INVALID_ACTION")
        self._bridge_state()
        state = self._phone()
        if action == "status" or not self._needs_mutation(action, state):
            return {"ok": True, "action": action, **state, "wifiChanged": False,
                    "nativePackageGuard": self.native_package_guard}
        task = getattr(self.client, "phone_task", None)
        if not callable(task):
            raise TetherError("HERMES_TASK_QUEUE_REQUIRED")
        if not self.native_package_guard:
            raise TetherError("HERMES_NATIVE_PACKAGE_GUARD_REQUIRED")
        with task(owner=f"novel:tether-{action}", timeout_s=1800, ttl_seconds=60, strict=True):
            self.task_active = True
            try:
                self._bridge_state()
                state = self._phone()
                return self._perform(action, state)
            finally:
                self.task_active = False
                self.usb_operation_pending = False


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    previous_signal = signal.getsignal(signal.SIGTERM)

    def interrupted(_signum, _frame):
        raise TetherError("PHONE_CONTROL_CANCELLED")

    try:
        signal.signal(signal.SIGTERM, interrupted)
        if len(args) != 1 or args[0] not in ("status", "on", "off", "prepare"):
            raise TetherError("INVALID_ACTION")
        serial = os.environ.get("NC_TETHER_PHONE_SERIAL", "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", serial):
            raise TetherError("PHONE_SERIAL_REQUIRED")
        base = validate_bridge_url(os.environ.get("NC_HERMES_BRIDGE_URL", "http://127.0.0.1:18750"))
        root = Path(os.environ.get("NC_HERMES_ROOT", str(Path.home() / ".hermes/android_agent"))).resolve()
        if not (root / "shared/bridge_client.py").is_file():
            raise TetherError("HERMES_CLIENT_UNAVAILABLE")
        sys.path.insert(0, str(root))
        from shared.bridge_client import BridgeClient, load_bridge_config
        from skill_registry.policy import check_package
        device_id = (load_bridge_config().get("phone") or {}).get("device_id_expect")
        if not device_id:
            raise TetherError("HERMES_DEVICE_PIN_REQUIRED")

        def authorize():
            if check_package(SETTINGS, action="run").get("ok") is not True:
                raise TetherError("HERMES_POLICY_DENIED")

        adapter = HermesTether(BridgeClient(base=base, timeout=8),
                               lambda: read_phone(serial, urlsplit(base).port), authorize,
                               expected_device_id=device_id,
                               reverse_repair=lambda: restore_reverse(serial, urlsplit(base).port, previously_bound=True))
        if args[0] == "status":
            result = adapter.run(args[0])
        else:
            with phone_lock():
                result = adapter.run(args[0])
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except TetherError as e:
        print(json.dumps({"ok": False, "code": e.code, "message": "Hermes 테더링 동작을 확인할 수 없습니다. 수집을 대기합니다."}, ensure_ascii=False))
    except Exception:
        print(json.dumps({"ok": False, "code": "HERMES_TETHER_UNAVAILABLE", "message": "Hermes 테더링 연결을 확인하세요."}, ensure_ascii=False))
    finally:
        signal.signal(signal.SIGTERM, previous_signal)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
