import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
