import crypto from 'node:crypto';

import { PersistentMemory } from './memory.mjs';
import { StallSupervisor } from './supervisor.mjs';
import { HypothesisEvaluator, normalizeHypothesis, objectiveVector } from './evaluator.mjs';
import { ArcKnowledgeBase } from './knowledge-base.mjs';
import {
  filterToolsForPolicy,
  normalizePolicyProfile,
  policyInitialPrompt,
  policySystemPrompt,
  policyToolContract,
  policyUsesStrategy,
} from './policy-profile.mjs';
import { canonicalJson } from '../local/canonical-json.mjs';
import { WorkspaceSandbox } from './workspace.mjs';
import { TRAJECTORY_EVIDENCE_SCHEMA } from './evidence-store.mjs';
import {
  EPISODE_OBSERVATION_SCHEMA,
  TRANSITION_SCHEMA,
  describeFrame,
  frameHash,
  gridDelta,
  normalizeFrame,
  observationIdentity,
  transitionIdentity,
} from './observation.mjs';

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const GAMEPLAY_ACTIONS = ['ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'];
const MAX_ACTION_SEQUENCE = 20;
const MAX_TRAJECTORY_DIFF_CELLS = 128;
const CLAIM_REF_SCHEMA = { type: 'string', maxLength: 32, pattern: '^claim-[0-9]{6,16}$' };
const EVIDENCE_REF_SCHEMA = { type: 'string', maxLength: 64, pattern: '^evidence-[0-9]{6,}-[a-f0-9]{12}$' };
const ACTION_EXPECTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changed: { type: 'boolean' },
    levelDeltaAtLeast: { type: 'integer', minimum: 0, maximum: 10_000 },
    state: { type: 'string', minLength: 1, maxLength: 64 },
    afterHash: { type: 'string', pattern: '^[a-f0-9]{16}$' },
  },
};

export function effectiveAvoTools(workspaceMode = 'files-only', policyProfile) {
  return filterToolsForPolicy(
    SEALED_AVO_TOOLS,
    workspaceMode,
    policyProfile,
  );
}

export function effectiveAvoToolNames(workspaceMode = 'files-only', policyProfile) {
  return effectiveAvoTools(workspaceMode, policyProfile).map((tool) => tool.name);
}

export function effectiveAvoToolContract(workspaceMode = 'files-only', policyProfile) {
  return policyToolContract(effectiveAvoTools(workspaceMode, policyProfile));
}

export class AvoArcAgent {
  constructor({ gameId, environment, loop, config, logger = console, captureScorecard = true }) {
    this.gameId = gameId;
    this.environment = environment;
    this.loop = loop;
    this.config = config;
    const levelBudgets = config.perLevelBudgets ?? [];
    if (!Array.isArray(levelBudgets) || levelBudgets.some((budget) => !Number.isSafeInteger(budget) || budget < 1)) {
      throw new Error('perLevelBudgets must be an array of positive integers');
    }
    this.perLevelBudgets = levelBudgets.slice();
    this.levelActions = 0;
    this.currentLevel = 0;
    this.policyProfile = normalizePolicyProfile(config.policyProfile);
    this.strategyEnabled = policyUsesStrategy(this.policyProfile);
    this.logger = logger;
    this.captureScorecard = captureScorecard;
    this.memory = new PersistentMemory(config.memoryDir, gameId).load();
    this.knowledge = new ArcKnowledgeBase();
    this.hypothesisEvaluator = new HypothesisEvaluator();
    this.workspace = new WorkspaceSandbox({
      root: config.workspaceDir || `${config.memoryDir}-workspaces`,
      gameId,
      mode: config.workspaceMode || 'files-only',
      timeoutMs: config.workspacePythonTimeoutMs || 10_000,
      containerRuntime: config.workspaceContainerRuntime || 'docker',
      containerImage: config.workspaceContainerImage || 'python:3.12-slim',
    });
    this.supervisor = new StallSupervisor(config.stallWindow);
    this.frame = null;
    this.previousFrame = null;
    this.maxObservedLevelsCompleted = 0;
    this.observedTotalLevels = null;
    this.actions = 0;
    this.gameplayActions = 0;
    this.resets = 0;
    this.rejectedCommands = 0;
    this.terminalRejectedCommands = 0;
    this.fullResets = 0;
    this.actionSequences = 0;
    this.sequenceActionsRequested = 0;
    this.sequenceActionsExecuted = 0;
    this.sequenceActionsSkipped = 0;
    this.sequenceCancellations = 0;
    this.memoryClaimsProposed = 0;
    this.memoryClaimsConfirmed = 0;
    this.memoryClaimsCorrected = 0;
    this.memoryClaimsSurfaced = 0;
    this.executionError = null;
    this.episodeSequence = 1;
    this.uniqueStates = new Set();
    this.finished = false;
    this.lastResult = null;
    this.evidenceLedger = [];
    this.evidenceSequence = 0;
    this.attemptId = 'attempt-000001';
    this.currentObservationId = null;
    this.currentObservationRef = null;
    this.executionGuids = [];
  }

  async initialize() {
    const raw = typeof this.environment.start === 'function'
      ? await this.environment.start()
      : await this.environment.observe();
    this.frame = this.adoptFrame(raw);
    this.executionGuids.push(this.frame.guid);
    const evidence = this.recordEvidence({ type: 'initial-observation', frame: this.frame });
    this.uniqueStates.add(evidence.observationContentHash);
  }

  adoptFrame(raw) {
    const frame = normalizeFrame(raw);
    this.currentLevel = frame.levelsCompleted;
    this.maxObservedLevelsCompleted = Math.max(
      this.maxObservedLevelsCompleted,
      frame.levelsCompleted,
    );
    if (frame.totalLevels !== null) {
      if (this.observedTotalLevels !== null && this.observedTotalLevels !== frame.totalLevels) {
        throw new Error(
          `environment totalLevels changed from ${this.observedTotalLevels} to ${frame.totalLevels}`,
        );
      }
      this.observedTotalLevels = frame.totalLevels;
    }
    if (this.observedTotalLevels !== null
        && this.maxObservedLevelsCompleted > this.observedTotalLevels) {
      throw new Error('environment levelsCompleted exceeds the stable totalLevels');
    }
    return {
      ...frame,
      levelsCompleted: this.maxObservedLevelsCompleted,
      totalLevels: this.observedTotalLevels,
    };
  }

  isDone() {
    return this.finished || this.actionBudgetExhausted() || isWin(this.frame);
  }

