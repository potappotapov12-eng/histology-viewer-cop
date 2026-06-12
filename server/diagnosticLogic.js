export function normalizeOpenAnswer(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

export function getMarkerBounds(marker) {
  if (!marker) return null;

  if (marker.type === 'arrow') {
    return {
      x: Math.min(Number(marker.x1), Number(marker.x2)),
      y: Math.min(Number(marker.y1), Number(marker.y2)),
      width: Math.max(1, Math.abs(Number(marker.x2) - Number(marker.x1))),
      height: Math.max(1, Math.abs(Number(marker.y2) - Number(marker.y1))),
    };
  }

  return {
    x: Number(marker.x),
    y: Number(marker.y),
    width: Number(marker.width),
    height: Number(marker.height),
  };
}

export function rectOverlapPercentOfSelected(target, selected) {
  if (!target || !selected) return 0;
  const targetBounds = getMarkerBounds(target);
  if (!targetBounds) return 0;

  const left = Math.max(Number(targetBounds.x), Number(selected.x));
  const top = Math.max(Number(targetBounds.y), Number(selected.y));
  const right = Math.min(Number(targetBounds.x) + Number(targetBounds.width), Number(selected.x) + Number(selected.width));
  const bottom = Math.min(Number(targetBounds.y) + Number(targetBounds.height), Number(selected.y) + Number(selected.height));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const intersectionArea = width * height;
  const selectedArea = Math.max(1, Number(selected.width) * Number(selected.height));

  return (intersectionArea / selectedArea) * 100;
}

export function rectCenterInside(target, selected) {
  if (!target || !selected) return false;
  const targetBounds = getMarkerBounds(target);
  if (!targetBounds) return false;

  const centerX = Number(selected.x) + Number(selected.width) / 2;
  const centerY = Number(selected.y) + Number(selected.height) / 2;

  return (
    centerX >= Number(targetBounds.x) &&
    centerX <= Number(targetBounds.x) + Number(targetBounds.width) &&
    centerY >= Number(targetBounds.y) &&
    centerY <= Number(targetBounds.y) + Number(targetBounds.height)
  );
}

export function gradeTextAnswer(question, textAnswer) {
  const normalizedAnswer = normalizeOpenAnswer(textAnswer);
  const acceptedTexts = question.answer.acceptedTexts.length > 0
    ? question.answer.acceptedTexts
    : [question.answer.correctText];

  return acceptedTexts.some((item) => normalizeOpenAnswer(item) === normalizedAnswer);
}

export function gradeNumberAnswer(question, value) {
  const numericValue = Number(value);
  const { correctValue, tolerance, min, max } = question.answer.numeric;

  if (!Number.isFinite(numericValue)) return false;

  if (Number.isFinite(min) && Number.isFinite(max)) {
    return numericValue >= min && numericValue <= max;
  }

  if (!Number.isFinite(correctValue)) return false;

  return Math.abs(numericValue - correctValue) <= Math.max(0, Number(tolerance) || 0);
}

export function gradeMatchingAnswer(question, selectedPairs = {}) {
  return question.answer.pairs.every((pair) => selectedPairs[pair.id] === pair.id);
}

export function gradeOrderingAnswer(question, orderedItemIds = []) {
  return JSON.stringify(orderedItemIds) ===
    JSON.stringify(question.answer.items.map((item) => item.id));
}

export function gradeRegionAnswer(question, selectedRegion) {
  if (!selectedRegion) return false;
  const regions = (Array.isArray(question.regions)
    ? question.regions
    : [question.region]).filter((region) => region?.type !== 'arrow');
  if (regions.length === 0) return false;

  if (question.grading.regionMode === 'center') {
    return regions.some((region) => rectCenterInside(region, selectedRegion));
  }

  return regions.some((region) =>
    rectOverlapPercentOfSelected(region, selectedRegion) >= question.grading.regionThreshold
  );
}
