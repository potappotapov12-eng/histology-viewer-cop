export const ALL_ORGANS_OPTION = 'Все';
export const ALL_LESSONS_OPTION = 'Все занятия';
export const ALL_SYSTEMS_OPTION = 'Все разделы';
export const ALL_STAINS_OPTION = 'Все окраски';
export const NO_LESSON_OPTION = 'Без занятия';
export const DEFAULT_SYSTEM = 'Без раздела';

export function toSearchText(value) {
  return String(value || '').toLowerCase();
}

export function getSlideTitle(slide) {
  return slide?.title || 'Без названия';
}

export function getSlideOrgan(slide) {
  return slide?.organ || 'Орган не указан';
}

export function getSlideStain(slide) {
  return slide?.stain || 'Окраска не указана';
}

export function getSlideSystem(slide) {
  return slide?.system || DEFAULT_SYSTEM;
}

export function getSlideLesson(slide) {
  return slide?.lesson || NO_LESSON_OPTION;
}

export function normalizeDiagnosticSign(sign) {
  if (typeof sign === 'string') {
    return {
      text: sign,
      marker: null,
    };
  }

  return {
    text: sign?.text || '',
    marker: sign?.marker || null,
  };
}

export function createTileSource(source) {
  if (!source) return null;

  return source.endsWith('.dzi')
    ? source
    : {
        type: 'image',
        url: source,
      };
}

export function formatTimer(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  return `${minutes}:${String(restSeconds).padStart(2, '0')}`;
}

export function getDiagnosticDraftKey(diagnosticId, student) {
  const name = String(student?.studentName || '').trim().toLowerCase();
  const group = String(student?.group || '').trim().toLowerCase();

  if (!diagnosticId || !name || !group) return '';

  return `diagnostic-draft:${diagnosticId}:${name}:${group}`;
}

export function getQuestionAnswerStatus(question, answer) {
  if (!answer) return false;
  if (question.type === 'text') return Boolean(answer.textAnswer?.trim());
  if (question.type === 'number') return answer.numberAnswer !== undefined && answer.numberAnswer !== '';
  if (question.type === 'matching') return answer.selectedPairs && Object.keys(answer.selectedPairs).length > 0;
  if (question.type === 'ordering') return Array.isArray(answer.orderedItemIds) && answer.orderedItemIds.length > 0;
  if (question.type === 'region') return Boolean(answer.selectedRegion);
  if (question.type === 'combined') return Boolean(answer.selectedOptionId && answer.textAnswer?.trim());
  if (question.type === 'multiple') return Array.isArray(answer.selectedOptions) && answer.selectedOptions.length > 0;
  return Boolean(answer.selectedOption);
}

export function getResultAnswerStatus(answer) {
  if (answer?.needsReview) return 'Требует проверки';
  return answer?.isCorrect ? 'Верно' : 'Не верно';
}

function createHighlightElement() {
  const element = document.createElement('div');
  element.className = 'diagnosticHighlightOverlay';
  return element;
}

function createSelectedRegionElement() {
  const element = document.createElement('div');
  element.className = 'selectedRegionOverlay';
  return element;
}

