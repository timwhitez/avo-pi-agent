import { PersistentMemory } from './memory.mjs';
import { StallSupervisor } from './supervisor.mjs';
import { describeFrame, frameHash, normalizeFrame } from './observation.mjs';

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };

export class AvoArcAgent {
  constructor({ gameId, environment, loop, config, logger = console, captureScorecard = true }) {
    this.gameId = gameId;
    this.environment = environment;
    this.loop = loop;
    this.config = config;
    this.logger = logger;
    this.captureScorecard = captureScorecard;
    this.memory = new PersistentMemory(config.memoryDir, gameId).load();
    this.supervisor = new StallSupervisor(config.stallWindow);
    this.frame = null;
    this.previousFrame = null;
    this.actions = 0;
    this.uniqueStates = new Set();
    this.finished = false;
    this.lastResult = null;
  }

  async initialize() {
    const raw = typeof this.environment.start === 'function'
      ? await this.environment.start()
      : await this.environment.observe();
    this.frame = normalizeFrame(raw);
    this.uniqueStates.add(frameHash(this.frame));
  }

  isDone() {
    return this.finished || this.actions >= this.config.maxActions || isWin(this.frame);
  }

  score() {
    return this.frame.levelsCompleted * 1_000_000 + this.uniqueStates.size * 100 - this.actions;
  }

  tools() {
    return [
      {
        name: 'observe',
        label: 'Observe exact ARC frame',
        description: 'Read the exact current grid, game state, progress and available actions without spending an environment action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => this.toolResult(this.describe(), { frame: this.frame }),
      },
      {
        name: 'act',
        label: 'Take one ARC environment action',
        description: 'Execute exactly one legal ARC action. ACTION6 may take x/y coordinates. Environment actions are scarce; reason before using them.',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6'] },
            x: { type: 'integer', minimum: 0, maximum: 63 },
            y: { type: 'integer', minimum: 0, maximum: 63 },
            reasoning: { type: 'string' },
          },
          additionalProperties: false,
        },
        execute: async (params) => this.act(params),
      },
      {
        name: 'memory_read',
        label: 'Read persistent game memory',
        description: 'Read structured discoveries, failures, strategies and candidate lineage retained across turns and levels.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => this.toolResult(JSON.stringify(this.memory.snapshot(), null, 2), { memory: this.memory.snapshot() }),
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
        name: 'candidate_commit',
        label: 'Commit an evaluated candidate hypothesis',
        description: 'Persist one hypothesis in the AVO candidate lineage. Acceptance is evaluator-controlled and cannot be asserted by the model.',
        parameters: {
          type: 'object', required: ['hypothesis', 'evidence'],
          properties: {
            hypothesis: { type: 'string' },
            evidence: { type: 'string' },
          }, additionalProperties: false,
        },
        execute: async ({ hypothesis, evidence }) => this.commitCandidate(hypothesis, evidence),
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
    const raw = action === 'RESET' && typeof this.environment.reset === 'function'
      ? await this.environment.reset({ text: reasoning })
      : await this.environment.step(action, data, { text: reasoning });
    this.frame = normalizeFrame(raw);
    this.actions += 1;
    const hash = frameHash(this.frame);
    const wasNew = !this.uniqueStates.has(hash);
    this.uniqueStates.add(hash);
    this.supervisor.observe({ frameHash: hash, levelsCompleted: this.frame.levelsCompleted, action });
    const stall = this.supervisor.status();
    const progressed = this.frame.levelsCompleted > this.previousFrame.levelsCompleted || isWin(this.frame);
    if (progressed) {
      this.memory.merge({ provenStrategies: [`At action ${this.actions}, ${action} produced progress: levels=${this.frame.levelsCompleted}.`] });
      this.memory.commitCandidate({
        gameId: this.gameId,
        hypothesis: reasoning || `${action} advances the current strategy`,
        evidence: `Observed progress to level ${this.frame.levelsCompleted}; state=${this.frame.state}`,
        score: this.score(),
        accepted: true,
      });
    }
    if (stall.stalled) {
      this.memory.merge({ failedHypotheses: [`Supervisor detected ${stall.reason} after action ${this.actions}.`] });
    }
    const supervisorText = stall.stalled ? `\nSUPERVISOR_INTERVENTION:\n${stall.intervention.join('\n')}` : '';
    return this.toolResult(
      `${this.describe()}\nEVALUATOR: progressed=${progressed} novel_state=${wasNew} score=${this.score()} actions=${this.actions}/${this.config.maxActions}${supervisorText}`,
      { frame: this.frame, progressed, novelState: wasNew, score: this.score(), stall },
      isWin(this.frame),
    );
  }

  commitCandidate(hypothesis, evidence) {
    const best = this.memory.lineage.best();
    const score = this.score();
    const accepted = !best || score > best.score;
    const objectiveEvidence = [
      `frame_hash=${frameHash(this.frame)}`,
      `levels_completed=${this.frame.levelsCompleted}`,
      `actions=${this.actions}`,
      `model_evidence=${evidence}`,
    ].join('; ');
    const record = this.memory.commitCandidate({
      gameId: this.gameId,
      hypothesis,
      evidence: objectiveEvidence,
      score,
      accepted,
    });
    if (!accepted) this.memory.merge({ failedHypotheses: [`Rejected candidate ${record.id}: ${hypothesis}`] });
    return this.toolResult(
      accepted
        ? `Candidate ${record.id} accepted at score ${score}.`
        : `Candidate ${record.id} retained as rejected evidence; score ${score} did not improve best ${best.score}.`,
      { record, best: this.memory.lineage.best() },
    );
  }

  describe() {
    return describeFrame(this.frame, this.previousFrame);
  }

  toolResult(text, details = {}, terminate = false) {
    return { text, details, terminate };
  }

  systemPrompt() {
    return `You are an AVO-style autonomous ARC-AGI-3 player running inside the Pi agent loop.

Operating rules:
1. Interact directly with the exact text grid. Do not assume visual features that are not encoded in cells.
2. Inspect -> hypothesize -> take the smallest informative action -> evaluate -> revise.
3. Environment actions are the scarce resource. Internal reasoning and memory tools do not consume them.
4. Use memory_read at the start. Persist validated semantics, objects, goals, invariants, failed hypotheses and proven strategies with memory_update.
5. Use candidate_commit to maintain an evidence-backed lineage. The evaluator, not you, decides acceptance.
6. When the supervisor reports a stall, abandon the repeating tactic, record its failure, and branch to a materially different experiment.
7. Do not call finish until state=WIN or the action budget is exhausted.
8. Continue through every level of the current game; a level transition is progress, not completion.

You have only the ARC and structured-memory tools. No shell, browser, generic network, or arbitrary filesystem access is available.`;
  }

  async run() {
    if (!this.frame) await this.initialize();
    const initialPrompt = `Solve game ${this.gameId}. Begin by reading persistent memory, then inspect the current exact frame. Continue autonomously until WIN or action budget exhaustion.\n\n${this.describe()}`;
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
      scoreProxy: this.score(),
      won: isWin(this.frame),
      loop: this.loop.kind,
      error: this.lastResult?.error ?? null,
      scorecard: this.captureScorecard ? await this.environment.scorecard().catch(() => null) : null,
    };
  }
}

function isWin(frame) {
  return Boolean(frame && String(frame.state).toUpperCase().includes('WIN'));
}
