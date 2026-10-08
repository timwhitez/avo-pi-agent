#!/usr/bin/env python3
"""Generate honest license inventory from the installed locked closure (no imports/network)."""
import importlib.metadata as metadata
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'requirements/browser/runtime.json').read_text())
lines = ['# Installed browser distribution licenses', '', f"Lock SHA-256: `{manifest['lockSha256']}`. Generated from the installed Linux CPython 3.12.3 closure.", '', 'License labels are distribution metadata, not an audit or legal approval. Except for the two preserved MIT texts, audit status is **unknown**. Wheels remain in the private installation and are not redistributed by this repository; system Chrome has separate terms.', '', '| Distribution | Version | Declared license | Audit |', '| --- | --- | --- | --- |']
for row in manifest['distributions']:
    dist = metadata.distribution(row['name'])
    if dist.version != row['version']: raise RuntimeError('installed version mismatch')
    declared = dist.metadata.get('License-Expression')
    if not declared:
        classifiers = [c.removeprefix('License :: OSI Approved :: ') for c in dist.metadata.get_all('Classifier', []) if c.startswith('License :: OSI Approved :: ')]
        declared = '; '.join(classifiers) or 'unknown'
    audit = 'MIT text preserved' if row['name'] in ('browser-use', 'browser-harness') else 'unknown'
    lines.append(f"| {row['name']} | {row['version']} | {declared.replace('|', '/').replace(chr(10), ' ')} | {audit} |")
(root / 'docs/BROWSER_LICENSE_INVENTORY.md').write_text('\n'.join(lines)+'\n')
