# Local-only real-provider execution

This repository no longer uses GitHub Actions for provider checks, ARC public
benchmarks, trajectory repair, result publication, or frontend validation. All
of those operations run from a trusted local checkout so they do not consume
Actions quota and so raw trajectories remain on the operator-controlled host.

## ARC authentication

The default public-demo path uses the official ARC toolkit's anonymous bootstrap:

```dotenv
AVO_ARC_AUTH_MODE=anonymous-auto
ARC_API_KEY=
```

Before importing `arc_agi`, the bridge forces `ARC_API_KEY` to the empty string.
The official SDK obtains an anonymous key and retains it in the Python process.
The project never invents a registered key, writes the anonymous value to disk,
or prints it. An account-bound key is optional and must be selected explicitly
with `AVO_ARC_AUTH_MODE=registered`; it is not needed for the normal public demo.

## Prerequisites

- Node.js 22.19 or newer
- the exact npm version declared by `apps/mission-control-v3/package.json`
- Python 3.12 in `.venv/bin/python`
- the official `arc-agi` and `arcengine` distributions
- installed Pi packages from the root `package.json`
- an exact, validated Mission Control package manifest and npm lockfile
- a reachable real Responses-compatible provider
- sufficient local disk space for private trajectories and memory

Install the root and ARC dependencies once:

```bash
npm install --ignore-scripts
./scripts/setup-arc.sh
cp .env.example .env
chmod 600 .env
```

Populate only the provider variables in the local mode-0600 `.env`. Do not put
provider values in shell command arguments, Git commits, issues, pull requests,
or public reports. A provider key previously pasted into chat must be rotated
before use.

## Child-process credential boundary

The trusted parent loads `.env` once, then every benchmark, Pi Agent, ARC,
recorder, Git, test, and utility child receives a new allowlisted environment.
The project does not forward the complete Mission Control or login-shell
environment.

The three profiles are:

- `agent`: minimal OS/locale/certificate values, the exact four Provider values,
  selected ARC auth/runtime values, and explicit AVO run/memory/workspace/
  trajectory/budget/lock values;
- `arc`: the same minimal host values plus ARC and AVO runtime values, but no
  Provider credential;
- `utility`: only the minimal OS/locale/temp/certificate boundary.

The following classes are intentionally excluded unless a named profile field
requires them: Mission Control access tokens, GitHub credentials, cloud and
registry credentials, SSH agent/socket settings, database/monitoring secrets,
`NODE_OPTIONS`, `PYTHONPATH`, dynamic-loader/preload settings, and unknown
variables. Caller overrides are checked against a fixed allowlist.

Every filtered child receives `AVO_DISABLE_DOTENV=1`, so it cannot repopulate a
removed value from the repository `.env`. Anonymous ARC mode always receives an
empty `ARC_API_KEY`; registered mode fails before spawn unless an explicit ARC
key is present.

Proxy variables are excluded by default because proxy URLs may contain
credentials. Set this only in the trusted parent when the Provider or ARC route
requires the same proxy configuration:

```dotenv
AVO_CHILD_ALLOW_PROXY=1
```

Containerized workspace execution has its own stricter boundary: no network,
read-only container root, dropped capabilities, no new privileges, resource
limits, an unprivileged UID, and one writable per-game workspace mount. The
child-environment allowlist is defense in depth and does not replace OS or
container isolation.

## Mission Control local gate

The supported local commands are:

```bash
npm run mission-control:install
npm run mission-control:test
npm run mission-control:build
npm run mission-control:validate
```

Each command starts from the same fail-closed contract. The `test` command also
performs the locked install; the `build` and `validate` commands perform the
locked install, every discovered `*.test.mjs` file, and the production standalone
Next.js build. There is no flag that converts a missing test or failed build into
success.

The contract requires:

- exact stable versions rather than tags, caret/tilde ranges, local paths, or Git
  sources for every direct dependency;
- matching exact versions for the three CopilotKit packages and for React/
  React DOM;
- an exact `npm@x.y.z` `packageManager` value and a matching local npm runtime;
- npm lockfile version 3, direct-dependency agreement, SHA-512 integrity, and
  credential-free HTTPS sources for every locked package;
