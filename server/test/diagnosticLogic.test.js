import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeMatchingAnswer,
  gradeOrderingAnswer,
  gradeNumberAnswer,
  gradeRegionAnswer,
  gradeTextAnswer,
  rectOverlapPercentOfSelected,
} from '../diagnosticLogic.js';

test('gradeTextAnswer accepts normalized spelling and whitespace', () => {
  const question = {
    answer: {
      correctText: 'демаркационная зона',
      acceptedTexts: ['Демаркационная  зона'],
    },
  };

  assert.equal(gradeTextAnswer(question, 'демаркационная зона'), true);
  assert.equal(gradeTextAnswer(question, 'демаркационная линия'), false);
});

test('gradeNumberAnswer supports tolerance around exact value', () => {
  const question = {
    answer: {
      numeric: {
        correctValue: 10,
        tolerance: 0.5,
        min: NaN,
        max: NaN,
      },
    },
  };

  assert.equal(gradeNumberAnswer(question, 10.4), true);
  assert.equal(gradeNumberAnswer(question, 10.7), false);
});

test('rectOverlapPercentOfSelected measures selected area overlap', () => {
  const target = { type: 'rect', x: 10, y: 10, width: 20, height: 20 };
  const selected = { x: 20, y: 20, width: 20, height: 20 };

  assert.equal(rectOverlapPercentOfSelected(target, selected), 25);
});

test('gradeRegionAnswer supports intersection and center modes', () => {
  const baseQuestion = {
    regions: [{ type: 'rect', x: 10, y: 10, width: 20, height: 20 }],
    grading: {
      regionMode: 'intersection',
      regionThreshold: 25,
    },
  };
  const selected = { x: 20, y: 20, width: 20, height: 20 };
  const selectedOutsideCenter = { x: 21, y: 21, width: 20, height: 20 };

  assert.equal(gradeRegionAnswer(baseQuestion, selected), true);
  assert.equal(
    gradeRegionAnswer(
      {
        ...baseQuestion,
        grading: {
          regionMode: 'center',
          regionThreshold: 25,
        },
      },
      selectedOutsideCenter
    ),
    false
  );
});

test('gradeRegionAnswer rejects empty selections and ignores arrows', () => {
  const question = {
    regions: [
      { type: 'arrow', x1: 10, y1: 10, x2: 40, y2: 40 },
    ],
    grading: {
      regionMode: 'intersection',
      regionThreshold: 20,
    },
  };

  assert.equal(gradeRegionAnswer(question, null), false);
  assert.equal(gradeRegionAnswer(question, { x: 10, y: 10, width: 10, height: 10 }), false);
});

test('gradeRegionAnswer accepts any matching correct region', () => {
  const question = {
    regions: [
      { type: 'rect', x: 5, y: 5, width: 10, height: 10 },
      { type: 'rect', x: 60, y: 60, width: 20, height: 20 },
    ],
    grading: {
      regionMode: 'intersection',
      regionThreshold: 50,
    },
  };

  assert.equal(gradeRegionAnswer(question, { x: 62, y: 62, width: 8, height: 8 }), true);
  assert.equal(gradeRegionAnswer(question, { x: 35, y: 35, width: 8, height: 8 }), false);
});

test('gradeMatchingAnswer and gradeOrderingAnswer validate structured answers', () => {
  const matchingQuestion = {
    answer: {
      pairs: [
        { id: 'left-1' },
        { id: 'left-2' },
      ],
    },
  };
  const orderingQuestion = {
    answer: {
      items: [
        { id: 'step-1' },
        { id: 'step-2' },
        { id: 'step-3' },
      ],
    },
  };

  assert.equal(gradeMatchingAnswer(matchingQuestion, { 'left-1': 'left-1', 'left-2': 'left-2' }), true);
  assert.equal(gradeMatchingAnswer(matchingQuestion, { 'left-1': 'left-2', 'left-2': 'left-2' }), false);
  assert.equal(gradeOrderingAnswer(orderingQuestion, ['step-1', 'step-2', 'step-3']), true);
  assert.equal(gradeOrderingAnswer(orderingQuestion, ['step-2', 'step-1', 'step-3']), false);
});
