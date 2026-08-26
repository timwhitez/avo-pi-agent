#!/usr/bin/env node
import { loadLocalEnv } from '../src/config.mjs';
import { redactRuntimeSecrets } from '../src/redaction.mjs';
import { attestPiProviderStream } from '../src/benchmark/pi-stream-attestation.mjs';
import {
  discoverPublicGames,
  inspectOfficialArcRuntime,
  preflightResponsesProvider,
  requireRealProviderEnvironment,
} from '../src/benchmark/provenance.mjs';

loadLocalEnv();

try {
  assertLocalExecution();
  assertNodeVersion(22, 19);
  await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
  ]);

  const provider = requireRealProviderEnvironment();
  const providerPreflight = await preflightResponsesProvider(provider);
  const piStreamPreflight = await attestPiProviderStream();
  const python = process.env.AVO_REAL_PYTHON || '.venv/bin/python';
  const arcRuntime = await inspectOfficialArcRuntime({ python });

  // The official SDK obtains an anonymous ARC key when ARC_API_KEY is empty.
  // The generated value remains in the Python process and is never returned.
  process.env.AVO_ARC_AUTH_MODE = 'anonymous-auto';
  process.env.ARC_API_KEY = '';
  const games = await discoverPublicGames({ python });

  console.log(JSON.stringify({
    ok: true,
    execution: 'local',
    node: process.versions.node,
    pythonCommand: python,
    piPackagesPresent: true,
    provider: {
      wireApi: 'responses',
      requestAttested: providerPreflight.ok === true,
      piStreamAttested: piStreamPreflight.ok === true,
      piStream: piStreamPreflight,
      responseIdHash: providerPreflight.responseIdHash,
      usage: providerPreflight.usage,
    },
    arc: {
      runtime: arcRuntime,
      auth: games.arcAuth || { mode: 'anonymous-auto', keyAcquired: true, keySource: 'official-sdk' },
      publicGameCount: games.length,
      publicGameIds: games.map((game) => game.gameId),
    },
  }, null, 2));
} catch (error) {
  console.error(`LOCAL_PREFLIGHT_FAILED: ${redactRuntimeSecrets(error?.message || error)}`);
  process.exitCode = 1;
}

function assertLocalExecution() {
  if (String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true') {
    throw new Error('local preflight refuses to run inside GitHub Actions');
  }
}

function assertNodeVersion(requiredMajor, requiredMinor) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
    throw new Error(`Node ${requiredMajor}.${requiredMinor}+ is required; found ${process.versions.node}`);
  }
}