  levelBudgetExhausted() {
    const budget = this.perLevelBudgets[this.currentLevel];
    return !isWin(this.frame) && budget !== undefined && this.levelActions >= budget;
  }

  actionBudgetExhausted() {
    return !isWin(this.frame)
      && (this.actions >= this.config.maxActions || this.levelBudgetExhausted());
  }

  runtimeStatus() {
    const state = episodeState(this.frame);
    const levelBudget = this.perLevelBudgets[this.currentLevel];
    if (this.executionError) {
      return {
        state,
        environmentActions: this.actions,
        maxActions: this.config.maxActions,
        terminalReason: 'execution_error',
        allowedNext: 'none; environment or durable state is uncertain; run is terminal',
      };
    }
    if (this.finished) {
      return {
        state,
        environmentActions: this.actions,
        maxActions: this.config.maxActions,
        terminalReason: 'explicit_finish',
        allowedNext: 'none; run is terminal',
      };
    }
    if (this.actionBudgetExhausted()) {
      return {
        state,
        environmentActions: this.actions,
        maxActions: this.config.maxActions,
        terminalReason: this.levelBudgetExhausted() ? 'level_action_budget_exhausted' : 'action_budget_exhausted',
        allowedNext: 'none; run is terminal',
      };
    }
    if (state === 'WIN') {
      return {
        state,
        environmentActions: this.actions,
        maxActions: this.config.maxActions,
        terminalReason: 'win',
        allowedNext: 'none; run is terminal',
      };
    }
    if (state === 'GAME_OVER' || state === 'ERROR') {
      return {
        state,
        environmentActions: this.actions,
        maxActions: this.config.maxActions,
        terminalReason: state === 'GAME_OVER' ? 'game_over' : 'environment_error',
        allowedNext: 'reset with a new plan or finish; gameplay actions are forbidden',
      };
    }
    return {
      state,
      environmentActions: this.actions,
      maxActions: this.config.maxActions,
      terminalReason: 'none',
      allowedNext: (this.strategyEnabled
        ? 'inspect evidence, take one currently legal gameplay action, or finish when no useful valid experiment remains; use memory and scratch tools only when useful'
        : 'inspect evidence, take one currently legal gameplay action, use the scratch workspace, or finish')
        + (levelBudget === undefined ? '' : `; current level ${this.currentLevel} action budget: ${this.levelActions}/${levelBudget}`),
    };
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
        label: 'Observe current ARC state',
        description: 'Read a compact current-state header without spending an environment action. The exact current grid (GRID_EXACT) ships with every state-changing act, act_sequence, or reset result. Unchanged state reuses its exact evidence ref; use trajectory_read for prior states, diffs, and regions.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const evidenceRef = this.currentObservationRef;
          if (!evidenceRef) throw new Error('current observation has no durable evidence reference');
          return this.withRelevantMemory(this.toolResult(
            `${this.describe(this.frame, evidenceRef)}\nEVIDENCE_REF: ${evidenceRef}`,
            { frame: this.frame, evidenceRef, contextExactEvidence: false },
          ), 'current observation');
        },
      },
      {
        name: 'trajectory_read',
        label: 'Read exact durable trajectory evidence',
        description: 'Get exact prior observations/transitions by evidence ref, read one bounded grid region, diff two refs, or page bounded summaries. Use part=after for the exact grid of a prior state; the current grid ships with every state-changing act, act_sequence, and reset result. When ref is present it selects exact-ref mode and startSequence/limit are ignored.',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', pattern: '^evidence-[0-9]{6,}-[a-f0-9]{12}$' },
            startSequence: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 8 },
            part: { type: 'string', enum: ['summary', 'event', 'before', 'after', 'region', 'diff'] },
            compareRef: { type: 'string', pattern: '^evidence-[0-9]{6,}-[a-f0-9]{12}$' },
            x: { type: 'integer', minimum: 0, maximum: 63 },
            y: { type: 'integer', minimum: 0, maximum: 63 },
            width: { type: 'integer', minimum: 1, maximum: 64 },
            height: { type: 'integer', minimum: 1, maximum: 64 },
          },
          additionalProperties: false,
        },
        execute: async (input) => this.readTrajectory(input),
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
        execute: async (params) => this.withRelevantMemory(await this.act(params), params?.reasoning),
      },
      {
        name: 'act_sequence',
        label: 'Execute a bounded gameplay action sequence',
        description: 'Execute 1–20 gameplay actions through the same guarded single-step path. Every transition is retained. The remaining tail is skipped on progress, terminal state, budget exhaustion, rejection, expectation mismatch, or execution failure.',
        parameters: {
          type: 'object',
          required: ['steps'],
          properties: {
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_ACTION_SEQUENCE,
              items: {
                type: 'object',
                required: ['action'],
                additionalProperties: false,
                properties: {
                  action: { type: 'string', minLength: 1, maxLength: 32 },
                  x: { type: 'integer' },
                  y: { type: 'integer' },
                  reasoning: { type: 'string', maxLength: 1000 },
                  expected: ACTION_EXPECTATION_SCHEMA,
                },
              },
            },
          },
          additionalProperties: false,
        },
        execute: async (params) => this.actSequence(params),
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
        execute: async (params) => this.withRelevantMemory(await this.reset(params), params?.rationale),
      },
      {
        name: 'knowledge_read',
        strategic: true,
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
        description: 'Read a bounded page of a UTF-8 .py, .json, .md, .txt, or .csv scratch file. For longer files, repeat with the returned nextOffset. Offsets and limits count UTF-16 code units; pages never split a Unicode character.',
        parameters: {
          type: 'object', required: ['path'],
          properties: {
            path: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 24_000 },
          }, additionalProperties: false,
        },
        execute: async (input) => this.readWorkspace(input),
      },
      {
        name: 'workspace_write',
        label: 'Write an analysis workspace file',
        description: 'Create or replace a bounded scratch file for notes, tables, calculations, or analysis code. Workspace writes do not interact with the ARC environment.',
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
        description: 'Run bounded Python scratch analysis with stripped secrets, resource limits, no subprocesses, and no network. It does not consume an ARC action or interact with the ARC environment.',
        parameters: {
          type: 'object', required: ['code'],
          properties: { code: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ code }) => {
          const result = await this.workspace.runPython(code);
          const text = result.ok
            ? `PYTHON_OK\nSTDOUT:\n${result.stdout || '<empty>'}\nSTDERR:\n${result.stderr || '<empty>'}`
            : `PYTHON_ERROR: ${result.error}\nSTDOUT:\n${result.stdout || '<empty>'}\nSTDERR:\n${result.stderr || '<empty>'}`;
          return this.toolResult(`${text}${result.stdoutTruncated ? '\nSTDOUT_TRUNCATED' : ''}${result.stderrTruncated ? '\nSTDERR_TRUNCATED' : ''}`, result);
        },
      },
      {
        name: 'memory_read',
        strategic: true,
        label: 'Read persistent game memory',
        description: 'Read harness notes, hypothesis-journal counts, and one bounded page of typed claims. Page or filter claims by stable ID sequence, status, and local text query.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', maxLength: 1000 },
            status: { type: 'string', enum: ['all', 'proposed', 'confirmed', 'contradicted', 'superseded'] },
            startSequence: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 8 },
          },
          additionalProperties: false,
        },
        execute: async (input = {}) => {
          const snapshot = this.memory.snapshot();
          const claimPage = this.memory.queryClaims(input);
          const memory = { ...snapshot, claimPage };
          return this.toolResult(JSON.stringify(memory, null, 2), { memory });
        },
      },
      {
        name: 'journal_read',
        strategic: true,
        label: 'Read hypothesis and evidence history',
        description: 'Inspect optional pre-experiment hypotheses, pending proposals, later evidence evaluations, and supervisor history. Confirmation records prediction agreement only; it does not install behavior.',
        parameters: {
          type: 'object',
          properties: {
            proposalLimit: { type: 'integer', minimum: 1, maximum: 200 },
            evaluationLimit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
        execute: async ({ proposalLimit = 100, evaluationLimit = 100 } = {}) => {
          const journal = this.memory.hypothesisJournal({ proposalLimit, evaluationLimit });
          return this.toolResult(JSON.stringify(journal, null, 2), { journal });
        },
      },
      {
        name: 'memory_update',
        strategic: true,
        label: 'Curate one typed persistent-memory claim',
        description: 'Propose a hypothesis, confirm it with retrievable evidence, or create an evidence-backed contradiction/supersession while retaining the old claim.',
        parameters: {
          type: 'object',
          required: ['operation'],
          properties: {
            operation: { type: 'string', enum: ['propose', 'confirm', 'contradict', 'supersede'] },
            claimId: CLAIM_REF_SCHEMA,
            subject: { type: 'string', minLength: 1, maxLength: 64 },
            type: { type: 'string', minLength: 1, maxLength: 64 },
            content: { type: 'string', minLength: 1, maxLength: 2000 },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            importance: { type: 'integer', minimum: 0, maximum: 100 },
            tags: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 } },
            evidenceRefs: { type: 'array', maxItems: 16, items: EVIDENCE_REF_SCHEMA },
            supports: { type: 'array', maxItems: 16, items: CLAIM_REF_SCHEMA },
            contradicts: { type: 'array', maxItems: 16, items: CLAIM_REF_SCHEMA },
            derivedFrom: { type: 'array', maxItems: 16, items: CLAIM_REF_SCHEMA },
          },
          additionalProperties: false,
        },
        execute: async (input) => this.updateMemoryClaim(input),
      },
      {
        name: 'hypothesis_propose',
        strategic: true,
        label: 'Persist a testable hypothesis before acting',
        description: 'Create a durable pre-experiment proposal with structured action predictions. This is optional; use it only when an evidence-linked record is useful.',
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
        execute: async (input) => this.proposeHypothesis(input),
      },
      {
        name: 'hypothesis_evaluate',
        strategic: true,
        label: 'Check one hypothesis against later evidence',
        description: 'Compare a durable proposal with exact later ledger evidence from its baseline attempt and episode. New actions after restart or full reset require a new proposal. The model cannot provide the outcome. Confirmation means only that declared predictions matched.',
        parameters: {
          type: 'object',
          required: ['proposalId', 'evidenceRefs'],
          properties: {
            proposalId: { type: 'string' },
            evidenceRefs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 },
          },
          additionalProperties: false,
        },
        execute: async (input) => this.evaluateHypothesis(input),
      },
      {
        name: 'finish',
        label: 'Finish the current run',
        description: 'Explicitly end the run after WIN, GAME_OVER, ERROR, action-budget exhaustion, or from ACTIVE. GAME_OVER and ERROR also permit the separate reset controller.',
        parameters: {
          type: 'object', required: ['summary'],
          properties: { summary: { type: 'string' } }, additionalProperties: false,
        },
        execute: async ({ summary }) => {
          this.finished = true;
          return this.toolResult('Run finished.', { summary }, true);
        },
      },
    ];
  }

  async act({ action, x, y, reasoning = '' } = {}, trace = null) {
    if (this.finished || this.actionBudgetExhausted()) {
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
    let phase = 'environment';
    try {
      if (trace) trace.phase = phase;
      const raw = await this.environment.step(action, data, { text: reasoning });
      phase = 'transition';
      if (trace) trace.phase = phase;
      const result = this.acceptEnvironmentTransition({ raw, previousFrame, action, data, reasoning, kind: 'gameplay' });
      if (trace) trace.phase = 'complete';
      return result;
    } catch (error) {
      this.finished = true;
      this.executionError = `action ${phase} failure`;
      throw new Error(this.executionError, { cause: error });
    }
  }

  async actSequence(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => key !== 'steps')) {
      throw new Error('act_sequence input is malformed');
    }
    const requested = normalizeActionSequence(input.steps);
    this.actionSequences += 1;
    this.sequenceActionsRequested += requested.length;

    const executed = [];
    const skipped = [];
    let stopReason = 'SEQUENCE_COMPLETE';
    let rejectionCode = null;
    let terminate = false;
    let stall = null;
    let lastExecutedBeforeFrame = null;

    for (const [index, step] of requested.entries()) {
      const before = this.frame;
      const beforeLevel = this.currentLevel;
      const beforeActions = this.actions;
      const beforeEvidenceSequence = this.evidenceSequence;
      const trace = { phase: 'guard' };
      let result;
      try {
        result = await this.act(step, trace);
      } catch {
        const evidence = this.evidenceLedger.at(-1);
        const durableTransition = trace.phase === 'transition'
          && this.actions === beforeActions + 1
          && this.evidenceSequence === beforeEvidenceSequence + 1
          && evidence?.type === 'environment-action'
          && evidence.action === step.action
          && evidence.actionIndex === this.actions;
        if (durableTransition) {
          executed.push(sequenceExecutedEntry(index, step, before, this.frame, evidence.id,
            this.currentLevel - beforeLevel));
          lastExecutedBeforeFrame ??= before;
          stopReason = 'INTERNAL_ERROR';
          appendSkipped(skipped, requested, index + 1, stopReason);
          this.executionError = 'action sequence post-transition failure';
        } else {
          stopReason = trace.phase === 'environment' ? 'ENVIRONMENT_ERROR' : 'INTERNAL_ERROR';
          appendSkipped(skipped, requested, index, stopReason);
          this.executionError = trace.phase === 'environment'
            ? 'action sequence environment failure'
            : 'action sequence transition failure';
        }
        this.finished = true;
        terminate = true;
        break;
      }

      if (result.details?.ok !== true) {
        rejectionCode = String(result.details?.code || 'RUN_COMPLETE');
        stopReason = rejectionCode === 'RUN_COMPLETE' ? 'RUN_COMPLETE' : 'ACTION_REJECTED';
        appendSkipped(skipped, requested, index, stopReason, result.details?.evidenceRef);
        terminate = Boolean(result.terminate);
        break;
      }

      const entry = sequenceExecutedEntry(index, step, before, this.frame, result.details.evidenceRef,
        result.details.currentLevelDelta);
      executed.push(entry);
      // Diff the final frame against the last model-visible grid (the frame
      // before the first executed step), so a trailing no-op stays honest.
      lastExecutedBeforeFrame ??= before;
      if (result.details.stall?.stalled) stall = result.details.stall;

      const lifecycle = episodeState(this.frame);
      if (lifecycle === 'WIN') stopReason = 'WIN';
      else if (lifecycle === 'GAME_OVER') stopReason = 'GAME_OVER';
      else if (lifecycle === 'ERROR') stopReason = 'ERROR';
      else if (entry.currentLevelDelta > 0) stopReason = 'LEVEL_PROGRESS';
      else if (this.actionBudgetExhausted()) stopReason = 'ACTION_BUDGET_EXHAUSTED';
      else if (entry.expectationMismatches.length) stopReason = 'EXPECTATION_MISMATCH';
      else if (stall) stopReason = 'SUPERVISOR_INTERVENTION';
      else continue;

      appendSkipped(skipped, requested, index + 1, stopReason);
      terminate = Boolean(result.terminate)
        || stopReason === 'WIN'
        || stopReason === 'ACTION_BUDGET_EXHAUSTED';
      break;
    }

    this.sequenceActionsExecuted += executed.length;
    this.sequenceActionsSkipped += skipped.length;
    if (skipped.length) this.sequenceCancellations += 1;
    const expectationFailed = executed.some((entry) => entry.expectationMismatches.length > 0);
    const details = {
      ok: !['ACTION_REJECTED', 'RUN_COMPLETE', 'ENVIRONMENT_ERROR', 'INTERNAL_ERROR'].includes(stopReason)
        && !expectationFailed,
      requested: requested.map((step, index) => ({ index, action: step.action, data: actionData(step) })),
      executed,
      skipped,
      stopReason,
      rejectionCode,
      ...(stall ? { stall } : {}),
      evidenceRef: executed.at(-1)?.evidenceRef
        ?? skipped.find((entry) => entry.evidenceRef)?.evidenceRef
        ?? this.currentObservationRef,
      contextExactEvidence: false,
      ...(lastExecutedBeforeFrame
        ? { finalFrameText: this.describe(lastExecutedBeforeFrame, this.currentObservationRef, { includeExactGrid: true }) }
        : {}),
      telemetry: this.commandTelemetry(),
    };
    return this.withRelevantMemory(
      this.toolResult('', details, terminate),
      requested.map((step) => step.reasoning).filter(Boolean).join(' '),
      'ACTION_SEQUENCE',
    );
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
    let phase = 'environment';
    try {
      const raw = await this.environment.reset({ text: rationale });
      phase = 'transition';
      return this.acceptEnvironmentTransition({
        raw,
        previousFrame,
        action: 'RESET',
        data: {},
        reasoning: rationale,
        kind: 'reset',
      });
    } catch (error) {
      this.finished = true;
      this.executionError = `reset ${phase} failure`;
      throw new Error(this.executionError, { cause: error });
    }
  }

  acceptEnvironmentTransition({ raw, previousFrame, action, data, reasoning, kind }) {
    const previousLevel = this.currentLevel;
    this.previousFrame = previousFrame;
    this.frame = this.adoptFrame(raw);
    const currentLevelDelta = this.currentLevel - previousLevel;
    if (this.frame.fullReset) this.executionGuids.push(this.frame.guid);
    this.actions += 1;
    // A full reset starts a fresh level budget; charge the reset itself to
    // that budget. Ordinary same-level resets retain their accumulated cost.
    this.levelActions = this.frame.fullReset
      ? 1
      : currentLevelDelta > 0 ? 0 : this.levelActions + 1;
    if (kind === 'reset') {
      this.resets += 1;
      this.episodeSequence += 1;
      if (this.frame.fullReset) this.fullResets += 1;
    } else {
      this.gameplayActions += 1;
    }
    const objectiveLevelDelta = this.frame.levelsCompleted - previousFrame.levelsCompleted;
    const progressed = objectiveLevelDelta > 0 || isWin(this.frame);
    const evidence = this.recordEvidence({
      type: kind === 'reset' ? 'environment-reset' : 'environment-action',
      action,
      data,
      reasoning,
      beforeFrame: previousFrame,
      frame: this.frame,
      levelDelta: objectiveLevelDelta,
    });
    const wasNew = !this.uniqueStates.has(evidence.observationContentHash);
    this.uniqueStates.add(evidence.observationContentHash);

    let stall = null;
    let supervisorText = '';
    if (this.strategyEnabled) {
      this.supervisor.observe(evidence);
      const knowledgeHints = this.knowledge.search('stall experiment action semantics', 3);
      stall = this.supervisor.status({
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
      supervisorText = stall.stalled
        ? `\nSUPERVISOR_INTERVENTION ${stall.id}:\n${stall.directions.map((direction, index) => `${index + 1}. ${direction.rationale} Next: ${direction.nextExperiment}`).join('\n')}`
        : '';
    }
    return this.toolResult(
      `${this.describe(previousFrame, this.currentObservationRef, { includeExactGrid: true })}\nEVIDENCE_REF: ${evidence.id}\nOBJECTIVE: progressed=${progressed} novel_state=${wasNew} actions=${this.actions}/${this.config.maxActions}${supervisorText}`,
      {
        ok: true,
        frame: this.frame,
        evidenceRef: evidence.id,
        contextExactEvidence: false,
        progressed,
        currentLevelDelta,
        novelState: wasNew,
        objective: this.objectiveState(),
        ...(stall ? { stall } : {}),
        fullReset: kind === 'reset' ? this.frame.fullReset : false,
        episodeId: this.episodeId(),
        telemetry: this.commandTelemetry(),
      },
      this.isDone(),
    );
  }

  rejectCommand(code, message, { action = null, reasoning = '' } = {}) {
    this.rejectedCommands += 1;
    if (code === 'EPISODE_TERMINAL') this.terminalRejectedCommands += 1;
    const evidence = this.recordEvidence({
      type: 'command-rejected',
      beforeFrame: this.frame,
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
        contextExactEvidence: false,
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
      actionSequences: this.actionSequences,
      sequenceActionsRequested: this.sequenceActionsRequested,
      sequenceActionsExecuted: this.sequenceActionsExecuted,
      sequenceActionsSkipped: this.sequenceActionsSkipped,
      sequenceCancellations: this.sequenceCancellations,
      memoryClaimsProposed: this.memoryClaimsProposed,
      memoryClaimsConfirmed: this.memoryClaimsConfirmed,
      memoryClaimsCorrected: this.memoryClaimsCorrected,
      memoryClaimsSurfaced: this.memoryClaimsSurfaced,
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

  proposeHypothesis(input) {
    const hypothesis = normalizeHypothesis(input);
    if (!hypothesis.hypothesis || !hypothesis.plan || !hypothesis.predictions.length) {
      throw new Error('hypothesis proposal requires hypothesis, plan, and structured predictions');
    }
    const proposal = this.memory.proposeHypothesis({
      gameId: this.gameId,
      hypothesis,
      baseline: {
        evidenceRef: this.evidenceLedger.at(-1)?.id ?? null,
        frameHash: frameHash(this.frame),
        levelsCompleted: Number(this.frame?.levelsCompleted || 0),
        actionIndex: this.actions,
        uniqueStates: this.uniqueStates.size,
      },
    });
    return this.toolResult(
      `Hypothesis ${proposal.id} persisted before the experiment. After a discriminating action, call hypothesis_evaluate with exact post-proposal evidence references.`,
      { proposal },
    );
  }

  evaluateHypothesis({ proposalId, evidenceRefs }) {
    const proposal = this.memory.journal.getProposal(proposalId);
    if (!proposal) throw new Error(`hypothesis proposal not found: ${proposalId}`);
    const evaluation = this.hypothesisEvaluator.evaluate({
      gameId: this.gameId,
      proposal,
      evidenceRefs,
      evidenceLedger: this.claimEvidenceLedger(),
    });
    const record = this.memory.evaluateHypothesis({ proposalId, evaluation });
    const explanation = evaluation.outcome === 'confirmed'
      ? 'Declared predictions matched the cited later evidence. No policy, prompt, tool, or code was installed, and no objective improvement is claimed.'
      : evaluation.reasons.join('; ');
    return this.toolResult(
      `Hypothesis ${proposalId} outcome=${evaluation.outcome}. ${explanation}`,
      { proposal, record },
    );
  }

  updateMemoryClaim(input) {
    const outcome = this.memory.applyClaim(input, this.claimEvidenceLedger());
    if (outcome.operation === 'propose') this.memoryClaimsProposed += 1;
    else if (outcome.operation === 'confirm') this.memoryClaimsConfirmed += 1;
    else this.memoryClaimsCorrected += 1;
    const details = { ...outcome, telemetry: this.commandTelemetry() };
    return this.toolResult(JSON.stringify({ type: 'MEMORY_CLAIM', ...details }), details);
  }

  claimEvidenceLedger() {
    return this.evidenceLedger;
  }

  readWorkspace({ path, offset = 0, limit = 16_000 }) {
    if (!Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 24_000) {
      throw new Error('workspace_read requires a non-negative offset and limit from 1 through 24000');
    }
    const content = this.workspace.read(path);
    const maxChars = this.config.toolResultMaxChars ?? 24_000;
    if (!Number.isSafeInteger(maxChars) || maxChars <= 256) {
      throw new Error('workspace_read requires a tool result bound greater than 256 characters');
    }
    if (offset > content.length || (offset > 0 && isSurrogateBoundary(content, offset))) {
      throw new Error('workspace_read offset must be within the file and on a Unicode character boundary');
    }
    let end = Math.min(content.length, offset + Math.min(limit, maxChars - 256));
    if (isSurrogateBoundary(content, end)) end -= 1;
    if (end === offset && offset < content.length) {
      throw new Error('workspace_read limit is too small for the next Unicode character');
    }
    const page = content.slice(offset, end);
    const pagination = { offset, nextOffset: end < content.length ? end : null, totalChars: content.length };
    const text = offset > 0 || end < content.length
      ? `${page}\nWORKSPACE_PAGE ${JSON.stringify(pagination)}` : page;
    return this.toolResult(text, { path, bytes: Buffer.byteLength(page, 'utf8'), ...pagination });
  }

  recordEvidence({
    type,
    frame,
    beforeFrame = null,
    action = null,
    data = {},
    reasoning = '',
    levelDelta = 0,
  }) {
    this.evidenceSequence += 1;
    const afterIdentity = observationIdentity(frame, {
      attemptId: this.attemptId,
      episodeId: this.episodeId(),
    });
    const beforeIdentity = beforeFrame ? observationIdentity(beforeFrame) : null;
    const beforeObservationId = beforeFrame ? this.currentObservationId : null;
    const transitionId = beforeObservationId
      ? transitionIdentity({
        beforeObservationId,
        afterObservationId: afterIdentity.episodeObservationId,
        type,
        action,
        data,
        result: {
          state: afterIdentity.observation.state,
          levelsCompleted: afterIdentity.observation.levelsCompleted,
          totalLevels: afterIdentity.observation.totalLevels,
          fullReset: afterIdentity.observation.fullReset,
          rejected: type === 'command-rejected',
        },
      })
      : null;
    const core = {
      gameId: this.gameId,
      sequence: this.evidenceSequence,
      type,
      action,
      data: data && typeof data === 'object' ? structuredClone(data) : {},
      reasoning: String(reasoning || '').slice(0, 1000),
      identitySchema: EPISODE_OBSERVATION_SCHEMA,
      transitionSchema: transitionId ? TRANSITION_SCHEMA : null,
      attemptId: this.attemptId,
      gridContentHash: afterIdentity.gridContentHash,
      observationContentHash: afterIdentity.observationContentHash,
      episodeObservationId: afterIdentity.episodeObservationId,
      beforeObservationId,
      transitionId,
      beforeObservation: beforeIdentity?.observation ?? null,
      observation: afterIdentity.observation,
      beforeHash: beforeFrame ? frameHash(beforeFrame) : null,
      afterHash: frameHash(frame),
      frameHash: frameHash(frame),
      levelsCompleted: Number(frame?.levelsCompleted || 0),
      totalLevels: frame?.totalLevels ?? null,
      levelDelta: Number(levelDelta || 0),
      state: String(frame?.state || 'UNKNOWN'),
      availableActions: Array.isArray(frame?.availableActions) ? frame.availableActions.slice() : [],
      actionIndex: this.actions,
      fullReset: Boolean(frame?.fullReset),
      episodeId: this.episodeId(),
      createdAt: new Date().toISOString(),
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
    const event = Object.freeze({
      ...core,
      id: `evidence-${String(this.evidenceSequence).padStart(6, '0')}-${digest.slice(0, 12)}`,
      digest,
    });
    this.evidenceLedger.push(event);
    this.currentObservationId = afterIdentity.episodeObservationId;
    if (!this.currentObservationRef || event.beforeObservationId !== event.episodeObservationId) {
      this.currentObservationRef = event.id;
    }
    return event;
  }

  readTrajectory({
    ref,
    startSequence,
    limit = 8,
    part,
    compareRef,
    x,
    y,
    width,
    height,
  } = {}) {
    const hasRef = typeof ref === 'string' && ref.length > 0;
    const hasSequence = !hasRef && startSequence !== undefined && startSequence !== null;
    const effectiveStartSequence = hasSequence ? startSequence : 1;
    const view = part ?? (hasRef ? 'event' : 'summary');
    if (!['summary', 'event', 'before', 'after', 'region', 'diff'].includes(view)) {
      throw new Error('trajectory_read part is invalid');
    }
    if (!hasRef && (view === 'region' || view === 'diff')) {
      throw new Error(`trajectory_read part=${view} requires ref`);
    }

    let value;
    let contextExactEvidence = false;
    if (hasRef) {
      const event = this.evidenceLedger.find((entry) => entry.id === ref);
      if (!event) throw new Error(`trajectory evidence not found: ${ref}`);
      if (view === 'region') {
        value = trajectoryRegion(event, { x, y, width, height });
      } else if (view === 'diff') {
        const compared = this.evidenceLedger.find((entry) => entry.id === compareRef);
        if (!compared) throw new Error(`trajectory comparison evidence not found: ${String(compareRef || '')}`);
        value = trajectoryDiff(compared, event);
      } else {
        value = trajectoryView(event, view);
        contextExactEvidence = view === 'event'
          || (view === 'before' && Array.isArray(event.beforeObservation?.frame))
          || (view === 'after' && Array.isArray(event.observation?.frame));
      }
    } else {
      if (!Number.isSafeInteger(effectiveStartSequence) || effectiveStartSequence < 1) {
        throw new Error('trajectory_read startSequence must be a positive safe integer');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('trajectory_read limit must be an integer from 1 through 20');
      }
      const events = this.evidenceLedger
        .filter((entry) => entry.sequence >= effectiveStartSequence)
        .slice(0, limit);
      value = {
        trajectory: this.trajectoryEvidence(),
        startSequence: effectiveStartSequence,
        events: events.map((event) => trajectoryView(event, view)),
        nextSequence: events.length === limit ? events.at(-1).sequence + 1 : null,
      };
    }
    const text = JSON.stringify(value);
    const maxChars = this.config.toolResultMaxChars ?? 24_000;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new Error('tool result character limit must be a positive safe integer');
    }
    if (text.length > maxChars) {
      throw new Error(`trajectory_read result exceeds ${maxChars} characters; request one ref with part=before or part=after`);
    }
    return this.toolResult(text, {
      evidenceRef: hasRef ? ref : null,
      contextExactEvidence,
      startSequence: hasRef ? null : effectiveStartSequence,
      part: view,
      characters: text.length,
    });
  }

  trajectoryEvidence() {
    const refs = this.evidenceLedger.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      digest: event.digest,
    }));
    return Object.freeze({
      schema: TRAJECTORY_EVIDENCE_SCHEMA,
      identitySchema: EPISODE_OBSERVATION_SCHEMA,
      complete: this.evidenceLedger.length === this.evidenceSequence,
      eventCount: this.evidenceLedger.length,
      highWaterSequence: this.evidenceSequence,
      firstEvidenceRef: this.evidenceLedger[0]?.id ?? null,
      lastEvidenceRef: this.evidenceLedger.at(-1)?.id ?? null,
      rootSha256: crypto.createHash('sha256').update(JSON.stringify({
        schema: TRAJECTORY_EVIDENCE_SCHEMA,
        refs,
      })).digest('hex'),
    });
  }

  describe(
    previousFrame = this.previousFrame,
    evidenceRef = this.currentObservationRef,
    options = {},
  ) {
    return describeFrame(this.frame, previousFrame, evidenceRef, options);
  }

  withRelevantMemory(result, query = '', jsonType = null) {
    if (!this.strategyEnabled) {
      return jsonType
        ? { ...result, text: JSON.stringify({ type: jsonType, ...result.details }) }
        : result;
    }
    const candidates = this.memory.relevantClaims({
      query: String(query || ''),
      state: this.frame?.state ?? null,
      levelsCompleted: this.frame?.levelsCompleted ?? 0,
      availableActions: this.frame?.availableActions ?? [],
    }, this.config.memorySurfaceLimit ?? 4);
    const maxChars = this.config.toolResultMaxChars ?? 24_000;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new Error('tool result character limit must be a positive safe integer');
    }
    const render = (
      relevantMemory,
      surfaced = this.memoryClaimsSurfaced + relevantMemory.length,
    ) => {
      const details = {
        ...result.details,
        relevantMemory,
        ...(result.details?.telemetry ? {
          telemetry: { ...this.commandTelemetry(), memoryClaimsSurfaced: surfaced },
        } : {}),
      };
      const text = jsonType
        ? JSON.stringify({ type: jsonType, ...details })
        : relevantMemory.length
          ? `${result.text}\nRELEVANT_MEMORY ${JSON.stringify(relevantMemory)}`
          : result.text;
      return { ...result, text, details };
    };
    let relevantMemory = [];
    for (const candidate of candidates) {
      const next = [...relevantMemory, candidate];
      if (render(next).text.length > maxChars) break;
      relevantMemory = next;
    }
    this.memoryClaimsSurfaced += relevantMemory.length;
    return render(relevantMemory, this.memoryClaimsSurfaced);
  }

  toolResult(text, details = {}, terminate = false) {
    return { text, details, terminate };
  }

  exposedTools() {
    const tools = filterToolsForPolicy(this.tools(), this.workspace.mode, this.policyProfile);
    if (canonicalJson(policyToolContract(tools)) !== canonicalJson(
      effectiveAvoToolContract(this.workspace.mode, this.policyProfile),
    )) {
      throw new Error('runtime tool contract differs from the sealed production policy profile');
    }
    return tools;
  }

  systemPrompt() {
    return policySystemPrompt(this?.policyProfile);
  }

  async run() {
    if (!this.frame) await this.initialize();
    const initialEvidence = this.currentObservationRef;
    const initialMemory = this.strategyEnabled ? this.memory.relevantClaims({
      query: 'initial objective legal actions',
      state: this.frame.state,
      levelsCompleted: this.frame.levelsCompleted,
      availableActions: this.frame.availableActions,
    }, this.config.memorySurfaceLimit ?? 4) : [];
    this.memoryClaimsSurfaced += initialMemory.length;
    const initialPrompt = policyInitialPrompt({
      policyProfile: this.policyProfile,
      gameId: this.gameId,
      initialEvidence,
      frameDescription: this.describe(null, initialEvidence),
      relevantMemory: initialMemory,
    });
    const tools = this.exposedTools();
    this.lastResult = await this.loop.run({
      systemPrompt: this.systemPrompt(),
      tools,
      productionToolContract: effectiveAvoToolContract(
        this.workspace.mode,
        this.policyProfile,
      ),
      workspaceMode: this.workspace.mode,
      policyProfile: this.policyProfile,
      initialPrompt,
      shouldStop: () => this.isDone(),
      runtimeStatus: () => this.runtimeStatus(),
    });
    const forwardingLifecycle = await this.forwardingLifecycleTelemetry();
    const mechanismMetrics = this.lastResult?.mechanismMetrics
      ? {
          ...this.lastResult.mechanismMetrics,
          supervisorInterventions: this.strategyEnabled ? this.supervisor.interventionSequence : 0,
          actionBudgetExhaustions: this.actionBudgetExhausted()
            && !this.finished
            && !isWin(this.frame) ? 1 : 0,
        }
      : null;
    return {
      gameId: this.gameId,
      policyProfile: this.policyProfile,
      state: this.frame.state,
      levelsCompleted: this.frame.levelsCompleted,
      totalLevels: this.frame.totalLevels,
      actions: this.actions,
      gameplayActions: this.gameplayActions,
      resets: this.resets,
      rejectedCommands: this.rejectedCommands,
      terminalRejectedCommands: this.terminalRejectedCommands,
      postTerminalGameplayActions: forwardingLifecycle.postTerminalGameplayActions,
      fullResets: this.fullResets,
      actionSequences: this.actionSequences,
      sequenceActionsRequested: this.sequenceActionsRequested,
      sequenceActionsExecuted: this.sequenceActionsExecuted,
      sequenceActionsSkipped: this.sequenceActionsSkipped,
      sequenceCancellations: this.sequenceCancellations,
      memoryClaimsProposed: this.memoryClaimsProposed,
      memoryClaimsConfirmed: this.memoryClaimsConfirmed,
      memoryClaimsCorrected: this.memoryClaimsCorrected,
      memoryClaimsSurfaced: this.memoryClaimsSurfaced,
      episodeId: this.episodeId(),
      trajectoryEvidence: this.trajectoryEvidence(),
      objective: this.objectiveState(),
      won: isWin(this.frame),
      loop: this.loop.kind,
      error: this.executionError ?? this.lastResult?.error ?? null,
      terminationReason: !this.executionError && !this.lastResult?.error && this.levelBudgetExhausted()
        ? 'level-action-budget' : this.lastResult?.terminationReason ?? null,
      outerTurns: this.lastResult?.outerTurns ?? null,
      mechanismMetrics,
      hypothesisJournal: {
        proposals: this.memory.journal.proposals.length,
        pending: this.memory.journal.pendingProposals().length,
        evaluations: this.memory.journal.evaluations.length,
        confirmed: this.memory.journal.byOutcome('confirmed').length,
        contradicted: this.memory.journal.byOutcome('contradicted').length,
      },
      scorecard: this.captureScorecard && typeof this.environment.scorecard === 'function'
        ? await this.environment.scorecard().catch(() => null)
        : null,
    };
  }
}

