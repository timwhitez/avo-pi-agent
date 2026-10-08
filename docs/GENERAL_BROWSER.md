# Opt-in general browser profile

Run the separate entry only for an explicitly authorized general task. ARC still
uses `src/cli.mjs`; installing browser dependencies never enables browser tools in
ARC. `general-browser-v1` is rejected by the ARC profile normalizer.

## Install and run

This first target is Linux x86_64, CPython **3.12.3** / `cpython-312-x86_64-linux-gnu`,
Node >=22.19, browser-use **0.13.11**, browser-harness **0.1.13**, python-dotenv
**1.2.2** (required by browser-use), and pip **24.0**. The committed lock contains
105 exact distributions and one selected wheel hash each. Installation uses `--no-compile` to avoid eager dependency bytecode compilation;
locked versions/source checks remain identical. No sdists, package
surgery, Chrome download, OS modification, Cloud bootstrap, or automatic updates.
The ARC `.venv` and workspace images remain separate.

1. Install Node dependencies: `npm ci`.
2. Create the private installation: `./scripts/setup-browser.sh --python=/usr/bin/python3.12`.
3. Check it: `node src/general/cli.mjs doctor --json --browser-user=nobody`.
4. Put your authorized task in an absolute UTF-8 task file (maximum 64 KiB).
5. Run with your existing parent provider configuration:

```bash
node src/general/cli.mjs run --profile=general-browser-v1 \
  --task-file=/absolute/task.txt --browser-user=nobody \
  --chrome=/usr/bin/google-chrome \
  --timeout-ms=600000 --tool-timeout-ms=60000 --max-turns=100 --max-tools=1000
```

`--venv=/absolute/private-install` selects a matching, receipted private venv.
Unknown, duplicate, ARC, resume and remote-attach options fail before launch.
Setup refuses an existing installation. A failed/interrupted installation needs
explicit removal/reinstallation of that private path; ordinary run/doctor never
installs, upgrades, repairs or adopts an incomplete stack.

The parent intentionally loads this checkout's `.env` through the existing
provider parser, preserving selected provider/model/effort/capabilities. Browser
children receive none of that configuration. Image capability must be explicitly
declared; it is never inferred or substituted. No paid provider tests are part
of local acceptance.

## Authority, isolation and ownership

**Python has its account's host file, subprocess and network authority. Privilege
separation is not a sandbox.** Arbitrary authorized Python can explicitly read
host files and make network calls. The wrapper's environment and private profile
prevent ambient configuration/personal-profile adoption; they do not confine
host Python. Web/DOM text is external data, not permission to install software,
change privileges or expand task scope. Login/upload/send/payment follow the
operator's existing rules. Chrome's sandbox stays enabled.

As root, explicitly select an **existing non-root account** with
`--browser-user=name` or `AVO_GENERAL_BROWSER_USER`. Without it, fail before
model/browser start. Every browser child (Chrome, foreground daemon, official
exec CLI, strict doctor, PNG verification and inventory probe) uses Node spawn
uid/gid for that account. Non-root runs use their current uid/gid. No users,
sysctls, AppArmor policies, setuid bits, system packages or shared installation
permissions are changed. The launcher, venv and checkout ancestors must be
readable/traversable by that account; the inventory probe reports access failure.
On the tested host `/root` is 0711 and `nobody` is uid/gid 65534.

