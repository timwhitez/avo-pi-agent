#!/usr/bin/env python3
"""Pinned installed entry; all checks precede any browser package import."""
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import runpy
import stat
import sys
import sysconfig

MANIFEST = Path(__file__).resolve().parents[1] / 'requirements/browser/runtime.json'

def check_install():
    manifest = json.loads(MANIFEST.read_text())
    lock = MANIFEST.with_name('linux-x86_64-cp312.lock')
    if hashlib.sha256(lock.read_bytes()).hexdigest() != manifest['lockSha256']:
        raise RuntimeError('browser lock digest mismatch')
    if (platform.python_version(), sysconfig.get_config_var('SOABI'), sys.platform, platform.machine()) != (manifest['python'], manifest['soabi'], manifest['platform'], manifest['machine']):
        raise RuntimeError('browser Python version/ABI/platform mismatch')
    installed = {d.metadata['Name'].lower().replace('_', '-'): d for d in metadata.distributions()}
    expected = {d['name'].replace('_', '-') for d in manifest['distributions']}
    if set(installed) != expected:
        raise RuntimeError('browser installation distribution closure mismatch')
    for row in manifest['distributions']:
        dist = installed[row['name'].replace('_', '-')]
        if dist.version != row['version']:
            raise RuntimeError('browser installed distribution version mismatch: ' + row['name'])
        for relative, digest in row['leafSources'].items():
            leaf = Path(dist.locate_file(relative)).resolve()
            if not leaf.is_relative_to(Path(sys.prefix).resolve()) or hashlib.sha256(leaf.read_bytes()).hexdigest() != digest:
                raise RuntimeError('browser installed leaf source mismatch: ' + relative)
    helper = Path(installed['browser-harness'].locate_file('browser_harness/helpers.py')).resolve()
    roots = [helper.parent.parent.parent]
    for key in ['BH_AGENT_WORKSPACE']:
        if os.environ.get(key): roots.append(Path(os.environ[key]))
    roots.append(Path.cwd())
    for root in roots:
        # Refuse unreadable paths as well as unexpected files; never read values.
        if any(part.is_symlink() for part in [root, *root.parents]):
            raise RuntimeError('browser controlled loader root has a symlink component: ' + str(root))
        if not root.is_dir() or not os.access(root, os.R_OK | os.X_OK):
            raise RuntimeError('browser controlled loader root inaccessible: ' + str(root))
        for name in ['.env', 'agent_helpers.py']:
            if os.path.lexists(root / name):
                raise RuntimeError('browser unexpected automatic loader: ' + str(root / name))
    return {'schema': 'avo.browser-install.v1', 'python': platform.python_version(), 'pythonBuild': sys.version, 'pythonExecutable': sys.executable, 'soabi': sysconfig.get_config_var('SOABI'), 'lockSha256': manifest['lockSha256'], 'distributions': [{ 'name': r['name'], 'version': r['version'] } for r in manifest['distributions']], 'loaderRoot': str(helper.parent.parent.parent), 'runtime': 'not_checked'}

def main():
    if os.environ.get('PYTHON_DOTENV_DISABLED') != '1' or os.environ.get('BROWSER_USE_SETUP_LOGGING') != 'false':
        raise RuntimeError('browser pre-import dotenv/logging controls missing')
    inventory = check_install()
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode == 'inventory':
        print(json.dumps(inventory)); return
    if mode == 'png':
        # JSON stdin is host-generated; never exposed as a model launcher mode.
        p = Path(json.load(sys.stdin)['path'])
        st = p.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 8 * 1024 * 1024:
            raise RuntimeError('PNG must be a bounded unlinked regular file')
        from PIL import Image
        with Image.open(p) as im:
            if im.format != 'PNG': raise RuntimeError('PNG format mismatch')
            im.verify()
        with Image.open(p) as im:
            im.load(); w, h = im.size
            if not (0 < w <= 2000 and 0 < h <= 2000 and w*h <= 4000000): raise RuntimeError('PNG dimensions exceed limit')
        print(json.dumps({'path': str(p), 'width': w, 'height': h, 'mimeType': 'image/png'})); return
    if mode == 'daemon':
        sys.argv = ['browser-harness-daemon']
        runpy.run_module('browser_harness.daemon', run_name='__main__'); return
    if mode == 'doctor':
        sys.argv = ['browser-harness', 'doctor', '--json', '--require-existing-daemon']
        from browser_harness.run import main as entry
    elif mode == 'exec':
        sys.argv = ['browser-use']
        from browser_use.cli import main as entry
    else:
        raise RuntimeError('unsupported browser launcher mode')
    entry()

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