function createArrowElement(marker) {
  const element = document.createElement('div');
  element.className = 'arrowMarkerOverlay';

  const bounds = getMarkerBounds(marker);
  const minX = bounds.x;
  const minY = bounds.y;
  const width = bounds.width;
  const height = bounds.height;
  const padding = 12;
  const usableSize = 100 - padding * 2;
  const x1 = padding + ((Number(marker.x1) - minX) / width) * usableSize;
  const y1 = padding + ((Number(marker.y1) - minY) / height) * usableSize;
  const x2 = padding + ((Number(marker.x2) - minX) / width) * usableSize;
  const y2 = padding + ((Number(marker.y2) - minY) / height) * usableSize;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLength = 13;
  const headAngle = Math.PI / 7;
  const headLeftX = x2 - headLength * Math.cos(angle - headAngle);
  const headLeftY = y2 - headLength * Math.sin(angle - headAngle);
  const headRightX = x2 - headLength * Math.cos(angle + headAngle);
  const headRightY = y2 - headLength * Math.sin(angle + headAngle);

  element.innerHTML = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line class="arrowMarkerLine" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
      <line class="arrowMarkerHead" x1="${x2}" y1="${y2}" x2="${headLeftX}" y2="${headLeftY}"></line>
      <line class="arrowMarkerHead" x1="${x2}" y1="${y2}" x2="${headRightX}" y2="${headRightY}"></line>
    </svg>
  `;

  return element;
}

function getMarkerBounds(marker) {
  if (!marker) return null;

  if (marker.type === 'arrow') {
    const rawX = Math.min(Number(marker.x1), Number(marker.x2));
    const rawY = Math.min(Number(marker.y1), Number(marker.y2));
    const rawWidth = Math.max(1, Math.abs(Number(marker.x2) - Number(marker.x1)));
    const rawHeight = Math.max(1, Math.abs(Number(marker.y2) - Number(marker.y1)));
    const padding = 2;
    const x = Math.max(0, rawX - padding);
    const y = Math.max(0, rawY - padding);
    const width = Math.min(100 - x, rawWidth + padding * 2);
    const height = Math.min(100 - y, rawHeight + padding * 2);

    return { x, y, width, height };
  }

  return {
    x: Number(marker.x),
    y: Number(marker.y),
    width: Number(marker.width),
    height: Number(marker.height),
  };
}

export function getMarkerViewportRect(viewer, marker) {
  if (!viewer || !marker) return null;

  const tiledImage = viewer.world.getItemAt(0);
  const size = tiledImage?.source?.dimensions;

  if (!size?.x || !size?.y) return null;
  const bounds = getMarkerBounds(marker);
  if (!bounds) return null;

  return tiledImage.imageToViewportRectangle(
    (bounds.x / 100) * size.x,
    (bounds.y / 100) * size.y,
    (bounds.width / 100) * size.x,
    (bounds.height / 100) * size.y
  );
}

export function addMarkerOverlay(viewer, marker) {
  const rect = getMarkerViewportRect(viewer, marker);
  if (!viewer || !marker || !rect) return null;

  const element = marker.type === 'arrow'
    ? createArrowElement(marker)
    : createHighlightElement();

  viewer.addOverlay({
    element,
    location: rect,
  });

  return element;
}

export function addHighlightOverlay(viewer, highlight) {
  return addMarkerOverlay(
    viewer,
    highlight?.type === 'arrow'
      ? highlight
      : {
          type: 'rect',
          ...highlight,
        }
  );
}

export function addSelectedRegionOverlay(viewer, region) {
  const rect = getMarkerViewportRect(viewer, {
    type: 'rect',
    ...region,
  });
  if (!viewer || !region || !rect) return null;

  const element = createSelectedRegionElement();

  viewer.addOverlay({
    element,
    location: rect,
  });

  return element;
}

export function getViewerImagePercentPoint(viewer, OpenSeadragon, event) {
  const tiledImage = viewer?.world?.getItemAt(0);
  const size = tiledImage?.source?.dimensions;
  const element = viewer?.element;

  if (!viewer || !OpenSeadragon || !tiledImage || !size?.x || !size?.y || !element) {
    return null;
  }

  const bounds = element.getBoundingClientRect();
  const pixel = new OpenSeadragon.Point(
    event.clientX - bounds.left,
    event.clientY - bounds.top
  );
  const viewportPoint = viewer.viewport.pointFromPixel(pixel, true);
  const imagePoint = tiledImage.viewportToImageCoordinates(viewportPoint);

  return {
    x: Math.max(0, Math.min(100, (imagePoint.x / size.x) * 100)),
    y: Math.max(0, Math.min(100, (imagePoint.y / size.y) * 100)),
  };
}

export function buildRegionFromPoints(startPoint, endPoint) {
  const x = Math.min(startPoint.x, endPoint.x);
  const y = Math.min(startPoint.y, endPoint.y);
  const width = Math.max(1, Math.abs(endPoint.x - startPoint.x));
  const height = Math.max(1, Math.abs(endPoint.y - startPoint.y));

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    width: Number(Math.min(width, 100 - x).toFixed(2)),
    height: Number(Math.min(height, 100 - y).toFixed(2)),
  };
}

export function isPointInsideRegion(point, region) {
  if (!point || !region) return false;

  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);

  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    point.x >= x &&
    point.x <= x + width &&
    point.y >= y &&
    point.y <= y + height
  );
}

export function moveRegionByDelta(region, deltaX, deltaY) {
  if (!region) return null;

  const width = Math.max(1, Math.min(100, Number(region.width) || 1));
  const height = Math.max(1, Math.min(100, Number(region.height) || 1));
  const x = Math.max(0, Math.min(100 - width, (Number(region.x) || 0) + deltaX));
  const y = Math.max(0, Math.min(100 - height, (Number(region.y) || 0) + deltaY));

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    width: Number(width.toFixed(2)),
    height: Number(height.toFixed(2)),
  };
}