Each run owns `runs/private/general/g-<id>/browser/` with clean Chrome profile,
home/config/cache, harness, runtime, helper workspace, cwd and downloads. The
run parent stays host-owned and traversable (0711). Browser directories and
`artifacts/` are private (0700), created under host authority and handed over with
descriptor-bound mode/ownership changes, leaves before parents. `host/` and
`host/artifacts/` stay host-owned 0700; manifests, results, receipts and streamed
output there are 0600. The artifact registry and runner terminal evidence remain
in host memory. Browser children cannot replace host evidence under a root host;
non-root runs share the current account. Traversable parents hold no task content.
Chrome's
singleton socket exceeded Unix path limits in the original deep temp path, so
`<checkout>/.bt/g-<unique>/` is a separate 0700 account-owned temporary directory;
it never shares another run's temporary files. After owned Chrome, daemon and exec
children are proven closed, `close()` removes only that identity-checked directory.
Contents are removed under the browser account with fd-relative, non-symlink-following
operations; the host removes only the empty leaf in its host-owned parent. Unknown
closure retains it and reports the reason with the existing cleanup-unknown/managed
lock evidence. A directory identity change or removal failure also reports retained
with a reason. A checkout too deep even for this short path fails clearly. Private
run logs and artifacts remain retained for inspection.

Production runs reuse the managed-run lock, process group and guardian. They
serialize with ARC managed runs and each other. Within a runtime, exec/screenshot/
read calls queue serially. Chrome is explicitly started with its new profile and
its own freshly written DevToolsActivePort; the foreground harness gets that
exact loopback endpoint. No personal Chrome discovery, daemon autospawn, remote
CDP production flag, recovery/replay or Cloud/proxy selection. Root privilege
drop alone does not constrain a process from changing its own Python environment.

TERM/INT and deadlines cancel Pi and child execution; group controls support
pause/resume and guardian owner-death cleanup. Cleanup waits for child handles
and output drain; production scope closure additionally proves group closure.
Unknown cleanup retains the managed lock. Killing a client never proves rollback
of browser effects. A dead owned session ends calls rather than replaying code.

## Tools and output

Ordered tools: `browser_exec`, `browser_screenshot`, `artifact_read`, `finish`.
No ARC gameId/current frame/action/score state exists. Budgets are ceilings. After
the tool ceiling, the next request exposes finish only. Finish's summary is an
agent claim, not host-certified business success.

```python
# browser_exec code; each call has fresh locals, browser state persists.
print(goto_url("http://127.0.0.1:YOUR_FIXTURE_PORT"))
assert wait_for_element("#name", timeout=5)
fill_input("#name", "synthetic input")
print(js("document.querySelector('#name').value"))
print(page_info())
print(cdp("Network.getCookies"))
```

Raw stdout is arbitrary text. No Python-dict eval, JSON assumption or helper
tracing. Uncancelled completed runner evidence plus exit 0 reports process/capture
completion only. Cancellation remains cancelled/unknown even when a SIGTERM
handler exits zero; tool text includes the bounded runner cancellation reason. Unprinted wait False or
navigation errorText may exit 0; condition/business success stays unspecified.
Printing False preserves `condition_not_met` evidence; it is not an exception
or proof that no action was sent. Assert failures retain stderr/nonzero and
possible prior effects. Adapter-owned screenshot/download-setup calls alone use
controlled JSON checks.

Code is limited to 64 KiB. Default capture bounds are stdout 16 MiB, stderr
4 MiB, PNG 8 MiB, registered artifacts 128 MiB/run. These bound managed capture,
not all host writes/download disk usage. Quota/sink/cancel/drain failures preserve
saved prefixes where reopenable and label capture partial; hashes cover saved
bytes, never discarded bytes. Tool text sizes previews by serialized JSON length (including escapes) and
rejects insufficient bounds before dispatch. It includes process/capture facts and actual ref/
`artifact_read` nextRequest, never details-only recovery. UTF-8 output uses
replacement decoding; byte SHA and canonical JSON-page SHA are separate.

Artifact reads accept only host-issued refs registered in that runtime: no host
path arguments, traversal, cross-run refs, symlinks, hard links, FIFO or stale
identity/hash. Pages include an executable continuation with offset and canonical
content SHA. Read text/metadata, or `view="image"` for a verified PNG. Downloads
stay in the private browser downloads directory; inspect/print them with task
Python to receive registered stdout rather than passing arbitrary host paths.