const SEALED_AVO_TOOLS = deepFreeze(AvoArcAgent.prototype.tools.call({}));

function normalizeActionSequence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTION_SEQUENCE) {
    throw new Error(`act_sequence steps must contain 1 through ${MAX_ACTION_SEQUENCE} items`);
  }
  const allowed = new Set(['action', 'x', 'y', 'reasoning', 'expected']);
  return value.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)
        || Object.keys(step).some((key) => !allowed.has(key))) {
      throw new Error(`act_sequence step ${index} is malformed`);
    }
    if (typeof step.action !== 'string' || step.action.length < 1 || step.action.length > 32) {
      throw new Error(`act_sequence step ${index} action must be a bounded string`);
    }
    for (const coordinate of ['x', 'y']) {
      if (step[coordinate] !== undefined && !Number.isSafeInteger(step[coordinate])) {
        throw new Error(`act_sequence step ${index} ${coordinate} must be an integer`);
      }
    }
    if (step.reasoning !== undefined
        && (typeof step.reasoning !== 'string' || step.reasoning.length > 1000)) {
      throw new Error(`act_sequence step ${index} reasoning exceeds its bound`);
    }
    return {
      action: step.action,
      x: step.x,
      y: step.y,
      reasoning: step.reasoning || '',
      expected: normalizeActionExpectation(step.expected, index),
    };
  });
}

