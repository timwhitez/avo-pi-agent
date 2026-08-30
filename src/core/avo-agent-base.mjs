import { PersistentMemory } from './memory.mjs';
import { StallSupervisor } from './supervisor.mjs';
import { CandidateEvaluator, normalizeCandidate, objectiveVector } from './evaluator.mjs';
import { ArcKnowledgeBase } from './knowledge-base.mjs';
import { WorkspaceSandbox } from './workspace.mjs';
import { describeFrame, frameHash, normalizeFrame } from './observation.mjs';

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const GAMEPLAY_ACTIONS = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'];
export const AVO_TOOL_NAMES = Object.freeze([
  'observe',
  'act',
  'reset',
  'knowledge_read',
  'workspace_list',
  'workspace_read',
  'workspace_write',
  'workspace_python',
  'memory_read',
  'evolution_read',
  'memory_update',
  'candidate_propose',
  'candidate_evaluate',
  'finish',
]);

export function effectiveAvoToolNames(workspaceMode = 'files-only') {
  return AVO_TOOL_NAMES.filter((name) => {
    if (workspaceMode === 'disabled' && name.startsWith('workspace_')) return false;
    if (name === 'workspace_python' && workspaceMode !== 'isolated-python') return false;
    return true;
  });
}

export class AvoArcAgent {
  constructor({ gameId, environment, loop, config, logger = console, captureScorecard = true }) {
    this.gameId = gameId;
    this.environment = environment;
    this.loop = loop;
    this.config = config;
    this.logger = logger;
    this.captureScorecard = captureScorecard;
    this.memory = new PersistentMemory(config.memoryDir, gameId).load();
    this.knowledge = new ArcKnowledgeBase();
    this.evaluator = new CandidateEvaluator();
    this.workspace = new WorkspaceSandbox({
      root: config.workspaceDir || `${config.memoryDir}-workspaces`,
      gameId,
      python: config.python || 'python',
      timeoutMs: config.workspacePythonTimeoutMs || 10_000,
    });
    this.supervisor = new StallSupervisor(config.stallWindow);
    this.frame = null;
    this.previousFrame = null;
    this.actions = 0;
    this.gameplayActions = 0;
    this.resets = 0;
    this.rejectedCommands = 0;
    this.terminalRejectedCommands = 0;
    this.fullResets = 0;
    this.episodeSequence = 1;
    this.uniqueStates = new Set();
    this.finished = false;
    this.lastResult = null;
    this.evidenceLedger = [];
    this.evidenceSequence = 0;
    this.executionGuids = [];
  }

  async initialize() {
    const raw = typeof this.environment.start === 'function'
      ? await this.environment.start()
      : await this.environment.observe();
    this.frame = normalizeFrame(raw);
    this.executionGuids.push(this.frame.guid);
    this.uniqueStates.add(frameHash(this.frame));
    this.recordEvidence({ type: 'initial-observation', frame: this.frame });
  }

  isDone() {
    return this.finished || this.actions >= this.config.maxActions || isWin(this.frame);
  }

  objectiveState() {
    return objectiveVector({
      frame: this.frame,
      actions: this.actions,
      uniqueStates: this.uniqueStates.size,
    });
  }