Screenshot brings the selected background page to front, captures to a unique
private PNG created exclusively by the unprivileged child with mode 0600. The
host takes one descriptor-bound snapshot (at most 8 MiB) and sends those bytes to
pinned Pillow in an unprivileged verifier. Dimensions (2000/side, 4M pixels) are
checked before full decode. Digest, dimensions and byte count bind verification,
registration and delivery to that snapshot; file changes reject publication or
readback. Image-capable Pi requests contain the actual PNG data URL. Text-only models
receive `ref-only; image bytes not sent`. Historical images are pruned; context
pressure drops pixels with ref recovery. Screenshots never become ARC frames.

## Doctor and dependency records

`doctor --json` checks installed closure, Python ABI, selected Chrome version,
launcher leaf hashes and controlled loader roots. It does not start Chrome or
claim runtime health (`runtime: not_checked`).

`doctor --run-id=g-<id> --json --browser-user=name` selects that contained general
`host/manifest.json` and invokes only harness `doctor --json --require-existing-daemon`.
It requires schema 1, harness 0.1.13, exact selected name, strict=true,
`chrome_running=null`, healthy = daemon alive AND browser ready, with matching
exit status. Wrong version/schema or non-strict reports fail. A closed/dead
run reports unhealthy without discovery/fix/spawn. Doctor does not prove ownership,
business completion, network scope or future health.

Before either package import, the launcher rejects unexpected `.env` at the
installed harness's exact REPO_ROOT (`<venv>/lib/python3.12`), helper workspace,
or controlled cwd, plus automatic `agent_helpers.py`. It does not read file
values or scan/delete user ancestor files. `PYTHON_DOTENV_DISABLED=1` and
`BROWSER_USE_SETUP_LOGGING=false` are set before official package import;
clean cwd also prevents Pydantic's separate cwd dotenv reader. The selected leaf
source hashes bind these contracts. Telemetry, recording, liveURL, update checks,
domain skills, tab markers and Cloud sync are forced off; BU_AUTOSPAWN is absent.
All unlisted credentials, proxies and loader variables are absent.

Maintainer-only regeneration on the recorded target:

```bash
uv pip compile requirements/browser/linux-x86_64-cp312.in \
  --python /usr/bin/python3.12 --python-version 3.12.3 \
  --python-platform x86_64-unknown-linux-gnu --only-binary :all: \
  --generate-hashes --index-url https://pypi.org/simple \
  -o requirements/browser/linux-x86_64-cp312.lock
.venv-browser/bin/python -m pip download --require-hashes --only-binary=:all: \
  --index-url https://pypi.org/simple -r requirements/browser/linux-x86_64-cp312.lock \
  -d .browser-wheels
python3.12 scripts/lock-browser.py
.venv-browser/bin/python -I scripts/browser-license-inventory.py
```

Recheck upstream leaf contracts before accepting new stable versions. The runtime
manifest records selected wheel URL/hash, resolver, target ABI and leaf identities.
The installed-distribution [license inventory](BROWSER_LICENSE_INVENTORY.md)
distinguishes declared licenses and unknown audit status. Wheels and system Chrome
are not redistributed. A later bundled wheelhouse/browser/image requires payload
license/NOTICE review. This lock does not checksum/reproduce the entire Ubuntu
host, interpreter distro package, Chrome or native dependencies.

The tested host uses preinstalled Chrome 154.0.8037.92. Linkage resolves NSS/NSPR,
GLib/GIO, ATK/AT-SPI, X11/XCB, GBM/DRM, ALSA, CUPS, Cairo/Pango and fonts.
If Chrome reports a missing native library, an operator may install the specific
Ubuntu package (for example `libnss3`, `libgbm1`, `libatk1.0-0t64`, `libasound2t64`
or `fonts-liberation`) after examining that error. No automatic apt/dependency
repair or sandbox-disabling flags are supported.

## Validation and removal

