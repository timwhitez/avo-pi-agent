"""Test-owned fresh-install hook: install before any official package import.

Only the owned HTTP fixture, Chrome endpoint and runtime IPC are permitted.
Exit at the submission boundary so upstream best-effort catches cannot hide it.
This instruments Python children, not native Chrome or hostile Python authority.
"""
import builtins
import os
from pathlib import Path
import sys
import urllib.request
from urllib.parse import urlsplit

fixture = urlsplit(owned_fixture)
chrome = urlsplit(os.environ.get('BU_CDP_WS', ''))
allowed = {('127.0.0.1', fixture.port), ('127.0.0.1', chrome.port)}
runtime = Path(os.environ['BH_RUNTIME_DIR'])
markers = ('BROWSER_USE_API_KEY', 'FETCH_USE_API_KEY', 'BU_AUTOSPAWN', 'OPENAI_API_KEY', 'ARC_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy')


def deny(*_args, **_kwargs):
    os.write(2, b'OUTBOUND_GUARD_BLOCKED\n')
    os._exit(97)


if any(key in os.environ for key in markers) or any(os.environ.get(key) != value for key, value in {
    'PYTHON_DOTENV_DISABLED': '1', 'BROWSER_USE_SETUP_LOGGING': 'false',
    'BH_TELEMETRY': '0', 'ANONYMIZED_TELEMETRY': 'false',
}.items()):
    deny()  # .pth initialization catches exceptions; it must not continue unguarded.


def audit(event, args):
    if event in ('socket.connect', 'socket.sendto'):
        address = args[-1]
        if isinstance(address, tuple):
            if address[:2] not in allowed: deny()
        elif str(address) != str(runtime / 'bu.sock'):
            deny()
    elif event == 'socket.getaddrinfo':
        if args[:2] not in allowed: deny()
    elif event == 'subprocess.Popen':
        # The exercised CLI/daemon paths need no subprocess. This catches the
        # harness detached telemetry sender before it escapes socket hooks.
        deny()


sys.addaudithook(audit)
original_open = urllib.request.OpenerDirector.open


def owned_open(self, fullurl, *args, **kwargs):
    request = fullurl if isinstance(fullurl, urllib.request.Request) else urllib.request.Request(fullurl)
    url = urlsplit(request.full_url)
    if (url.scheme, url.hostname, url.port) != (fixture.scheme, fixture.hostname, fixture.port) or request.get_method() != 'GET':
        deny()
    return original_open(self, fullurl, *args, **kwargs)


urllib.request.OpenerDirector.open = owned_open
original_import = builtins.__import__


def guarded_import(name, *args, **kwargs):
    if name.split('.')[0] == 'fetch_use': deny()
    result = original_import(name, *args, **kwargs)
    # Patch the actual submission functions as soon as imports define them;
    # capture() itself may legitimately be called while telemetry is disabled.
    telemetry = sys.modules.get('browser_harness.telemetry')
    if telemetry and hasattr(telemetry, '_send_detached'): telemetry._send_detached = deny
    posthog = sys.modules.get('posthog')
    if posthog:
        if hasattr(posthog, 'capture'): posthog.capture = deny
        if hasattr(posthog, 'Posthog'): posthog.Posthog.capture = deny
    return result


builtins.__import__ = guarded_import
builtins._browser_outbound_guard = True