  tools() {
    return [
      {
        name: 'observe',
        label: 'Observe exact ARC frame',
        description: 'Read the exact current grid, game state, progress and available actions without spending an environment action. Returns an objective evidence reference.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const evidence = this.recordEvidence({ type: 'observation', frame: this.frame });
          return this.toolResult(`${this.describe()}\nEVIDENCE_REF: ${evidence.id}`, { frame: this.frame, evidenceRef: evidence.id });
        },
      },
      {
        name: 'act',
        label: 'Take one ARC environment action',
        description: 'Execute one currently exposed gameplay action (ACTION1 through ACTION7). ACTION6 may take x/y coordinates. Use the separate reset controller when abandoning an episode.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            reasoning: { type: 'string' },
          },
          additionalProperties: false,
        },
        execute: async (params) => this.act(params),
      },
      {
        name: 'reset',
        label: 'Reset the ARC environment episode',
        description: 'Invoke the controller RESET operation even when RESET is absent from current gameplay affordances. It consumes one environment action and may perform a full reset; the returned frame is authoritative.',
        parameters: {
          type: 'object',
          properties: { rationale: { type: 'string' } },
          additionalProperties: false,
        },
        execute: async (params) => this.reset(params),
      },
      {
        name: 'knowledge_read',
        label: 'Consult AVO and ARC domain knowledge',
        description: 'Search the domain-specific knowledge base. Use it when choosing experiments, interpreting competition constraints, or revising a stalled strategy.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
        execute: async ({ query = '', limit = 8 } = {}) => {
          const entries = this.knowledge.search(query, limit);
          return this.toolResult(JSON.stringify(entries, null, 2), { entries });
        },
      },
      {
        name: 'workspace_list',
        label: 'List analysis workspace files',
        description: 'List bounded per-game scratch files for notes, transition tables, and compact analysis. The ARC policy remains direct interaction; this workspace persists outside the model context.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const files = this.workspace.list();
          return this.toolResult(JSON.stringify(files, null, 2), { files });
        },
      },
      {
        name: 'workspace_read',
        label: 'Read an analysis workspace file',
        description: 'Read a UTF-8 .py, .json, .md, .txt, or .csv file from the confined per-game workspace.',
        parameters: {
          type: 'object', required: ['path'],
          properties: { path: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ path }) => {
          const content = this.workspace.read(path);
          return this.toolResult(content, { path, bytes: Buffer.byteLength(content, 'utf8') });
        },
      },
      {
        name: 'workspace_write',
        label: 'Write an analysis workspace file',
        description: 'Create or replace a bounded scratch file for transition tables, hypotheses, calculations, or reusable analysis code. Do not replace direct environment interaction with a hand-coded game solver.',
        parameters: {
          type: 'object', required: ['path', 'content'],
          properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ path, content }) => {
          const result = this.workspace.write(path, content);
          return this.toolResult(`Workspace file written: ${result.path} (${result.bytes} bytes).`, result);
        },
      },
      {
        name: 'workspace_python',
        label: 'Run bounded Python analysis',
        description: 'Run bounded Python scratch analysis with stripped secrets, resource limits, no subprocesses, and no network. Use it for compact grid calculations when useful; it does not consume an ARC action and must not become the primary ARC policy.',
        parameters: {
          type: 'object', required: ['code'],
          properties: { code: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ code }) => {
          const result = await this.workspace.runPython(code);
          const text = result.ok
            ? `PYTHON_OK\nSTDOUT:\n${result.stdout || '<empty>'}\nSTDERR:\n${result.stderr || '<empty>'}`
            : `PYTHON_ERROR: ${result.error}\nSTDOUT:\n${result.stdout || '<empty>'}\nSTDERR:\n${result.stderr || '<empty>'}`;
          return this.toolResult(text, result);
        },
      },
      {
        name: 'memory_read',
        label: 'Read persistent game memory',
        description: 'Read structured discoveries and a summary of committed lineage, failed attempts, and supervisor interventions retained across turns and levels.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const snapshot = this.memory.snapshot();
          return this.toolResult(JSON.stringify(snapshot, null, 2), { memory: snapshot });
        },
      },
      {
        name: 'evolution_read',
        label: 'Read proposals, evaluated attempts, and committed lineage',
        description: 'Inspect pre-experiment proposals, pending hypotheses, externally evaluated failed attempts, committed lineage parents, and supervisor history.',
        parameters: {
          type: 'object',
          properties: {
            proposalLimit: { type: 'integer', minimum: 1, maximum: 200 },
            attemptLimit: { type: 'integer', minimum: 1, maximum: 200 },
            committedLimit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
        execute: async ({ proposalLimit = 100, attemptLimit = 100, committedLimit = 100 } = {}) => {
          const evolution = this.memory.evolution({ proposalLimit, attemptLimit, committedLimit });
          return this.toolResult(JSON.stringify(evolution, null, 2), { evolution });
        },
      },
      {
        name: 'memory_update',
        label: 'Update persistent memory',
        description: 'Merge validated discoveries. Valid keys: actionSemantics, objects, goals, invariants, failedHypotheses, provenStrategies, notes.',
        parameters: {
          type: 'object', required: ['patch'],
          properties: { patch: OBJECT_SCHEMA }, additionalProperties: false,
        },
        execute: async ({ patch }) => {
          const snapshot = this.memory.merge(patch);
          return this.toolResult('Memory updated.', { memory: snapshot });
        },
      },
      {
        name: 'candidate_propose',
        label: 'Persist a testable hypothesis before acting',
        description: 'Create a durable pre-experiment proposal with structured action predictions. This is optional, but use it for hypotheses worth retaining or comparing across contexts.',
        parameters: {
          type: 'object',
          required: ['hypothesis', 'plan', 'predictions'],
          properties: {
            hypothesis: { type: 'string' },
            plan: { type: 'string' },
            predictions: {
              type: 'array', minItems: 1, maxItems: 32,
              items: {
                type: 'object', required: ['action', 'expected'], additionalProperties: false,
                properties: {
                  action: { type: 'string', enum: GAMEPLAY_ACTIONS },
                  data: OBJECT_SCHEMA,
                  expected: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      changed: { type: 'boolean' },
                      levelDeltaAtLeast: { type: 'integer', minimum: 0 },
                      state: { type: 'string' },
                      afterHash: { type: 'string' },
                    },
                  },
                  rationale: { type: 'string' },
                },
              },
            },
          },
          additionalProperties: false,
        },
        execute: async (input) => this.proposeCandidate(input),
      },
      {
        name: 'candidate_evaluate',
        label: 'Externally evaluate one prior proposal',
        description: 'Evaluate a durable proposal against post-proposal observe/act evidence. The model cannot provide score, correctness, acceptance, or parent fields.',
        parameters: {
          type: 'object',
          required: ['proposalId', 'evidenceRefs'],
          properties: {
            proposalId: { type: 'string' },
            evidenceRefs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
          },
          additionalProperties: false,
        },
        execute: async (input) => this.evaluateCandidate(input),
      },
      {
        name: 'finish',
        label: 'Finish the current run',
        description: 'Finish after WIN, GAME_OVER, ERROR, or action-budget exhaustion. On GAME_OVER, choose either finish or the separate reset controller.',
        parameters: {
          type: 'object', required: ['summary'],
          properties: { summary: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ summary }) => {
          if (episodeState(this.frame) === 'ACTIVE' && this.actions < this.config.maxActions) {
            return this.toolResult('Rejected: the current episode is active and the action budget remains.', { rejected: true });
          }
          this.finished = true;
          this.memory.merge({ notes: [`Final summary: ${summary}`] });
          return this.toolResult('Run finished.', { summary }, true);
        },
      },
    ];
  }

  async act({ action, x, y, reasoning = '' } = {}) {
    if (this.finished || this.actions >= this.config.maxActions) {
      return this.toolResult('No action taken: run is already complete.', { frame: this.frame }, true);
    }
    const lifecycle = episodeState(this.frame);
    if (lifecycle !== 'ACTIVE') {
      return this.rejectCommand(
        'EPISODE_TERMINAL',
        `${lifecycle} ends the current episode; use reset to recover or finish to stop`,
        { action, reasoning },
      );
    }
    if (!GAMEPLAY_ACTIONS.includes(action)) {
      return this.rejectCommand('INVALID_GAMEPLAY_ACTION', `${String(action)} is not a gameplay action`, { action, reasoning });
    }
    const legal = new Set(this.frame.availableActions);
    if (!legal.has(action)) {
      return this.rejectCommand(
        'ACTION_UNAVAILABLE',
        `${action} is unavailable; available gameplay actions: ${[...legal].filter((item) => item !== 'RESET').join(', ') || '<none>'}`,
        { action, reasoning },
      );
    }
    const data = action === 'ACTION6' ? { x, y } : {};
    if (action === 'ACTION6'
        && (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 63 || y < 0 || y > 63)) {
      return this.rejectCommand('ACTION6_COORDINATES_REQUIRED', 'ACTION6 requires integer x and y coordinates from 0 through 63', { action, reasoning });
    }

    const previousFrame = this.frame;
    const raw = await this.environment.step(action, data, { text: reasoning });
    return this.acceptEnvironmentTransition({ raw, previousFrame, action, data, reasoning, kind: 'gameplay' });
  }

  async reset({ rationale = '' } = {}) {
    if (this.isDone()) return this.toolResult('No reset performed: run is already complete.', { frame: this.frame }, true);
    if (typeof rationale !== 'string' || !rationale.trim()) {
      return this.rejectCommand('RESET_RATIONALE_REQUIRED', 'reset requires a non-empty rationale', { action: 'RESET' });
    }
    if (typeof this.environment.reset !== 'function') {
      return this.rejectCommand('RESET_UNAVAILABLE', 'environment controller does not support reset', { action: 'RESET', reasoning: rationale });
    }

    const previousFrame = this.frame;
    const raw = await this.environment.reset({ text: rationale });
    return this.acceptEnvironmentTransition({
      raw,
      previousFrame,
      action: 'RESET',
      data: {},
      reasoning: rationale,
      kind: 'reset',
    });
  }

  acceptEnvironmentTransition({ raw, previousFrame, action, data, reasoning, kind }) {
    this.previousFrame = previousFrame;
    const beforeHash = frameHash(previousFrame);
    this.frame = normalizeFrame(raw);
    if (this.frame.fullReset) this.executionGuids.push(this.frame.guid);
    this.actions += 1;
    if (kind === 'reset') {
      this.resets += 1;
      this.episodeSequence += 1;
      if (this.frame.fullReset) this.fullResets += 1;
    } else {
      this.gameplayActions += 1;
    }
    const afterHash = frameHash(this.frame);
    const wasNew = !this.uniqueStates.has(afterHash);
    this.uniqueStates.add(afterHash);
    const progressed = this.frame.levelsCompleted > this.previousFrame.levelsCompleted || isWin(this.frame);
    const evidence = this.recordEvidence({
      type: kind === 'reset' ? 'environment-reset' : 'environment-action',
      action,
      data,
      reasoning,
      beforeHash,
      frame: this.frame,
      levelDelta: this.frame.levelsCompleted - this.previousFrame.levelsCompleted,
    });

    this.supervisor.observe(evidence);
    const knowledgeHints = this.knowledge.search('stall experiment action semantics', 3);
    const stall = this.supervisor.status({
      legalActions: this.frame.availableActions,
      memory: this.memory.snapshot(),
      knowledgeHints,
    });

    if (progressed) {
      this.memory.merge({
        provenStrategies: [`Evidence ${evidence.id}: ${action} produced objective progress to level ${this.frame.levelsCompleted}; state=${this.frame.state}.`],
      });
    }
    if (stall.stalled && !stall.repeated) {
      this.memory.merge({ failedHypotheses: [`Supervisor detected ${stall.reason} at evidence ${evidence.id}.`] });
      this.memory.recordSupervisor(stall);
    }

    const supervisorText = stall.stalled
      ? `\nSUPERVISOR_INTERVENTION ${stall.id}:\n${stall.directions.map((direction, index) => `${index + 1}. ${direction.rationale} Next: ${direction.nextExperiment}`).join('\n')}`
      : '';
    return this.toolResult(
      `${this.describe()}\nEVIDENCE_REF: ${evidence.id}\nOBJECTIVE: progressed=${progressed} novel_state=${wasNew} actions=${this.actions}/${this.config.maxActions}${supervisorText}`,
      {
        ok: true,
        frame: this.frame,
        evidenceRef: evidence.id,
        progressed,
        novelState: wasNew,
        objective: this.objectiveState(),
        stall,
        fullReset: kind === 'reset' ? this.frame.fullReset : false,
        episodeId: this.episodeId(),
        telemetry: this.commandTelemetry(),
      },
      isWin(this.frame),
    );
  }

  rejectCommand(code, message, { action = null, reasoning = '' } = {}) {
    this.rejectedCommands += 1;
    if (code === 'EPISODE_TERMINAL') this.terminalRejectedCommands += 1;
    const evidence = this.recordEvidence({
      type: 'command-rejected',
      frame: this.frame,
      action,
      data: { code },
      reasoning,
    });
    return this.toolResult(
      `COMMAND_REJECTED ${code}: ${message}`,
      {
        ok: false,
        rejected: true,
        recoverable: true,
        code,
        message,
        frame: this.frame,
        evidenceRef: evidence.id,
        episodeId: this.episodeId(),
        telemetry: this.commandTelemetry(),
      },
    );
  }

  episodeId() {
    return `episode-${String(this.episodeSequence).padStart(6, '0')}`;
  }

  commandTelemetry() {
    return {
      environmentActions: this.actions,
      gameplayActions: this.gameplayActions,
      resets: this.resets,
      rejectedCommands: this.rejectedCommands,
      terminalRejectedCommands: this.terminalRejectedCommands,
      fullResets: this.fullResets,
      episodeId: this.episodeId(),
    };
  }

  scorecardExecutionGuids() {
    return this.executionGuids.slice();
  }

  async forwardingLifecycleTelemetry() {
    if (typeof this.environment.lifecycle !== 'function') {
      if (this.loop.kind === 'pi-sdk') {
        throw new Error('production environment does not expose forwarding lifecycle telemetry');
      }
      return { postTerminalGameplayActions: null };
    }
    const value = await this.environment.lifecycle();
    const forwarded = value?.gameplay_actions_forwarded ?? value?.gameplayActionsForwarded;
    const postTerminal = value?.post_terminal_gameplay_actions ?? value?.postTerminalGameplayActions;
    if (!Number.isSafeInteger(forwarded) || forwarded < 0
        || !Number.isSafeInteger(postTerminal) || postTerminal < 0) {
      throw new Error('environment forwarding lifecycle telemetry is malformed');
    }
    if (forwarded !== this.gameplayActions) {
      throw new Error('environment forwarded gameplay count differs from agent accounting');
    }
    return { postTerminalGameplayActions: postTerminal };
  }

  proposeCandidate(input) {
    const candidate = normalizeCandidate(input);
    if (!candidate.hypothesis || !candidate.plan || !candidate.predictions.length) {
      throw new Error('candidate proposal requires hypothesis, plan, and structured predictions');
    }
    const proposal = this.memory.proposeCandidate({
      gameId: this.gameId,
      candidate,
      baseline: {
        frameHash: frameHash(this.frame),
        levelsCompleted: Number(this.frame?.levelsCompleted || 0),
        actionIndex: this.actions,
        uniqueStates: this.uniqueStates.size,
      },
    });
    return this.toolResult(
      `Proposal ${proposal.id} persisted before experiment. Execute discriminating actions, then call candidate_evaluate with post-proposal evidence references.`,
      { proposal },
    );
  }

  evaluateCandidate({ proposalId, evidenceRefs }) {
    const proposal = this.memory.lineage.getProposal(proposalId);
    if (!proposal) throw new Error(`candidate proposal not found: ${proposalId}`);
    const best = this.memory.lineage.best();
    const evaluation = this.evaluator.evaluate({
      gameId: this.gameId,
      proposal,
      evidenceRefs,
      frame: this.frame,
      actions: this.actions,
      uniqueStates: this.uniqueStates.size,
      evidenceLedger: this.evidenceLedger,
      bestRecord: best,
      currentHead: this.memory.lineage.head,
      committedRecords: this.memory.lineage.committed,
    });
    const record = this.memory.evaluateCandidate({ proposalId, evaluation });
    if (!record.accepted) {
      this.memory.merge({
        failedHypotheses: [`Rejected attempt ${record.id}: ${record.candidate.hypothesis}. ${evaluation.reasons.join('; ')}`],
      });
    }
    return this.toolResult(
      record.accepted
        ? `Proposal ${proposalId} passed external correctness and candidate ${record.id} was committed. Objective vector=${JSON.stringify(evaluation.scoreVector.named)}.`
        : `Attempt ${record.id} remains in trajectory only and was not committed: ${evaluation.reasons.join('; ')}.`,
      { proposal, record, best: this.memory.lineage.best() },
    );
  }

  recordEvidence({ type, frame, action = null, data = {}, reasoning = '', beforeHash = null, levelDelta = 0 }) {
    this.evidenceSequence += 1;
    const event = Object.freeze({
      id: `evidence-${String(this.evidenceSequence).padStart(6, '0')}`,
      gameId: this.gameId,
      type,
      action,
      data: data && typeof data === 'object' ? structuredClone(data) : {},
      reasoning: String(reasoning || '').slice(0, 1000),
      beforeHash,
      afterHash: frameHash(frame),
      frameHash: frameHash(frame),
      levelsCompleted: Number(frame?.levelsCompleted || 0),
      levelDelta: Number(levelDelta || 0),
      state: String(frame?.state || 'UNKNOWN'),
      availableActions: Array.isArray(frame?.availableActions) ? frame.availableActions.slice() : [],
      actionIndex: this.actions,
      fullReset: Boolean(frame?.fullReset),
      episodeId: this.episodeId(),
      createdAt: new Date().toISOString(),
    });
    this.evidenceLedger.push(event);
    if (this.evidenceLedger.length > 2000) this.evidenceLedger.shift();
    return event;
  }

  describe() {
    return describeFrame(this.frame, this.previousFrame);
  }

  toolResult(text, details = {}, terminate = false) {
    return { text, details, terminate };
  }

  systemPrompt() {
    return `You are the autonomous variation operator for one ARC-AGI-3 game, running inside the official Pi agent loop.

AVO contract:
1. You control the whole long-horizon loop. Decide what prior memory, proposals, failed attempts, and knowledge to consult; which direct environment experiment to run; when to preserve a testable hypothesis; and how to recover after incorrect assumptions.
2. Use direct interaction with the exact text grid and currently legal gameplay actions as the primary ARC policy. Build competing hypotheses, take the smallest discriminating action, observe the consequence, update durable state, and continue.
3. Gameplay actions and the separate reset controller both consume environment actions. RESET may remain available when it is absent from frame gameplay affordances and may perform a full reset; trust the returned fullReset and episode evidence. Observation, memory curation, history inspection, and bounded scratch analysis do not consume environment actions. Do not replace direct interaction with a hand-coded game-specific solver.
4. For a hypothesis worth preserving, call candidate_propose before the experiment with structured predictions. Later candidate_evaluate accepts only the proposal ID and post-proposal objective evidence. You cannot supply correctness, score, parent, or acceptance. Failed attempts remain searchable; only externally verified proposals may enter committed lineage.
5. Do not follow a rigid fixed workflow. Consult memory, evolution history, knowledge, or scratch files only when they are useful. Revisit earlier evidence and alter the order of operations as the environment demands.
6. When the supervisor detects stagnation, review its cited trajectory window and choose among several materially fresh directions. Record the failed assumption before repeating or resetting.
7. Continue through every level while the episode is active. State=WIN completes the run. State=GAME_OVER or ERROR ends the episode: choose the separate reset controller with a new plan, or call finish. Action and turn budgets are ceilings, never targets to consume.

You have ARC interaction, domain knowledge, structured memory, an optional hypothesis lineage, objective evaluation, and a confined scratch workspace. The workspace runner has no network, secrets, subprocess access, or arbitrary host filesystem access. No model-authored statement overrides environment evidence.`;
  }

  async run() {
    if (!this.frame) await this.initialize();
    const initialEvidence = this.evidenceLedger.at(-1)?.id;
    const initialPrompt = `Solve game ${this.gameId}. Recover relevant persistent memory and prior evidence, then select a discriminating direct-interaction experiment. While the episode is active, pursue WIN without spending actions merely because budget remains. On GAME_OVER or ERROR, choose reset with a new plan or finish. The initial frame is objective evidence ${initialEvidence}.\n\n${this.describe()}`;
    this.lastResult = await this.loop.run({
      systemPrompt: this.systemPrompt(),
      tools: this.tools(),
      initialPrompt,
      shouldStop: () => this.isDone(),
    });
    const forwardingLifecycle = await this.forwardingLifecycleTelemetry();
    return {
      gameId: this.gameId,
      state: this.frame.state,
      levelsCompleted: this.frame.levelsCompleted,
      winLevels: this.frame.winLevels,
      actions: this.actions,
      gameplayActions: this.gameplayActions,
      resets: this.resets,
      rejectedCommands: this.rejectedCommands,
      terminalRejectedCommands: this.terminalRejectedCommands,
      postTerminalGameplayActions: forwardingLifecycle.postTerminalGameplayActions,
      fullResets: this.fullResets,
      episodeId: this.episodeId(),
      objective: this.objectiveState(),
      won: isWin(this.frame),
      loop: this.loop.kind,
      error: this.lastResult?.error ?? null,
      lineage: {
        proposals: this.memory.lineage.proposals.length,
        pending: this.memory.lineage.pendingProposals().length,
        committed: this.memory.lineage.committed.length,
        attempts: this.memory.lineage.attempts.length,
      },
      scorecard: this.captureScorecard && typeof this.environment.scorecard === 'function'
        ? await this.environment.scorecard().catch(() => null)
        : null,
    };
  }
}

export function episodeState(frame) {
  const state = String(frame?.state || '').trim().toUpperCase();
  if (state === 'WIN' || state === 'GAME_OVER' || state === 'ERROR') return state;
  return 'ACTIVE';
}

function isWin(frame) {
  return episodeState(frame) === 'WIN';
}