Tests auto-run the real stack when the private venv and selected Chrome are
present; only absence permits skip. Root tests use nobody. Offline fresh-install
controls consume the preprepared `.browser-wheels` cache and never download.
A test-owned installed `.pth` hook instruments HTTP/socket, detached subprocess
and telemetry submissions before official imports. It permits only the owned
HTTP fixture, Chrome loopback endpoint and private IPC; negative probes prove
that blocked submissions exit before sending. Ambient provider/ARC/Cloud/proxy
markers are exercised through real children. This covers the exercised Python
paths, not native Chrome networking or arbitrary hostile Python. The ARC
baseline/candidate Pi differential also initializes under contaminated browser
settings; effective requests remain identical.

Browser tests remove their own task fixtures, fresh installations, run roots and
process-temp directories. Per-test teardown checks that owned temporary entries
are gone; foreign `.bt/g-*` directories and symlinks remain untouched. The parent-death
fixture removes its own retained temp only after the guardian proves group closure.

```bash
node --test --test-concurrency=1 test/general-browser-entry.test.mjs \
  test/browser-runtime.test.mjs test/browser-install.test.mjs \
  test/browser-arc-boundary.test.mjs test/browser-localhost.test.mjs
```

RED on main e8257c3: `entry_red_general_profile_contract` imports the intended real
entry and fails ERR_MODULE_NOT_FOUND; 0 pass / 1 fail / 0 skips, 138.269 ms.
Synthetic process/provider fixtures, installed upstream controls and actual
localhost Chrome checks are distinct evidence. Passing them is not ARC ability
or measured task-family benefit. Paid providers/ARC, outside websites, login,
personal profiles, remote CDP, Cloud/proxy/payment, other OS/CPU, performance
and general task-family gains remain NOT_RUN.

To uninstall, first finish/abort and confirm owned child/group cleanup. Inspect
the recorded absolute installation/run paths, then remove only that private
`.venv-browser` and any selected general run/short-temp artifacts. Preserve ARC
`.venv`, system Chrome, cached Playwright and unrelated runs. Uninstall is an
explicit operator action; run/doctor never deletes an installation.

Review-fix validation at `3bfa29d` (later documentation-only commit records
results): the requested full suite ran once, 849/865 pass, 16 fail, zero skips,
642.941 s. All 34 browser/entry/ARC tests passed in that run. Targeted acceptance
passed 34/34 (322.026 s), plus focused authority checks 6/6 and 2/2.

The six affected existing files are unchanged from main. The five non-public-runner
files each passed one isolated rerun with unchanged PATH/image/deadlines:

| File | Pass | Fail | Skip | Duration |
| --- | ---: | ---: | ---: | ---: |
| isolated `test/cli-report-write.test.mjs` | 11/11 | 0 | 0 | 69.563 s |
| isolated `test/owned-run.test.mjs` | 13/13 | 0 | 0 | 24.032 s |
| isolated `test/owned-workspace.test.mjs` | 5/5 | 0 | 0 | 33.481 s |
| isolated `test/workspace-container-owner.test.mjs` | 8/8 | 0 | 0 | 23.866 s |
| isolated `test/workspace-output.test.mjs` | 14/14 | 0 | 0 | 43.720 s |

The public-runner baseline failure is tracked by #383; this full run failed at a
missing exhaust-open report, rather than the supplied main baseline's recover-open
ETIMEDOUT at 60000 ms. It was not rerun. Other full-run failures involved existing
CLI/ownership/heartbeat/pause and 10-second workspace limits. Their exact causes
remain UNKNOWN; isolated passes do not replace the red full gate. No full retry,
existing deadline/concurrency change or #383 resolution. One isolated command
initially used a nonexistent filename; no tests ran, and workspace-output then ran
once at its correct path. Scan passes; offline demo wins 25/25 synthetic games
(not separately timed). Review readiness uses the requested exception for these
existing load-sensitive controls; it is not a merge or capability claim.
