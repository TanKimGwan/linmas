import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveEvaluationRunner } from '../src/evaluation/live-runner.mjs';

function registryWithCalls(calls) {
  return new Map(['codex', 'claude'].map((id) => [id, {
    id,
    create(options) {
      calls.push({ id, options });
      return { id, model: options.model, async run() {} };
    }
  }]));
}

test('live evaluation defaults to Codex with an explicit model', () => {
  const calls = [];
  const runner = createLiveEvaluationRunner({
    env: { LINMAS_EVAL_MODEL: 'account-visible-default' },
    registry: registryWithCalls(calls)
  });
  assert.equal(runner.id, 'codex');
  assert.equal(runner.model, 'account-visible-default');
  assert.deepEqual(calls, [{ id: 'codex', options: { model: 'account-visible-default' } }]);
});

test('live evaluation keeps Claude available only through explicit provider selection', () => {
  const calls = [];
  const runner = createLiveEvaluationRunner({
    env: { LINMAS_EVAL_PROVIDER: 'claude', LINMAS_EVAL_MODEL: 'claude-model' },
    registry: registryWithCalls(calls)
  });
  assert.equal(runner.id, 'claude');
  assert.deepEqual(calls, [{ id: 'claude', options: { model: 'claude-model' } }]);
});

test('live evaluation fails closed without a model or for an unsupported provider', () => {
  assert.throws(
    () => createLiveEvaluationRunner({ env: {}, registry: new Map() }),
    /LINMAS_EVAL_MODEL is required/
  );
  assert.throws(
    () => createLiveEvaluationRunner({
      env: { LINMAS_EVAL_PROVIDER: 'unknown', LINMAS_EVAL_MODEL: 'm' },
      registry: new Map()
    }),
    /unsupported provider: unknown/
  );
});