function normalizeActionExpectation(value, index) {
  if (value === undefined) return {};
  const allowed = new Set(['changed', 'levelDeltaAtLeast', 'state', 'afterHash']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`act_sequence step ${index} expected postcondition is malformed`);
  }
  if (value.changed !== undefined && typeof value.changed !== 'boolean') {
    throw new Error(`act_sequence step ${index} expected.changed must be boolean`);
  }
  if (value.levelDeltaAtLeast !== undefined
      && (!Number.isSafeInteger(value.levelDeltaAtLeast)
        || value.levelDeltaAtLeast < 0 || value.levelDeltaAtLeast > 10_000)) {
    throw new Error(`act_sequence step ${index} expected.levelDeltaAtLeast is invalid`);
  }
  if (value.state !== undefined
      && (typeof value.state !== 'string' || value.state.length < 1 || value.state.length > 64
        || /[\r\n\0]/.test(value.state))) {
    throw new Error(`act_sequence step ${index} expected.state is invalid`);
  }
  if (value.afterHash !== undefined
      && (typeof value.afterHash !== 'string' || !/^[a-f0-9]{16}$/.test(value.afterHash))) {
    throw new Error(`act_sequence step ${index} expected.afterHash is invalid`);
  }
  return structuredClone(value);
}

function expectationMismatches(expected, before, after) {
  const actual = {
    changed: frameHash(before) !== frameHash(after),
    levelDeltaAtLeast: after.levelsCompleted - before.levelsCompleted,
    state: after.state,
    afterHash: frameHash(after),
  };
  const mismatches = [];
  if (Object.hasOwn(expected, 'changed') && expected.changed !== actual.changed) {
    mismatches.push({ field: 'changed', expected: expected.changed, actual: actual.changed });
  }
  if (Object.hasOwn(expected, 'levelDeltaAtLeast')
      && actual.levelDeltaAtLeast < expected.levelDeltaAtLeast) {
    mismatches.push({
      field: 'levelDeltaAtLeast',
      expected: expected.levelDeltaAtLeast,
      actual: actual.levelDeltaAtLeast,
    });
  }
  for (const field of ['state', 'afterHash']) {
    if (Object.hasOwn(expected, field) && expected[field] !== actual[field]) {
      mismatches.push({ field, expected: expected[field], actual: actual[field] });
    }
  }
  return mismatches;
}

