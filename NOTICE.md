# Notice

This repository is an independent clean-room reconstruction of the publicly
described AVO architecture. It is not NVIDIA's internal AVO implementation and
does not contain NVIDIA source code, prompts, private traces, or private ARC
solutions.

The production loop integrates the MIT-licensed Pi Agent Harness packages:
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.

ARC-AGI-3 trademarks, game environments, SDKs, and evaluation services belong
to their respective owners. This repository contains only an adapter and does
not redistribute public, semi-private, or private game environment files.

The optional general browser profile installs browser-use 0.13.11 (MIT,
Copyright (c) 2024 Gregor Zunic) and browser-harness 0.1.13 (MIT,
Copyright (c) 2026 Browser Use). Their exact license texts are preserved in
[docs/licenses](docs/licenses). The resolved dependency closure has distinct
licenses; see the [installed-distribution inventory](docs/BROWSER_LICENSE_INVENTORY.md).
Unaudited entries remain unknown. This repository distributes the lock and
notices, not the wheels, Chrome, or native libraries. Those installed third-party
payloads retain their own license files/terms; they are not covered by this
repository's MIT license.
