import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateGoal } from '../goalProgress.js';

test('goal thresholds use strict greater-than at every boundary through ten million', () => {
  assert.equal(calculateGoal(0), 100_000);
  assert.equal(calculateGoal(50_000), 100_000);
  assert.equal(calculateGoal(99_999), 100_000);
  assert.equal(calculateGoal(100_000), 100_000);
  assert.equal(calculateGoal(100_001), 1_000_000);
  for (let million = 1; million <= 10; million += 1) {
    const boundary = million * 1_000_000;
    assert.equal(calculateGoal(boundary - 1), boundary);
    assert.equal(calculateGoal(boundary), boundary);
    assert.equal(
      calculateGoal(boundary + 1),
      Math.min(boundary + 1_000_000, 10_000_000),
    );
  }
  assert.equal(calculateGoal(Number.MAX_SAFE_INTEGER), 10_000_000);
});

test('goal calculation rejects invalid or inexact totals', () => {
  for (const value of [
    -1,
    1.5,
    NaN,
    Infinity,
    '50000',
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => calculateGoal(value), /Invalid total amount/);
  }
});