function sequenceExecutedEntry(index, step, before, after, evidenceRef, currentLevelDelta = 0) {
  return {
    index,
    action: step.action,
    data: actionData(step),
    evidenceRef,
    state: after.state,
    levelsCompleted: after.levelsCompleted,
    levelDelta: after.levelsCompleted - before.levelsCompleted,
    currentLevelDelta,
    afterHash: frameHash(after),
    expectationMismatches: expectationMismatches(step.expected, before, after),
  };
}

function actionData(step) {
  return step.action === 'ACTION6' ? { x: step.x ?? null, y: step.y ?? null } : {};
}

function isSurrogateBoundary(text, offset) {
  return offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1])
    && /[\uDC00-\uDFFF]/.test(text[offset]);
}

function appendSkipped(output, requested, start, reason, evidenceRef = null) {
  for (let index = start; index < requested.length; index += 1) {
    output.push({
      index,
      action: requested[index].action,
      data: actionData(requested[index]),
      reason,
      evidenceRef: index === start ? evidenceRef ?? null : null,
    });
  }
}

function trajectoryView(event, part) {
  if (part === 'event') return event;
  if (part === 'before') {
    return {
      evidenceRef: event.id,
      observationId: event.beforeObservationId,
      observation: event.beforeObservation,
    };
  }
  if (part === 'after') {
    return {
      evidenceRef: event.id,
      observationId: event.episodeObservationId,
      observation: event.observation,
    };
  }
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    action: event.action,
    data: event.data,
    beforeObservationId: event.beforeObservationId,
    episodeObservationId: event.episodeObservationId,
    transitionId: event.transitionId,
    transitionSchema: event.transitionSchema,
    gridContentHash: event.gridContentHash,
    observationContentHash: event.observationContentHash,
    attemptId: event.attemptId,
    episodeId: event.episodeId,
    state: event.state,
    levelsCompleted: event.levelsCompleted,
    totalLevels: event.totalLevels,
    levelDelta: event.levelDelta,
    fullReset: event.fullReset,
    createdAt: event.createdAt,
  };
}

