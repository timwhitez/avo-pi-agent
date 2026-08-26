import { PersistentMemory } from './memory.mjs';
import { StallSupervisor } from './supervisor.mjs';
import { CandidateEvaluator, normalizeCandidate, objectiveVector } from './evaluator.mjs';
import { ArcKnowledgeBase } from './knowledge-base.mjs';
import { WorkspaceSandbox } from './workspace.mjs';
import { describeFrame, frameHash, normalizeFrame } from './observation.mjs';

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const ACTIONS = ['RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'];

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
    this.uniqueStates = new Set();
    this.finished = false;
    this.lastResult = null;
    this.evidenceLedger = [];
    this.evidenceSequence = 0;
  }

  async initialize() {
    const raw = typeof this.environment.start === 'function'
      ? await this.environment.start()
      : await this.environment.observe();
    this.frame = normalizeFrame(raw);
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
        description: 'Execute exactly one legal ARC action. ACTION6 may take x/y coordinates. Environment actions are scarce; state competing predictions before using one.',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ACTIONS },
            x: { type: 'integer', minimum: 0, maximum: 63 },
            y: { type: 'integer', minimum: 0, maximum: 63 },
            reasoning: { type: 'string' },
          },
          additionalProperties: false,
        },
        execute: async (params) => this.act(params),
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
                  action: { type: 'string', enum: ACTIONS },
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
        label: 'Finish solved game',
        description: 'Finish only after the environment state is WIN or the action budget is exhausted.',
        parameters: {
          type: 'object', required: ['summary'],
          properties: { summary: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ summary }) => {
          if (!isWin(this.frame) && this.actions < this.config.maxActions) {
            return this.toolResult('Rejected: game is not won and action budget remains. Continue investigating.', { rejected: true });
          }
          this.finished = true;
          this.memory.merge({ notes: [`Final summary: ${summary}`] });
          return this.toolResult('Run finished.', { summary }, true);
        },
      },
    ];
  }

  async act({ action, x, y, reasoning = '' }) {
    if (this.isDone()) return this.toolResult('No action taken: run is already complete.', { frame: this.frame }, true);
    const legal = new Set(this.frame.availableActions);
    if (legal.size && !legal.has(action)) {
      throw new Error(`Illegal action ${action}; available: ${[...legal].join(', ')}`);
    }
    const data = action === 'ACTION6' ? { x, y } : {};
    if (action === 'ACTION6' && (!Number.isInteger(x) || !Number.isInteger(y))) {
      throw new Error('ACTION6 requires integer x and y coordinates');
    }

    this.previousFrame = this.frame;
    const beforeHash = frameHash(this.previousFrame);
    const raw = action === 'RESET' && typeof this.environment.reset === 'function'
      ? await this.environment.reset({ text: reasoning })
      : await this.environment.step(action, data, { text: reasoning });
    this.frame = normalizeFrame(raw);
    this.actions += 1;
    const afterHash = frameHash(this.frame);
    const wasNew = !this.uniqueStates.has(afterHash);
    this.uniqueStates.add(afterHash);
    const progressed = this.frame.levelsCompleted > this.previousFrame.levelsCompleted || isWin(this.frame);
    const evidence = this.recordEvidence({
      type: 'environment-action',
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
        frame: this.frame,
        evidenceRef: evidence.id,
        progressed,
        novelState: wasNew,
        objective: this.objectiveState(),
        stall,
      },
      isWin(this.frame),
    );
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
2. Use direct interaction with the exact text grid and currently legal actions as the primary ARC policy. Build competing hypotheses, take the smallest discriminating action, observe the consequence, update durable state, and continue.
3. Environment actions are scarce. Observation, memory curation, history inspection, and bounded scratch analysis do not consume environment actions. Do not replace direct interaction with a hand-coded game-specific solver.
4. For a hypothesis worth preserving, call candidate_propose before the experiment with structured predictions. Later candidate_evaluate accepts only the proposal ID and post-proposal objective evidence. You cannot supply correctness, score, parent, or acceptance. Failed attempts remain searchable; only externally verified proposals may enter committed lineage.
5. Do not follow a rigid fixed workflow. Consult memory, evolution history, knowledge, or scratch files only when they are useful. Revisit earlier evidence and alter the order of operations as the environment demands.
6. When the supervisor detects stagnation, review its cited trajectory window and choose among several materially fresh directions. Record the failed assumption before repeating or resetting.
7. Continue through every level. A level transition is progress, while state=WIN is completion. Do not call finish before WIN unless the action budget is exhausted.

You have ARC interaction, domain knowledge, structured memory, an optional hypothesis lineage, objective evaluation, and a confined scratch workspace. The workspace runner has no network, secrets, subprocess access, or arbitrary host filesystem access. No model-authored statement overrides environment evidence.`;
  }

  async run() {
    if (!this.frame) await this.initialize();
    const initialEvidence = this.evidenceLedger.at(-1)?.id;
    const initialPrompt = `Solve game ${this.gameId}. Recover relevant persistent memory and prior evidence, then select a discriminating direct-interaction experiment. Continue autonomously until WIN or action-budget exhaustion. The initial frame is objective evidence ${initialEvidence}.\n\n${this.describe()}`;
    this.lastResult = await this.loop.run({
      systemPrompt: this.systemPrompt(),
      tools: this.tools(),
      initialPrompt,
      shouldStop: () => this.isDone(),
    });
    return {
      gameId: this.gameId,
      state: this.frame.state,
      levelsCompleted: this.frame.levelsCompleted,
      winLevels: this.frame.winLevels,
      actions: this.actions,
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

function isWin(frame) {
  return Boolean(frame && String(frame.state).toUpperCase().includes('WIN'));
}