- regular non-symlink manifest, lock, test, and build-evidence files;
- a non-empty flat test corpus;
- unchanged manifest, lock, and test corpus after install, tests, and build;
- a valid `.next/BUILD_ID` and standalone server artifact.

As of **2026-08-26**, the enforced public security floors are Next.js 15.5.21
for the 15.x line, Next.js 16.2.11 for the 16.x line, and React/React DOM
19.0.8, 19.1.9, or 19.2.8 for their respective lines. These floors correspond
to the current upstream advisories and are minimums, not a claim that any
specific CopilotKit combination has already passed this repository's build.
They must be re-audited when the dependency set changes.

This Draft stack intentionally adds the enforcement before selecting and
committing the final compatible package set and lockfile. Until the follow-up
lockfile slice supplies those exact artifacts and a supported-runtime build
passes, the Mission Control commands and `complete:local` fail during contract
preflight. That failure is the intended state and must not be presented as a
completed frontend validation.

Install, test, and build children receive a utility-only environment. Provider,
ARC, GitHub, registry-token, database, and unknown values are not forwarded.
The redacted Mission Control report records Node/npm versions, the package
manager, manifest and lock hashes, test count, and build-artifact hashes. The
complete local runner re-reads that report and re-hashes the manifest and lock
before accepting the benchmark result.

## Preflight

```bash
npm run local:preflight
```

The preflight performs a real non-streaming `/responses` freshness attestation,
then verifies the exact production Pi streaming/tool-call protocol in the same
filtered Agent child environment used by the benchmark. It also verifies the
installed ARC distributions, obtains an anonymous ARC key through the official
SDK, and freezes the dynamically discovered public game list. Output contains
hashes and safe metadata only; provider endpoint, key, model identifier, and ARC
key are absent.

## One complete local execution

```bash
npm run complete:local -- --max-rounds=6
```

The command acquires a local process lock and runs, in order:

1. the locked Mission Control install, complete test corpus, and production build;
2. all root Node regression tests;
3. the repository secret scan;
4. the real-provider/official-ARC preflight;
5. the full public benchmark and detector-driven repair loop.

A failed or missing Mission Control report, a package-manager mismatch, a lock
mutation, skipped tests, or a missing build artifact stops the sequence before
Provider or ARC execution. The final local-completion report includes the exact
package-manager and lock digest and rejects evidence that changes later in the
same run.

The package command routes through the guarded entrypoint. Utility stages do
not receive Provider or ARC credentials; Provider-facing and ARC-facing stages
receive only their respective profile. The canonical repair command installs
the same guard before importing the v4 implementation, so nested benchmark and
Git subprocesses cannot silently recover the parent environment.

Every repair round uses:

- the real Pi SDK loop;
- the complete dynamically discovered public set;
- automatic anonymous ARC auth;
- private exact trajectories;
- the authoritative integrity gate and detector registry;
- per-game persistent repair guidance for the next real-provider round.

The command exits successfully only when the Mission Control gate passes and a
complete benchmark round has an official scorecard value, every registered
detector executes, trajectory integrity is valid, parse errors are zero, and
open findings are zero. Reaching the round limit, losing provider connectivity,
missing a game, lacking an official score, or failing frontend validation fails
closed.

Private files are stored under `runs/private/`; redacted reports are stored
under `runs/public/`. Both paths are ignored by Git except for the existing
placeholder. `SIGINT`, `SIGTERM`, and `SIGHUP` terminate the active process group,
write an interrupted report, and release the local lock.

## Lower-level commands

```bash
npm run mission-control:validate
npm run benchmark:local
npm run repair:local -- --max-rounds=6
node scripts/analyze-trajectories.mjs --help
```

`mission-control:validate` performs the complete locked frontend gate.
`benchmark:local` runs one complete public set. `repair:local` repeats complete
real-provider rounds and applies detector guidance. `complete:local` is the
recommended acceptance command because it includes frontend validation, root
tests, secret scanning, preflight, locking, and final score/cleanliness
validation.

The versioned repair-loop implementation files are internal components. Invoke
the stable package/script entrypoints so the child-process guard and provenance
boundary are active.

## No GitHub Actions fallback

There is intentionally no workflow or secret-bootstrap path in the active
branch. GitHub is used only for code review through unmerged issues and pull
requests. Benchmark execution, frontend installation/build, raw artifacts, and
provider credentials remain local.