function trajectoryRegion(event, { x, y, width, height }) {
  const grid = exactEventGrid(event);
  const gridHeight = grid.length;
  const gridWidth = grid[0].length;
  const left = regionInteger(x, 'x', 0, 63);
  const top = regionInteger(y, 'y', 0, 63);
  const regionWidth = regionInteger(width, 'width', 1, 64);
  const regionHeight = regionInteger(height, 'height', 1, 64);
  if (left + regionWidth > gridWidth || top + regionHeight > gridHeight) {
    throw new Error(`trajectory_read region exceeds grid shape ${gridWidth}x${gridHeight}`);
  }
  return {
    evidenceRef: event.id,
    observationId: event.episodeObservationId,
    gridContentHash: event.gridContentHash,
    x: left,
    y: top,
    width: regionWidth,
    height: regionHeight,
    grid: grid.slice(top, top + regionHeight)
      .map((row) => row.slice(left, left + regionWidth)),
  };
}

function trajectoryDiff(fromEvent, toEvent) {
  const from = exactEventGrid(fromEvent);
  const to = exactEventGrid(toEvent);
  const changed = gridDelta(from, to).changed;
  return {
    fromEvidenceRef: fromEvent.id,
    toEvidenceRef: toEvent.id,
    fromObservationId: fromEvent.episodeObservationId,
    toObservationId: toEvent.episodeObservationId,
    fromShape: [from.length, from[0].length],
    toShape: [to.length, to[0].length],
    view: changed === null ? 'shape_changed' : changed.length === 0 ? 'no_change' : 'delta',
    changedCellCount: changed?.length ?? null,
    changedCellFormat: ['x', 'y', 'before', 'after'],
    changedCells: changed?.slice(0, MAX_TRAJECTORY_DIFF_CELLS) ?? [],
    changedCellsTruncated: changed !== null && changed.length > MAX_TRAJECTORY_DIFF_CELLS,
    changedBounds: trajectoryChangedBounds(changed),
  };
}

function exactEventGrid(event) {
  const grid = event?.observation?.frame;
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0
      || grid.some((row) => !Array.isArray(row) || row.length !== grid[0].length)) {
    throw new Error(`trajectory evidence ${String(event?.id || '')} has no rectangular exact grid`);
  }
  return grid;
}

function regionInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`trajectory_read ${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function trajectoryChangedBounds(changed) {
  if (!changed?.length) return null;
  const xs = changed.map(([x]) => x);
  const ys = changed.map(([, y]) => y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs) + 1,
    height: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

export function episodeState(frame) {
  const state = String(frame?.state || '').trim().toUpperCase();
  if (state === 'WIN' || state === 'GAME_OVER' || state === 'ERROR') return state;
  return 'ACTIVE';
}

function isWin(frame) {
  return episodeState(frame) === 'WIN';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
