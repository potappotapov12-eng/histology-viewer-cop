import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REGION_THRESHOLD,
  DIAGNOSTIC_DATE_TIME_FORMATTER,
  DIAGNOSTIC_DRAFT_KEY,
  IMPORT_FIELD_ALIASES,
  INITIAL_DIAGNOSTIC_FORM,
  INITIAL_FORM,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSION_PRESETS,
  USER_ROLE_OPTIONS,
  createEmptyUserForm,
} from './adminConfig';

function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === ';' || character === ',')) {
      row.push(cell.trim());
      cell = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error('CSV должен содержать заголовок и хотя бы одну строку');

  const headers = rows[0].map((header) => IMPORT_FIELD_ALIASES[header.trim().toLowerCase()] || '');
  if (!headers.includes('title') || !headers.includes('source')) {
    throw new Error('CSV должен содержать столбцы title/Название и source/DZI-адрес');
  }

  return rows.slice(1).map((cells) => Object.fromEntries(
    headers.map((header, index) => [header, header ? cells[index] || '' : undefined]).filter(([header]) => header)
  ));
}

function normalizeImportedSlides(content, fileName) {
  if (fileName.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(content);
    const slides = Array.isArray(parsed) ? parsed : parsed?.slides;
    if (!Array.isArray(slides)) throw new Error('JSON должен быть массивом карточек или объектом с полем slides');
    return slides;
  }

  return parseCsvRows(content);
}

function createDiagnosticQuestion(slideId = '') {
  const highlight = {
    x: 35,
    y: 35,
    width: 20,
    height: 18,
  };

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'single',
    slideId,
    prompt: '',
    answer: {
      type: 'single',
      shuffle: true,
      options: ['Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4'].map((text, index) => ({
        id: `opt-${index}`,
        text,
        isCorrect: index === 0,
      })),
      correctText: '',
      numeric: {
        correctValue: '',
        tolerance: 0,
        min: '',
        max: '',
      },
      pairs: [
        { id: 'pair-0', left: 'Структура 1', right: 'Ответ 1' },
        { id: 'pair-1', left: 'Структура 2', right: 'Ответ 2' },
      ],
      items: [
        { id: 'item-0', text: 'Этап 1' },
        { id: 'item-1', text: 'Этап 2' },
      ],
    },
    grading: {
      mode: 'auto',
      points: 1,
      partialCredit: false,
      regionMode: 'intersection',
      regionThreshold: DEFAULT_REGION_THRESHOLD,
    },
    correctIndex: 0,
    correctIndices: [0],
    correctText: '',
    highlight,
    regions: [{ ...highlight }],
  };
}

function toYekaterinburgDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = Object.fromEntries(
    DIAGNOSTIC_DATE_TIME_FORMATTER
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function formatBackupDate(value) {
  if (!value) return 'Дата неизвестна';

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

function createTileSource(source) {
  if (!source) return null;

  return source.endsWith('.dzi')
    ? source
    : {
        type: 'image',
        url: source,
      };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function getImagePercentPoint(viewer, OpenSeadragon, event) {
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
    x: clampPercent((imagePoint.x / size.x) * 100),
    y: clampPercent((imagePoint.y / size.y) * 100),
  };
}

function buildHighlightFromPoints(startPoint, endPoint) {
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

function buildArrowFromPoints(startPoint, endPoint) {
  return {
    type: 'arrow',
    x1: Number(startPoint.x.toFixed(2)),
    y1: Number(startPoint.y.toFixed(2)),
    x2: Number(endPoint.x.toFixed(2)),
    y2: Number(endPoint.y.toFixed(2)),
  };
}

function isPointInsideMarker(point, marker) {
  const bounds = getPickerMarkerBounds(marker);
  if (!point || !bounds) return false;

  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function getRectResizeHandle(point, marker) {
  if (!point || !marker || marker.type === 'arrow') return '';
  const x = Number(marker.x);
  const y = Number(marker.y);
  const width = Number(marker.width);
  const height = Number(marker.height);
  const threshold = Math.max(1.5, Math.min(4, Math.min(width, height) * 0.25));
  const nearLeft = Math.abs(point.x - x) <= threshold;
  const nearRight = Math.abs(point.x - (x + width)) <= threshold;
  const nearTop = Math.abs(point.y - y) <= threshold;
  const nearBottom = Math.abs(point.y - (y + height)) <= threshold;

  if (nearTop && nearLeft) return 'nw';
  if (nearTop && nearRight) return 'ne';
  if (nearBottom && nearLeft) return 'sw';
  if (nearBottom && nearRight) return 'se';
  if (nearLeft) return 'w';
  if (nearRight) return 'e';
  if (nearTop) return 'n';
  if (nearBottom) return 's';
  return '';
}

function resizeMarkerFromPoint(marker, handle, point) {
  if (!marker || marker.type === 'arrow' || !handle || !point) return marker;

  const left = Number(marker.x);
  const top = Number(marker.y);
  const right = left + Number(marker.width);
  const bottom = top + Number(marker.height);
  const minSize = 1;
  let nextLeft = left;
  let nextTop = top;
  let nextRight = right;
  let nextBottom = bottom;

  if (handle.includes('w')) nextLeft = Math.min(point.x, right - minSize);
  if (handle.includes('e')) nextRight = Math.max(point.x, left + minSize);
  if (handle.includes('n')) nextTop = Math.min(point.y, bottom - minSize);
  if (handle.includes('s')) nextBottom = Math.max(point.y, top + minSize);

  nextLeft = Math.max(0, Math.min(100 - minSize, nextLeft));
  nextTop = Math.max(0, Math.min(100 - minSize, nextTop));
  nextRight = Math.max(nextLeft + minSize, Math.min(100, nextRight));
  nextBottom = Math.max(nextTop + minSize, Math.min(100, nextBottom));

  return {
    ...marker,
    type: marker.type || 'rect',
    x: Number(nextLeft.toFixed(2)),
    y: Number(nextTop.toFixed(2)),
    width: Number((nextRight - nextLeft).toFixed(2)),
    height: Number((nextBottom - nextTop).toFixed(2)),
  };
}

function moveMarkerByDelta(marker, deltaX, deltaY) {
  if (!marker) return null;

  if (marker.type === 'arrow') {
    const minX = Math.min(Number(marker.x1), Number(marker.x2));
    const maxX = Math.max(Number(marker.x1), Number(marker.x2));
    const minY = Math.min(Number(marker.y1), Number(marker.y2));
    const maxY = Math.max(Number(marker.y1), Number(marker.y2));
    const clampedDeltaX = Math.max(-minX, Math.min(100 - maxX, deltaX));
    const clampedDeltaY = Math.max(-minY, Math.min(100 - maxY, deltaY));

    return {
      ...marker,
      type: 'arrow',
      x1: Number((Number(marker.x1) + clampedDeltaX).toFixed(2)),
      y1: Number((Number(marker.y1) + clampedDeltaY).toFixed(2)),
      x2: Number((Number(marker.x2) + clampedDeltaX).toFixed(2)),
      y2: Number((Number(marker.y2) + clampedDeltaY).toFixed(2)),
    };
  }

  const width = Math.max(1, Math.min(100, Number(marker.width) || 1));
  const height = Math.max(1, Math.min(100, Number(marker.height) || 1));
  const x = Math.max(0, Math.min(100 - width, (Number(marker.x) || 0) + deltaX));
  const y = Math.max(0, Math.min(100 - height, (Number(marker.y) || 0) + deltaY));

  return {
    ...marker,
    type: marker.type || 'rect',
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    width: Number(width.toFixed(2)),
    height: Number(height.toFixed(2)),
  };
}

function createHighlightOverlayElement() {
  const element = document.createElement('div');
  element.className = 'diagnosticHighlightOverlay';
  return element;
}

function createPickerArrowElement(marker) {
  const element = document.createElement('div');
  element.className = 'arrowMarkerOverlay';
  const bounds = getPickerMarkerBounds(marker);
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

function getPickerMarkerBounds(marker) {
  if (!marker) return null;

  if (marker.type === 'arrow') {
    const rawX = Math.min(Number(marker.x1), Number(marker.x2));
    const rawY = Math.min(Number(marker.y1), Number(marker.y2));
    const rawWidth = Math.max(1, Math.abs(Number(marker.x2) - Number(marker.x1)));
    const rawHeight = Math.max(1, Math.abs(Number(marker.y2) - Number(marker.y1)));
    const padding = 2;
    const x = Math.max(0, rawX - padding);
    const y = Math.max(0, rawY - padding);

    return {
      x,
      y,
      width: Math.min(100 - x, rawWidth + padding * 2),
      height: Math.min(100 - y, rawHeight + padding * 2),
    };
  }

  return {
    x: Number(marker.x),
    y: Number(marker.y),
    width: Number(marker.width),
    height: Number(marker.height),
  };
}

function getCombinedMarkerBounds(markers) {
  const bounds = markers
    .map((marker) => getPickerMarkerBounds(marker))
    .filter(Boolean);

  if (bounds.length === 0) return null;

  const minX = Math.max(0, Math.min(...bounds.map((bound) => bound.x)) - 4);
  const minY = Math.max(0, Math.min(...bounds.map((bound) => bound.y)) - 4);
  const maxX = Math.min(100, Math.max(...bounds.map((bound) => bound.x + bound.width)) + 4);
  const maxY = Math.min(100, Math.max(...bounds.map((bound) => bound.y + bound.height)) + 4);

  return {
    type: 'rect',
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function addPickerHighlightOverlay(viewer, marker) {
  if (!viewer || !marker) return null;

  const tiledImage = viewer.world.getItemAt(0);
  const size = tiledImage?.source?.dimensions;

  if (!tiledImage || !size?.x || !size?.y) return null;
  const bounds = getPickerMarkerBounds(marker);
  if (!bounds) return null;

  const element = marker.type === 'arrow'
    ? createPickerArrowElement(marker)
    : createHighlightOverlayElement();
  const rect = tiledImage.imageToViewportRectangle(
    (bounds.x / 100) * size.x,
    (bounds.y / 100) * size.y,
    (bounds.width / 100) * size.x,
    (bounds.height / 100) * size.y
  );

  viewer.addOverlay({
    element,
    location: rect,
  });

  return element;
}

function createReviewRegionElement(className) {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

function getMarkerViewportRect(viewer, marker) {
  if (!viewer || !marker) return null;

  const tiledImage = viewer.world.getItemAt(0);
  const size = tiledImage?.source?.dimensions;
  const bounds = getPickerMarkerBounds(marker);

  if (!tiledImage || !size?.x || !size?.y || !bounds) return null;

  return tiledImage.imageToViewportRectangle(
    (bounds.x / 100) * size.x,
    (bounds.y / 100) * size.y,
    (bounds.width / 100) * size.x,
    (bounds.height / 100) * size.y
  );
}

function addReviewRegionOverlay(viewer, marker, className) {
  const rect = getMarkerViewportRect(viewer, marker);

  if (!rect) return null;

  const element = createReviewRegionElement(className);
  viewer.addOverlay({
    element,
    location: rect,
  });

  return element;
}

function HighlightPicker({ slide, highlight, markerType = 'rect', onChange }) {
  const viewerElementRef = useRef(null);
  const viewerRef = useRef(null);
  const openSeadragonRef = useRef(null);
  const dragStartRef = useRef(null);
  const markerInteractionRef = useRef(null);
  const overlayElementRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [mode, setMode] = useState('pan');

  useEffect(() => {
    let isCancelled = false;
    const element = viewerElementRef.current;
    const tileSources = createTileSource(slide?.source);

    if (!element || !tileSources) return undefined;

    setIsReady(false);
    viewerRef.current?.destroy();

    import('openseadragon').then(({ default: OpenSeadragon }) => {
      if (isCancelled) return;

      openSeadragonRef.current = OpenSeadragon;

      const viewer = OpenSeadragon({
        element,
        prefixUrl: '/openseadragon/images/',
        tileSources,
        showNavigator: false,
        showNavigationControl: false,
        animationTime: 0.2,
        blendTime: 0.1,
        visibilityRatio: 1,
        constrainDuringPan: true,
        gestureSettingsMouse: {
          scrollToZoom: true,
          dragToPan: true,
          clickToZoom: false,
          dblClickToZoom: false,
          zoomToRefPoint: true,
        },
      });

      viewerRef.current = viewer;

      const handleOpen = () => {
        viewer.viewport.goHome(true);
        setIsReady(true);
      };

      viewer.addHandler('open', handleOpen);
    });

    return () => {
      isCancelled = true;
      const viewer = viewerRef.current;
      if (overlayElementRef.current) {
        viewer?.removeOverlay(overlayElementRef.current);
        overlayElementRef.current = null;
      }
      viewer?.destroy();
      viewerRef.current = null;
      openSeadragonRef.current = null;
      setIsReady(false);
    };
  }, [slide?.source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    viewer.gestureSettingsMouse.dragToPan = mode === 'pan';
  }, [mode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !isReady) return undefined;

    if (overlayElementRef.current) {
      viewer.removeOverlay(overlayElementRef.current);
      overlayElementRef.current = null;
    }

    overlayElementRef.current = addPickerHighlightOverlay(viewer, highlight);

    return () => {
      if (viewerRef.current === viewer && overlayElementRef.current) {
        viewer.removeOverlay(overlayElementRef.current);
        overlayElementRef.current = null;
      }
    };
  }, [highlight, isReady]);

  const startDrawing = (event) => {
    if (!isReady || mode !== 'select') return;
    const point = getImagePercentPoint(
      viewerRef.current,
      openSeadragonRef.current,
      event
    );
    if (!point) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const resizeHandle = getRectResizeHandle(point, highlight);

    if (resizeHandle) {
      markerInteractionRef.current = {
        type: 'resize',
        handle: resizeHandle,
        startMarker: highlight,
      };
      dragStartRef.current = null;
      return;
    }

    if (isPointInsideMarker(point, highlight)) {
      markerInteractionRef.current = {
        type: 'move',
        startPoint: point,
        startMarker: highlight,
      };
      dragStartRef.current = null;
      return;
    }

    markerInteractionRef.current = { type: 'draw' };
    dragStartRef.current = point;
    onChange(
      markerType === 'arrow'
        ? buildArrowFromPoints(point, point)
        : buildHighlightFromPoints(point, point)
    );
  };

  const updateDrawing = (event) => {
    const interaction = markerInteractionRef.current;
    if (mode !== 'select' || !interaction) return;
    const point = getImagePercentPoint(
      viewerRef.current,
      openSeadragonRef.current,
      event
    );
    if (!point) return;

    event.preventDefault();

    if (interaction.type === 'move') {
      onChange(
        moveMarkerByDelta(
          interaction.startMarker,
          point.x - interaction.startPoint.x,
          point.y - interaction.startPoint.y
        )
      );
      return;
    }

    if (interaction.type === 'resize') {
      onChange(resizeMarkerFromPoint(interaction.startMarker, interaction.handle, point));
      return;
    }

    if (!dragStartRef.current) return;

    onChange(
      markerType === 'arrow'
        ? buildArrowFromPoints(dragStartRef.current, point)
        : buildHighlightFromPoints(dragStartRef.current, point)
    );
  };

  const finishDrawing = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    markerInteractionRef.current = null;
  };

  const zoomBy = (factor) => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    viewer.viewport.zoomBy(factor);
    viewer.viewport.applyConstraints();
  };

  const resetView = () => {
    viewerRef.current?.viewport.goHome();
  };

  const selectMode = (nextMode) => {
    setMode(nextMode);
    viewerElementRef.current?.parentElement?.focus();
  };

  const handleKeyDown = (event) => {
    const key = event.key.toLowerCase();

    if (key === 'v' || key === 'м') {
      event.preventDefault();
      setMode('pan');
    }

    if (key === 'b' || key === 'и') {
      event.preventDefault();
      setMode('select');
    }
  };

  return (
    <div
      className="highlightPicker"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Редактор выделения структуры"
    >
      <div ref={viewerElementRef} className="highlightPickerViewer" />
      <div className="highlightPickerControls" aria-label="Масштаб препарата">
        <button
          type="button"
          className={mode === 'pan' ? 'active' : ''}
          onClick={() => selectMode('pan')}
          disabled={!isReady}
        >
          Перемещение (V)
        </button>
        <button
          type="button"
          className={mode === 'select' ? 'active' : ''}
          onClick={() => selectMode('select')}
          disabled={!isReady}
        >
          Выделение (B)
        </button>
        <button type="button" onClick={() => zoomBy(0.7)} disabled={!isReady}>
          −
        </button>
        <button type="button" onClick={resetView} disabled={!isReady}>
          Общий вид
        </button>
        <button type="button" onClick={() => zoomBy(1.35)} disabled={!isReady}>
          +
        </button>
      </div>
      <div
        className={mode === 'select' ? 'highlightPickerLayer active' : 'highlightPickerLayer'}
        title="Колесико мыши меняет масштаб. V - перемещение, B - выделение."
        onPointerDown={startDrawing}
        onPointerMove={updateDrawing}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
      />
    </div>
  );
}

function SlideMiniPreview({ source }) {
  const viewerElementRef = useRef(null);
  const viewerRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let isCancelled = false;
    const element = viewerElementRef.current;
    const tileSources = createTileSource(source);

    if (!element || !tileSources) return undefined;

    setError('');
    viewerRef.current?.destroy();

    import('openseadragon')
      .then(({ default: OpenSeadragon }) => {
        if (isCancelled) return;

        const viewer = OpenSeadragon({
          element,
          prefixUrl: '/openseadragon/images/',
          tileSources,
          showNavigator: false,
          showNavigationControl: false,
          animationTime: 0.2,
          blendTime: 0.1,
          visibilityRatio: 1,
          constrainDuringPan: true,
          gestureSettingsMouse: {
            scrollToZoom: true,
            clickToZoom: false,
            dblClickToZoom: false,
          },
        });

        viewer.addHandler('open', () => {
          viewer.viewport.goHome(true);
        });
        viewer.addHandler('open-failed', () => {
          setError('Не удалось открыть предпросмотр.');
        });

        viewerRef.current = viewer;
      })
      .catch(() => {
        setError('Не удалось загрузить viewer.');
      });

    return () => {
      isCancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [source]);

  return (
    <div className="slideMiniPreview">
      <div ref={viewerElementRef} className="slideMiniViewer" />
      {error && <p>{error}</p>}
    </div>
  );
}

function RegionReviewPreview({ answer, question, slide }) {
  const viewerElementRef = useRef(null);
  const viewerRef = useRef(null);
  const overlaysRef = useRef([]);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState('');
  const selectedRegion = useMemo(
    () => (answer?.selectedRegion ? normalizeAdminMarker(answer.selectedRegion) : null),
    [answer]
  );
  const correctRegions = useMemo(() => {
    if (!question) return [];
    return normalizeAdminQuestion(question).regions;
  }, [question]);
  const hasPreviewData = Boolean(slide?.source && (selectedRegion || correctRegions.length > 0));

  useEffect(() => {
    let isCancelled = false;
    const element = viewerElementRef.current;
    const tileSources = createTileSource(slide?.source);

    setError('');
    setIsReady(false);

    if (!element || !tileSources) {
      if (!slide?.source) {
        setError('Препарат для этого вопроса не найден.');
      }
      return undefined;
    }

    viewerRef.current?.destroy();

    import('openseadragon')
      .then(({ default: OpenSeadragon }) => {
        if (isCancelled) return;

        const viewer = OpenSeadragon({
          element,
          prefixUrl: '/openseadragon/images/',
          tileSources,
          showNavigator: false,
          showNavigationControl: false,
          animationTime: 0.2,
          blendTime: 0.1,
          visibilityRatio: 1,
          constrainDuringPan: true,
          gestureSettingsMouse: {
            scrollToZoom: true,
            dragToPan: true,
            clickToZoom: false,
            dblClickToZoom: false,
            zoomToRefPoint: true,
          },
        });

        viewerRef.current = viewer;

        viewer.addHandler('open', () => {
          if (isCancelled) return;
          viewer.viewport.goHome(true);
          setIsReady(true);
        });
        viewer.addHandler('open-failed', () => {
          if (!isCancelled) {
            setError('Не удалось загрузить препарат для просмотра области.');
          }
        });
      })
      .catch(() => {
        if (!isCancelled) {
          setError('Не удалось открыть просмотр препарата.');
        }
      });

    return () => {
      isCancelled = true;
      const viewer = viewerRef.current;
      overlaysRef.current.forEach((overlay) => viewer?.removeOverlay(overlay));
      overlaysRef.current = [];
      viewer?.destroy();
      viewerRef.current = null;
      setIsReady(false);
    };
  }, [slide?.source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !isReady) return undefined;

    overlaysRef.current.forEach((overlay) => viewer.removeOverlay(overlay));
    overlaysRef.current = [];

    correctRegions.forEach((region) => {
      const overlay = addReviewRegionOverlay(viewer, region, 'reviewCorrectRegionOverlay');
      if (overlay) overlaysRef.current.push(overlay);
    });

    if (selectedRegion) {
      const overlay = addReviewRegionOverlay(viewer, selectedRegion, 'reviewSelectedRegionOverlay');
      if (overlay) overlaysRef.current.push(overlay);
    }

    const focusMarker = getCombinedMarkerBounds([
      selectedRegion,
      ...correctRegions,
    ].filter(Boolean));
    const focusRect = getMarkerViewportRect(viewer, focusMarker);
    if (focusRect) {
      viewer.viewport.fitBoundsWithConstraints(focusRect, true);
    }

    return () => {
      if (viewerRef.current === viewer) {
        overlaysRef.current.forEach((overlay) => viewer.removeOverlay(overlay));
        overlaysRef.current = [];
      }
    };
  }, [correctRegions, isReady, selectedRegion]);

  if (!selectedRegion) {
    return <p className="adminHint regionReviewEmpty">Студент не выделил область.</p>;
  }

  if (!hasPreviewData || error) {
    return <p className="adminHint regionReviewEmpty">{error || 'Нет данных для просмотра области.'}</p>;
  }

  const zoomBy = (factor) => {
    const viewer = viewerRef.current;
    if (!viewer || !isReady) return;
    viewer.viewport.zoomBy(factor);
    viewer.viewport.applyConstraints();
  };

  const resetView = () => {
    const viewer = viewerRef.current;
    if (!viewer || !isReady) return;
    viewer.viewport.goHome();
  };

  return (
    <div className="regionReviewPreview">
      <div className="regionReviewHeader">
        <div className="regionReviewLegend">
          <span><i className="regionReviewSwatch selected" />Ответ студента</span>
          <span><i className="regionReviewSwatch correct" />Эталон</span>
        </div>
        <div className="regionReviewControls">
          <button type="button" onClick={() => zoomBy(0.75)} disabled={!isReady}>−</button>
          <button type="button" onClick={resetView} disabled={!isReady}>Общий вид</button>
          <button type="button" onClick={() => zoomBy(1.35)} disabled={!isReady}>+</button>
        </div>
      </div>
      <div ref={viewerElementRef} className="regionReviewViewer" />
    </div>
  );
}

function normalizeSlideDiagnosticSigns(signs) {
  if (!Array.isArray(signs)) return [];

  return signs
    .map((sign) => {
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
    })
    .filter((sign) => sign.text || sign.marker);
}

function normalizeAdminMarker(marker) {
  if (!marker) return null;

  if (marker.type === 'arrow') {
    return {
      type: 'arrow',
      x1: marker.x1 ?? marker.x ?? 35,
      y1: marker.y1 ?? marker.y ?? 35,
      x2: marker.x2 ?? 55,
      y2: marker.y2 ?? 45,
    };
  }

  return {
    type: 'rect',
    x: marker.x ?? 35,
    y: marker.y ?? 35,
    width: marker.width ?? 20,
    height: marker.height ?? 18,
  };
}

function questionsToText(questions) {
  if (!Array.isArray(questions)) return '';
  return questions.join('\n');
}

function normalizeAdminQuestion(question) {
  const type = question.answer?.type || question.type || 'single';
  const rawOptions = Array.isArray(question.answer?.options)
    ? question.answer.options
    : Array.isArray(question.options)
      ? question.options
      : [];
  const options = rawOptions.map((option, index) => {
    const text = typeof option === 'string' ? option : option?.text;
    const isCorrect =
      typeof option === 'string'
        ? type === 'multiple'
          ? (question.correctIndices || []).includes(index)
          : Number(question.correctIndex || 0) === index
        : Boolean(option?.isCorrect);

    return {
      id: typeof option === 'string' ? `opt-${index}` : option?.id || `opt-${index}`,
      text: text || '',
      isCorrect,
    };
  });
  const correctOptionIds = options.filter((option) => option.isCorrect).map((option) => option.id);

  const fallbackHighlight = normalizeAdminMarker(question.region || question.highlight) || { type: 'rect', x: 35, y: 35, width: 20, height: 18 };
  const regions = Array.isArray(question.regions)
    ? question.regions.map((region) => normalizeAdminMarker(region)).filter(Boolean)
    : [fallbackHighlight];

  return {
    ...question,
    type,
    answer: {
      type,
      shuffle: question.answer?.shuffle !== false,
      options,
      correctOptionIds,
      correctText: question.answer?.correctText || question.correctText || '',
      acceptedTexts: Array.isArray(question.answer?.acceptedTexts)
        ? question.answer.acceptedTexts
        : [],
      numeric: {
        correctValue: question.answer?.numeric?.correctValue ?? question.correctNumber ?? '',
        tolerance: question.answer?.numeric?.tolerance ?? question.tolerance ?? 0,
        min: question.answer?.numeric?.min ?? question.numberMin ?? '',
        max: question.answer?.numeric?.max ?? question.numberMax ?? '',
      },
      pairs: Array.isArray(question.answer?.pairs)
        ? question.answer.pairs
        : [
            { id: 'pair-0', left: 'Структура 1', right: 'Ответ 1' },
            { id: 'pair-1', left: 'Структура 2', right: 'Ответ 2' },
          ],
      items: Array.isArray(question.answer?.items)
        ? question.answer.items
        : [
            { id: 'item-0', text: 'Этап 1' },
            { id: 'item-1', text: 'Этап 2' },
          ],
    },
    grading: {
      mode: question.grading?.mode || 'auto',
      points: question.grading?.points || 1,
      partialCredit: Boolean(question.grading?.partialCredit),
      regionMode: question.grading?.regionMode || 'intersection',
      regionThreshold: question.grading?.regionThreshold ?? DEFAULT_REGION_THRESHOLD,
    },
    options: options.map((option) => option.text),
    correctIndex: Math.max(0, options.findIndex((option) => option.isCorrect)),
    correctIndices: options
      .map((option, index) => (option.isCorrect ? index : null))
      .filter((index) => index !== null),
    correctText: question.answer?.correctText || question.correctText || '',
    highlight: fallbackHighlight,
    regions,
  };
}

function getSlideSearchText(slide) {
  return [
    slide?.id,
    slide?.title,
    slide?.lesson,
    slide?.system,
    slide?.organ,
    slide?.stain,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

function slugifyAdminId(value) {
  const cyrillicMap = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
    ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };

  return String(value || '')
    .trim()
    .toLowerCase()
    .split('')
    .map((char) => cyrillicMap[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getSlideStatusClass(status) {
  if (status === 'ready') return 'ready';
  if (status === 'external') return 'external';
  if (status === 'missing') return 'missing';
  return 'invalid';
}

function getDiagnosticValidationWarnings(diagnostic, slides) {
  const slideById = new Map(slides.map((slide) => [slide.id, slide]));
  const warnings = [];
  const hasNumber = (value) => String(value ?? '').trim() !== '' && Number.isFinite(Number(value));

  if (!diagnostic.title.trim()) {
    warnings.push('Укажите название диагностики.');
  }

  if (diagnostic.questions.length === 0) {
    warnings.push('Добавьте хотя бы один вопрос.');
  }

  diagnostic.questions.map(normalizeAdminQuestion).forEach((question, index) => {
    const number = index + 1;
    const filledOptions = question.answer.options.filter((option) => option.text.trim());
    const correctOptionCount = question.answer.correctOptionIds.length;

    if (!question.prompt.trim()) {
      warnings.push(`Вопрос ${number}: не указан текст вопроса.`);
    }

    if (!question.slideId || !slideById.has(question.slideId)) {
      warnings.push(`Вопрос ${number}: выбранный препарат недоступен.`);
    }

    if (['single', 'multiple', 'combined'].includes(question.type) && filledOptions.length < 2) {
      warnings.push(`Вопрос ${number}: нужно минимум два варианта ответа.`);
    }

    if (['single', 'combined'].includes(question.type) && correctOptionCount !== 1) {
      warnings.push(`Вопрос ${number}: выберите один правильный вариант ответа.`);
    }

    if (question.type === 'multiple' && correctOptionCount === 0) {
      warnings.push(`Вопрос ${number}: выберите минимум один правильный вариант ответа.`);
    }

    if (['text', 'combined'].includes(question.type) && question.grading.mode !== 'manual' && !question.answer.correctText.trim()) {
      warnings.push(`Вопрос ${number}: укажите правильный открытый ответ.`);
    }

    if (question.type === 'number' && question.grading.mode !== 'manual') {
      const { correctValue, min, max } = question.answer.numeric;
      const hasExact = hasNumber(correctValue);
      const hasRange = hasNumber(min) && hasNumber(max);

      if (!hasExact && !hasRange) {
        warnings.push(`Вопрос ${number}: укажите числовой ответ или диапазон.`);
      }

      if (hasRange && Number(min) > Number(max)) {
        warnings.push(`Вопрос ${number}: нижняя граница диапазона больше верхней.`);
      }
    }

    if (
      question.type === 'matching' &&
      question.answer.pairs.filter((pair) => pair.left.trim() && pair.right.trim()).length < 2
    ) {
      warnings.push(`Вопрос ${number}: добавьте минимум две пары для сопоставления.`);
    }

    if (
      question.type === 'ordering' &&
      question.answer.items.filter((item) => item.text.trim()).length < 2
    ) {
      warnings.push(`Вопрос ${number}: добавьте минимум два элемента для упорядочивания.`);
    }

    if (question.type === 'region' && question.regions.filter((region) => region?.type !== 'arrow').length === 0) {
      warnings.push(`Вопрос ${number}: добавьте хотя бы одну правильную область.`);
    }
  });

  return warnings;
}

function formatReviewAnswer(answer) {
  if (!answer) return 'Нет ответа';
  if (answer.type === 'text') return answer.textAnswer || 'Нет ответа';
  if (answer.type === 'number') return answer.numberAnswer || 'Нет ответа';
  if (answer.type === 'matching') {
    return Object.entries(answer.selectedPairs || {}).map(([left, right]) => `${left} → ${right}`).join('; ') || 'Нет ответа';
  }
  if (answer.type === 'ordering') return (answer.orderedItemIds || []).join(' → ') || 'Нет ответа';
  if (answer.type === 'region') {
    return answer.selectedRegion
      ? `x=${answer.selectedRegion.x}; y=${answer.selectedRegion.y}; w=${answer.selectedRegion.width}; h=${answer.selectedRegion.height}`
      : 'Нет ответа';
  }
  return (answer.selectedOptions || []).join('; ') || answer.selectedOption || 'Нет ответа';
}

function getResultReviewState(result) {
  const answers = Array.isArray(result?.answers) ? result.answers : [];
  const needsManualReview = answers.some((answer) => answer.needsReview);

  if (result?.reviewedAt) {
    return 'reviewed';
  }

  if (needsManualReview) {
    return 'needs-review';
  }

  return 'auto';
}

function getResultSearchText(result) {
  return [
    result?.studentName,
    result?.group,
    result?.score,
    result?.total,
    result?.percent,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

function AdminLoginGate() {
  const [authState, setAuthState] = useState({
    isLoading: true,
    configured: false,
    authenticated: false,
  });
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadSession = useCallback(async () => {
    const response = await fetch('/api/admin/session');
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось проверить сессию администратора');
    }

    setAuthState({
      isLoading: false,
      configured: Boolean(data.configured),
      authenticated: Boolean(data.authenticated),
      role: data.role || '',
    });
  }, []);

  useEffect(() => {
    loadSession().catch((sessionError) => {
      setAuthState({
        isLoading: false,
        configured: false,
        authenticated: false,
      });
      setError(sessionError.message);
    });
  }, [loadSession]);

  const login = async (event) => {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ login: loginName, password }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось войти');
      }

      setPassword('');
      await loadSession();
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    setAuthState((current) => ({
      ...current,
      authenticated: false,
    }));
  };

  if (authState.isLoading) {
    return (
      <div className="adminLoginPage">
        <section className="adminLoginCard">
          <h1>Админ-панель</h1>
          <p>Проверка доступа...</p>
        </section>
      </div>
    );
  }

  if (!authState.configured) {
    return (
      <div className="adminLoginPage">
        <section className="adminLoginCard">
          <h1>Админ-панель</h1>
          <p>Авторизация администратора не настроена. Задайте `ADMIN_PASSWORD` на сервере и перезапустите backend.</p>
          {error && <p className="adminLoginError">{error}</p>}
          <a href="/" className="adminBackLink">Открыть атлас</a>
        </section>
      </div>
    );
  }

  if (!authState.authenticated) {
    return (
      <div className="adminLoginPage">
        <form className="adminLoginCard" onSubmit={login}>
          <div>
            <h1>Вход в админ-панель</h1>
            <p>Введите пароль администратора, чтобы управлять препаратами и диагностиками.</p>
          </div>
          <label>
            Логин
            <input
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <p className="adminLoginError">{error}</p>}
          <div className="adminLoginActions">
            <button type="submit" disabled={isSubmitting || !loginName || !password}>
              {isSubmitting ? 'Вход...' : 'Войти'}
            </button>
            <a href="/" className="adminSecondaryButton">Открыть атлас</a>
          </div>
        </form>
      </div>
    );
  }

  return <AdminDashboard onLogout={logout} role={authState.role} />;
}

function AdminDashboard({ onLogout, role }) {
  const [slides, setSlides] = useState([]);
  const [status, setStatus] = useState('');
  const [jobProgress, setJobProgress] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [file, setFile] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [activeSlideSignIndex, setActiveSlideSignIndex] = useState(0);
  const [diagnostics, setDiagnostics] = useState([]);
  const [diagnosticStatus, setDiagnosticStatus] = useState('');
  const [diagnosticForm, setDiagnosticForm] = useState(INITIAL_DIAGNOSTIC_FORM);
  const [editingDiagnosticId, setEditingDiagnosticId] = useState(null);
  const [activeDiagnosticQuestionIndex, setActiveDiagnosticQuestionIndex] = useState(0);
  const [activeAdminTab, setActiveAdminTab] = useState('slides');
  const [activeRegionIndex, setActiveRegionIndex] = useState(0);
  const [diagnosticSlideSearch, setDiagnosticSlideSearch] = useState('');
  const [diagnosticResults, setDiagnosticResults] = useState([]);
  const [selectedDiagnosticForResults, setSelectedDiagnosticForResults] = useState(null);
  const [selectedResult, setSelectedResult] = useState(null);
  const [resultsStatus, setResultsStatus] = useState('');
  const [hasDiagnosticDraft, setHasDiagnosticDraft] = useState(false);
  const [draftStatus, setDraftStatus] = useState('');
  const [slideListSearch, setSlideListSearch] = useState('');
  const [slideOrganFilter, setSlideOrganFilter] = useState('all');
  const [slideSystemFilter, setSlideSystemFilter] = useState('all');
  const [slideStatusFilter, setSlideStatusFilter] = useState('all');
  const [slideSort, setSlideSort] = useState('title');
  const [diagnosticStatusFilter, setDiagnosticStatusFilter] = useState('all');
  const [resultSearch, setResultSearch] = useState('');
  const [resultReviewFilter, setResultReviewFilter] = useState('all');
  const [backups, setBackups] = useState([]);
  const [backupStatus, setBackupStatus] = useState('');
  const [isBackupBusy, setIsBackupBusy] = useState(false);
  const [previewSlideId, setPreviewSlideId] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState(createEmptyUserForm);
  const [usersStatus, setUsersStatus] = useState('');

  const currentRolePreset = ROLE_PERMISSION_PRESETS[userForm.role] || ROLE_PERMISSION_PRESETS.student;
  const getUserFormPermission = (permission) => (
    Object.hasOwn(userForm.permissionOverrides || {}, permission)
      ? Boolean(userForm.permissionOverrides[permission])
      : Boolean(currentRolePreset[permission])
  );
  const enabledUserFormPermissions = PERMISSION_KEYS.filter((permission) => getUserFormPermission(permission)).length;
  const changedUserFormPermissions = Object.keys(userForm.permissionOverrides || {}).length;
  const canSubmitUserForm = userForm.login.trim() && userForm.fullName.trim() && (userForm.id || userForm.password.trim());

  const isEditing = Boolean(editingId);
  const isEditingDiagnostic = Boolean(editingDiagnosticId);
  const activeDiagnosticQuestion =
    diagnosticForm.questions[activeDiagnosticQuestionIndex] || null;
  const activeDiagnosticSlide = useMemo(() => {
    return slides.find((slide) => slide.id === activeDiagnosticQuestion?.slideId) || slides[0] || null;
  }, [activeDiagnosticQuestion?.slideId, slides]);
  const filteredDiagnosticSlides = useMemo(() => {
    const query = diagnosticSlideSearch.trim().toLowerCase();

    if (!query) return slides;

    return slides.filter((slide) => getSlideSearchText(slide).includes(query));
  }, [diagnosticSlideSearch, slides]);
  const diagnosticSlideOptions = useMemo(() => {
    if (
      !activeDiagnosticSlide ||
      filteredDiagnosticSlides.some((slide) => slide.id === activeDiagnosticSlide.id)
    ) {
      return filteredDiagnosticSlides;
    }

    return [activeDiagnosticSlide, ...filteredDiagnosticSlides];
  }, [activeDiagnosticSlide, filteredDiagnosticSlides]);
  const publicationWarnings = useMemo(
    () => getDiagnosticValidationWarnings(diagnosticForm, slides),
    [diagnosticForm, slides]
  );
  const isPublishedWithWarnings = diagnosticForm.isPublished && publicationWarnings.length > 0;
  const slideOrganOptions = useMemo(() => {
    return Array.from(new Set(slides.map((slide) => slide.organ).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, 'ru')
    );
  }, [slides]);
  const slideSystemOptions = useMemo(() => {
    return Array.from(new Set(slides.map((slide) => slide.system).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, 'ru')
    );
  }, [slides]);
  const filteredAdminSlides = useMemo(() => {
    const query = slideListSearch.trim().toLowerCase();

    return slides
      .filter((slide) => {
        const matchesSearch = !query || getSlideSearchText(slide).includes(query);
        const matchesOrgan = slideOrganFilter === 'all' || slide.organ === slideOrganFilter;
        const matchesSystem = slideSystemFilter === 'all' || slide.system === slideSystemFilter;
        const matchesStatus =
          slideStatusFilter === 'all' || slide.fileStatus?.status === slideStatusFilter;

        return matchesSearch && matchesOrgan && matchesSystem && matchesStatus;
      })
      .sort((left, right) => {
        if (slideSort === 'id') return left.id.localeCompare(right.id, 'ru');
        if (slideSort === 'organ') {
          return String(left.organ || '').localeCompare(String(right.organ || ''), 'ru');
        }
        if (slideSort === 'status') {
          return String(left.fileStatus?.label || '').localeCompare(
            String(right.fileStatus?.label || ''),
            'ru'
          );
        }

        return String(left.title || '').localeCompare(String(right.title || ''), 'ru');
      });
  }, [
    slideListSearch,
    slideOrganFilter,
    slideSort,
    slideStatusFilter,
    slideSystemFilter,
    slides,
  ]);
  const normalizedSlideFormId = slugifyAdminId(form.id);
  const occupiedSlideId = !isEditing && normalizedSlideFormId
    ? slides.find((slide) => slide.id === normalizedSlideFormId)
    : null;
  const filteredAdminDiagnostics = useMemo(() => {
    return diagnostics.filter((diagnostic) => {
      if (diagnosticStatusFilter === 'all') return true;
      return diagnostic.status === diagnosticStatusFilter;
    });
  }, [diagnosticStatusFilter, diagnostics]);
  const reviewQuestionById = useMemo(() => {
    return new Map(
      (selectedDiagnosticForResults?.questions || []).map((question) => [question.id, question])
    );
  }, [selectedDiagnosticForResults]);
  const slideById = useMemo(() => {
    return new Map(slides.map((slide) => [slide.id, slide]));
  }, [slides]);
  const resultReviewStats = useMemo(() => {
    return diagnosticResults.reduce(
      (stats, result) => {
        const state = getResultReviewState(result);
        return {
          ...stats,
          [state]: stats[state] + 1,
        };
      },
      { all: diagnosticResults.length, 'needs-review': 0, reviewed: 0, auto: 0 }
    );
  }, [diagnosticResults]);
  const filteredDiagnosticResults = useMemo(() => {
    const query = resultSearch.trim().toLowerCase();

    return diagnosticResults.filter((result) => {
      const state = getResultReviewState(result);
      const matchesFilter = resultReviewFilter === 'all' || state === resultReviewFilter;
      const matchesSearch = !query || getResultSearchText(result).includes(query);

      return matchesFilter && matchesSearch;
    });
  }, [diagnosticResults, resultReviewFilter, resultSearch]);

  const loadSlides = async () => {
    const response = await fetch('/api/admin/slides');

    if (!response.ok) {
      throw new Error(`Ошибка загрузки списка: ${response.status}`);
    }

    const data = await response.json();
    setSlides(Array.isArray(data) ? data : []);
  };

  const loadDiagnostics = async () => {
    const response = await fetch('/api/admin/diagnostics');

    if (!response.ok) {
      throw new Error(`Ошибка загрузки диагностик: ${response.status}`);
    }

    const data = await response.json();
    setDiagnostics(Array.isArray(data) ? data : []);
  };

  const loadBackups = async () => {
    const response = await fetch('/api/admin/backups');

    if (!response.ok) {
      throw new Error(`Ошибка загрузки backup: ${response.status}`);
    }

    const data = await response.json();
    setBackups(Array.isArray(data) ? data : []);
  };

  const loadUsers = async () => {
    const response = await fetch('/api/admin/users');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить пользователей');
    setUsers(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    loadSlides().catch((error) => {
      setStatus(`Ошибка: ${error.message}`);
    });
    loadDiagnostics().catch((error) => {
      setDiagnosticStatus(`Ошибка: ${error.message}`);
    });
    if (role === 'admin') {
      loadBackups().catch((error) => {
        setBackupStatus(`Ошибка: ${error.message}`);
      });
      loadUsers().catch((error) => setUsersStatus(`Ошибка: ${error.message}`));
    }
  }, [role]);

  useEffect(() => {
    setHasDiagnosticDraft(Boolean(window.localStorage.getItem(DIAGNOSTIC_DRAFT_KEY)));
  }, []);

  useEffect(() => {
    if (activeAdminTab !== 'diagnostics') return undefined;

    const timeoutId = window.setTimeout(() => {
      window.localStorage.setItem(
        DIAGNOSTIC_DRAFT_KEY,
        JSON.stringify({
          diagnosticForm,
          editingDiagnosticId,
          activeDiagnosticQuestionIndex,
          savedAt: new Date().toISOString(),
        })
      );
      setHasDiagnosticDraft(true);
      setDraftStatus('Черновик сохранен локально');
    }, 700);

    return () => window.clearTimeout(timeoutId);
  }, [activeAdminTab, activeDiagnosticQuestionIndex, diagnosticForm, editingDiagnosticId]);

  useEffect(() => {
    const question = activeDiagnosticQuestion
      ? normalizeAdminQuestion(activeDiagnosticQuestion)
      : null;

    if (!question) {
      setActiveRegionIndex(0);
      return;
    }

    setActiveRegionIndex((current) =>
      Math.max(0, Math.min(current, Math.max(0, question.regions.length - 1)))
    );
  }, [activeDiagnosticQuestion]);

  useEffect(() => {
    if (!selectedDiagnosticForResults) return;
    if (filteredDiagnosticResults.length === 0) {
      setSelectedResult(null);
      return;
    }

    if (!selectedResult || !filteredDiagnosticResults.some((result) => result.id === selectedResult.id)) {
      setSelectedResult(filteredDiagnosticResults[0]);
    }
  }, [filteredDiagnosticResults, selectedDiagnosticForResults, selectedResult]);

  const waitForJob = async (jobId) => {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const response = await fetch(`/api/admin/jobs/${jobId}`);
          const job = await response.json();

          if (!response.ok) {
            throw new Error(job.error || 'Не удалось получить статус задачи');
          }

          setJobProgress(Number(job.progress || 0));
          setStatus(`${job.message}${job.progress ? ` — ${job.progress}%` : ''}`);

          if (job.status === 'done') {
            clearInterval(interval);
            setJobProgress(100);
            resolve(job);
          }

          if (job.status === 'error') {
            clearInterval(interval);
            setJobProgress(null);
            reject(new Error(job.error || job.message || 'Ошибка обработки'));
          }
        } catch (error) {
          clearInterval(interval);
          setJobProgress(null);
          reject(error);
        }
      }, 1500);
    });
  };

  const updateUserForm = (field, value) => {
    setUserForm((current) => ({ ...current, [field]: value }));
  };

  const toggleUserPermission = (permission) => {
    setUserForm((current) => {
      const rolePreset = ROLE_PERMISSION_PRESETS[current.role] || ROLE_PERMISSION_PRESETS.student;
      const currentValue = Object.hasOwn(current.permissionOverrides || {}, permission)
        ? Boolean(current.permissionOverrides[permission])
        : Boolean(rolePreset[permission]);

      return {
        ...current,
        permissionOverrides: {
          ...current.permissionOverrides,
          [permission]: !currentValue,
        },
      };
    });
  };

  const applyRolePermissions = () => {
    setUserForm((current) => ({ ...current, permissionOverrides: {} }));
  };

  const countEnabledPermissions = (permissions = {}) => (
    PERMISSION_KEYS.filter((permission) => Boolean(permissions[permission])).length
  );

  const resetUserForm = () => {
    setUserForm(createEmptyUserForm());
  };

  const editUser = (user) => {
    setUserForm({
      id: user.id,
      login: user.login || '',
      email: user.email || '',
      fullName: user.fullName || user.name || '',
      password: '',
      role: user.role || 'teacher_limited',
      isActive: user.isActive !== false,
      permissionOverrides: user.permissionOverrides || {},
    });
  };

  const saveUser = async (event) => {
    event.preventDefault();
    setUsersStatus(userForm.id ? 'Сохранение пользователя...' : 'Создание пользователя...');
    try {
      const payload = {
        login: userForm.login.trim(),
        email: userForm.email.trim(),
        fullName: userForm.fullName.trim(),
        role: userForm.role,
        isActive: userForm.isActive,
        permissionOverrides: userForm.permissionOverrides,
      };
      if (!userForm.id || userForm.password.trim()) {
        payload.password = userForm.password;
      }
      const response = await fetch(userForm.id ? `/api/admin/users/${userForm.id}` : '/api/admin/users', {
        method: userForm.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить пользователя');
      setUsersStatus(userForm.id ? `Пользователь ${data.login} сохранён` : `Пользователь ${data.login} создан`);
      resetUserForm();
      await loadUsers();
    } catch (error) {
      setUsersStatus(`Ошибка: ${error.message}`);
    }
  };

  const changeUserPassword = async (user) => {
    const password = window.prompt(`Новый пароль для ${user.login}:`);
    if (!password) return;
    const response = await fetch(`/api/admin/users/${user.id}/password`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    const data = await response.json();
    setUsersStatus(response.ok ? `Пароль ${user.login} изменён` : `Ошибка: ${data.error || 'не удалось изменить пароль'}`);
  };

  const toggleUserStatus = async (user) => {
    const response = await fetch(`/api/admin/users/${user.id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !user.isActive }),
    });
    const data = await response.json();
    if (!response.ok) {
      setUsersStatus(`Ошибка: ${data.error || 'не удалось изменить статус'}`);
      return;
    }
    setUsersStatus(data.isActive ? `Пользователь ${data.login} активен` : `Пользователь ${data.login} заблокирован`);
    await loadUsers();
  };

  const deleteUser = async (user) => {
    if (!window.confirm(`Удалить или деактивировать пользователя ${user.login}?`)) return;
    const response = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) {
      setUsersStatus(`Ошибка: ${data.error || 'не удалось удалить пользователя'}`);
      return;
    }
    setUsersStatus(`Пользователь ${user.login} деактивирован`);
    await loadUsers();
  };

  const updateField = (field, value) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateSlideDiagnosticSign = (index, patch) => {
    setForm((current) => ({
      ...current,
      diagnosticSigns: current.diagnosticSigns.map((sign, signIndex) =>
        signIndex === index
          ? {
              ...sign,
              ...patch,
            }
          : sign
      ),
    }));
  };

  const addSlideDiagnosticSign = () => {
    setForm((current) => {
      const nextSigns = [
        ...current.diagnosticSigns,
        {
          text: '',
          marker: null,
        },
      ];

      setActiveSlideSignIndex(nextSigns.length - 1);
      return {
        ...current,
        diagnosticSigns: nextSigns,
      };
    });
  };

  const removeSlideDiagnosticSign = (index) => {
    setForm((current) => ({
      ...current,
      diagnosticSigns: current.diagnosticSigns.filter((_, signIndex) => signIndex !== index),
    }));
    setActiveSlideSignIndex((current) => Math.max(0, current - 1));
  };

  const changeSlideSignMarkerType = (index, markerType) => {
    const currentMarker = form.diagnosticSigns[index]?.marker;
    const nextMarker =
      markerType === 'arrow'
        ? {
            type: 'arrow',
            x1: currentMarker?.x1 ?? currentMarker?.x ?? 35,
            y1: currentMarker?.y1 ?? currentMarker?.y ?? 35,
            x2: currentMarker?.x2 ?? 55,
            y2: currentMarker?.y2 ?? 45,
          }
        : {
            type: 'rect',
            x: currentMarker?.x ?? 35,
            y: currentMarker?.y ?? 35,
            width: currentMarker?.width ?? 20,
            height: currentMarker?.height ?? 18,
          };

    updateSlideDiagnosticSign(index, {
      marker: nextMarker,
    });
  };

  const resetForm = ({ clearStatus = true } = {}) => {
    setForm(INITIAL_FORM);
    setFile(null);
    setEditingId(null);
    setActiveSlideSignIndex(0);
    if (clearStatus) setStatus('');
    setJobProgress(null);

    const fileInput = document.getElementById('slideFile');
    if (fileInput) fileInput.value = '';
  };

  const startEdit = (slide) => {
    setEditingId(slide.id);

    setForm({
      id: slide.id || '',
      title: slide.title || '',
      lesson: slide.lesson || '',
      system: slide.system || '',
      organ: slide.organ || '',
      stain: slide.stain || 'H&E',
      description: slide.description || '',
      diagnosticSigns: normalizeSlideDiagnosticSigns(slide.diagnosticSigns),
      selfCheckQuestions: questionsToText(slide.selfCheckQuestions),
      source: slide.source || '',
    });

    setFile(null);
    setActiveSlideSignIndex(0);
    setJobProgress(null);
    setStatus(`Редактирование: ${slide.title}`);

    const fileInput = document.getElementById('slideFile');
    if (fileInput) fileInput.value = '';

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  const submitForm = async (event) => {
    event.preventDefault();

    if (occupiedSlideId) {
      setStatus(
        `Ошибка: ID "${occupiedSlideId.id}" уже занят препаратом "${occupiedSlideId.title}". Выберите другой ID или откройте этот препарат на редактирование.`
      );
      return;
    }

    setIsLoading(true);
    setJobProgress(file ? 0 : null);
    setStatus(
      isEditing
        ? 'Сохранение изменений...'
        : 'Загрузка и обработка препарата...'
    );

    try {
      const formData = new FormData();

      Object.entries(form).forEach(([key, value]) => {
        formData.append(
          key,
          key === 'diagnosticSigns' || key === 'courseIds' || key === 'groupIds' ? JSON.stringify(value) : value
        );
      });

      if (file) {
        formData.append('slideFile', file);
      }

      const url = isEditing
        ? `/api/admin/slides/${editingId}`
        : '/api/admin/slides';

      const response = await fetch(url, {
        method: isEditing ? 'PUT' : 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || result.details || 'Ошибка сохранения');
      }

      if (result.jobId) {
        await waitForJob(result.jobId);
      }

      resetForm({ clearStatus: false });
      setStatus(
        isEditing
          ? 'Изменения успешно сохранены'
          : 'Препарат успешно добавлен'
      );

      await loadSlides();
    } catch (error) {
      setStatus(`Ошибка: ${error.message}`);
    } finally {
      setIsLoading(false);
      setJobProgress(null);
    }
  };

  const importSlideCards = async (event) => {
    const importFile = event.target.files?.[0];
    event.target.value = '';
    if (!importFile) return;

    setIsImporting(true);
    setImportStatus(`Чтение файла ${importFile.name}...`);

    try {
      const slidesToImport = normalizeImportedSlides(
        await importFile.text(),
        importFile.name
      );
      const response = await fetch('/api/admin/slides/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slides: slidesToImport }),
      });
      const result = await response.json();

      if (!response.ok && !result.created?.length) {
        throw new Error(result.error || 'Не удалось импортировать карточки');
      }

      const createdCount = result.created?.length || 0;
      const skipped = result.skipped || [];
      const skippedText = skipped.length
        ? ` Пропущено: ${skipped.length}. ${skipped.slice(0, 3).map((item) => `Строка ${item.row}: ${item.error}`).join(' ')}`
        : '';
      setImportStatus(`Добавлено карточек: ${createdCount}.${skippedText}`);
      await loadSlides();
    } catch (error) {
      setImportStatus(`Ошибка импорта: ${error.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  const deleteSlide = async (id) => {
    if (
      !window.confirm(
        'Удалить препарат из списка и удалить связанные файлы препарата?'
      )
    ) {
      return;
    }

    const response = await fetch(`/api/admin/slides/${id}`, {
      method: 'DELETE',
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatus(result.error || 'Не удалось удалить препарат');
      return;
    }

    if (editingId === id) {
      resetForm();
    }

    setStatus(result.message || 'Препарат и связанные файлы удалены');
    await loadSlides();
  };

  const updateDiagnosticField = (field, value) => {
    setDiagnosticForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateDiagnosticQuestion = (index, patch) => {
    setDiagnosticForm((current) => ({
      ...current,
      questions: current.questions.map((question, questionIndex) =>
        questionIndex === index
          ? {
              ...question,
              ...patch,
            }
          : question
      ),
    }));
  };

  const updateQuestionHighlight = (index, field, value) => {
    const number = Number(value);
    const question = normalizeAdminQuestion(diagnosticForm.questions[index]);
    const nextRegions = question.regions.map((region, regionIndex) =>
      regionIndex === Math.min(activeRegionIndex, question.regions.length - 1)
        ? {
            ...region,
            [field]: Number.isFinite(number) ? number : 0,
          }
        : region
    );

    updateDiagnosticQuestion(index, {
      highlight: nextRegions[0],
      region: nextRegions[0],
      regions: nextRegions,
    });
  };

  const setQuestionRegion = (questionIndex, regionIndex, region) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    const nextRegions = question.regions.map((item, index) =>
      index === regionIndex ? normalizeAdminMarker(region) : item
    );

    updateDiagnosticQuestion(questionIndex, {
      highlight: nextRegions[0],
      region: nextRegions[0],
      regions: nextRegions,
    });
  };

  const changeQuestionRegionType = (questionIndex, regionIndex, markerType) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    const currentMarker = question.regions[regionIndex] || question.highlight;
    const nextMarker = normalizeAdminMarker(
      markerType === 'arrow'
        ? {
            type: 'arrow',
            x1: currentMarker?.x1 ?? currentMarker?.x ?? 35,
            y1: currentMarker?.y1 ?? currentMarker?.y ?? 35,
            x2: currentMarker?.x2 ?? 55,
            y2: currentMarker?.y2 ?? 45,
          }
        : {
            type: 'rect',
            x: currentMarker?.x ?? currentMarker?.x1 ?? 35,
            y: currentMarker?.y ?? currentMarker?.y1 ?? 35,
            width: currentMarker?.width ?? 20,
            height: currentMarker?.height ?? 18,
          }
    );
    const nextRegions = question.regions.map((item, index) =>
      index === regionIndex ? nextMarker : item
    );

    updateDiagnosticQuestion(questionIndex, {
      highlight: nextRegions[0],
      region: nextRegions[0],
      regions: nextRegions,
    });
  };

  const addQuestionRegion = (questionIndex) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    const baseRegion = normalizeAdminMarker(
      question.regions[Math.min(activeRegionIndex, Math.max(0, question.regions.length - 1))] ||
      question.highlight ||
      { type: 'rect', x: 35, y: 35, width: 20, height: 18 }
    );
    const nextRegion = baseRegion.type === 'arrow'
      ? {
          ...baseRegion,
          x1: Math.min(95, Number(baseRegion.x1 || 0) + 3),
          y1: Math.min(95, Number(baseRegion.y1 || 0) + 3),
          x2: Math.min(100, Number(baseRegion.x2 || 0) + 3),
          y2: Math.min(100, Number(baseRegion.y2 || 0) + 3),
        }
      : {
          ...baseRegion,
          x: Math.min(95, Number(baseRegion.x || 0) + 3),
          y: Math.min(95, Number(baseRegion.y || 0) + 3),
        };
    const nextRegions = [...question.regions, nextRegion];

    updateDiagnosticQuestion(questionIndex, {
      highlight: nextRegions[0],
      region: nextRegions[0],
      regions: nextRegions,
    });
    setActiveRegionIndex(nextRegions.length - 1);
  };

  const removeQuestionRegion = (questionIndex, regionIndex) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    if (question.regions.length === 0) return;

    const nextRegions = question.regions.filter((_, index) => index !== regionIndex);
    updateDiagnosticQuestion(questionIndex, {
      highlight: nextRegions[0] || null,
      region: nextRegions[0] || null,
      regions: nextRegions,
    });
    setActiveRegionIndex((current) => Math.max(0, Math.min(current, nextRegions.length - 1)));
  };

  const updateQuestionOption = (questionIndex, optionIndex, value) => {
    const question = diagnosticForm.questions[questionIndex];
    const normalizedQuestion = normalizeAdminQuestion(question);
    const nextOptions = normalizedQuestion.answer.options.map((option, index) =>
      index === optionIndex
        ? {
            ...option,
            text: value,
          }
        : option
    );

    updateDiagnosticQuestion(questionIndex, {
      answer: {
        ...normalizedQuestion.answer,
        options: nextOptions,
      },
      options: nextOptions.map((option) => option.text),
    });
  };

  const addQuestionOption = (questionIndex) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    const nextIndex = question.answer.options.length;
    const nextOptions = [
      ...question.answer.options,
      {
        id: `opt-${Date.now()}-${nextIndex}`,
        text: `Вариант ${nextIndex + 1}`,
        isCorrect: false,
      },
    ];

    updateDiagnosticQuestion(questionIndex, {
      answer: {
        ...question.answer,
        options: nextOptions,
      },
      options: nextOptions.map((option) => option.text),
    });
  };

  const removeQuestionOption = (questionIndex, optionIndex) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    if (question.answer.options.length <= 2) return;

    let nextOptions = question.answer.options.filter((_, index) => index !== optionIndex);

    if (!nextOptions.some((option) => option.isCorrect)) {
      nextOptions = nextOptions.map((option, index) => ({
        ...option,
        isCorrect: index === 0,
      }));
    }

    updateDiagnosticQuestion(questionIndex, {
      answer: {
        ...question.answer,
        options: nextOptions,
      },
      options: nextOptions.map((option) => option.text),
      correctIndex: Math.max(0, nextOptions.findIndex((option) => option.isCorrect)),
      correctIndices: nextOptions
        .map((option, index) => (option.isCorrect ? index : null))
        .filter((index) => index !== null),
    });
  };

  const updateQuestionType = (questionIndex, type) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);

    updateDiagnosticQuestion(questionIndex, {
      type,
      answer: {
        ...question.answer,
        type,
      },
      correctIndex: Number.isInteger(Number(question.correctIndex))
        ? Number(question.correctIndex)
        : 0,
      correctIndices:
        Array.isArray(question.correctIndices) && question.correctIndices.length > 0
          ? question.correctIndices
          : [Number.isInteger(Number(question.correctIndex)) ? Number(question.correctIndex) : 0],
      correctText: question.correctText || '',
    });
  };

  const updateQuestionAnswer = (questionIndex, answerPatch) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);

    updateDiagnosticQuestion(questionIndex, {
      type: answerPatch.type || question.type,
      answer: {
        ...question.answer,
        ...answerPatch,
      },
    });
  };

  const toggleCorrectIndex = (questionIndex, optionIndex) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    const nextOptions = question.answer.options.map((option, index) =>
      index === optionIndex
        ? {
            ...option,
            isCorrect: !option.isCorrect,
          }
        : option
    );

    updateDiagnosticQuestion(questionIndex, {
      answer: {
        ...question.answer,
        options: nextOptions,
      },
      correctIndices: nextOptions
        .map((option, index) => (option.isCorrect ? index : null))
        .filter((index) => index !== null),
    });
  };

  const addDiagnosticQuestion = () => {
    const slideId = activeDiagnosticSlide?.id || slides[0]?.id || '';
    const nextQuestion = createDiagnosticQuestion(slideId);

    setDiagnosticForm((current) => ({
      ...current,
      questions: [...current.questions, nextQuestion],
    }));
    setActiveDiagnosticQuestionIndex(diagnosticForm.questions.length);
    setActiveRegionIndex(0);
  };

  const removeDiagnosticQuestion = (index) => {
    setDiagnosticForm((current) => ({
      ...current,
      questions: current.questions.filter((_, questionIndex) => questionIndex !== index),
    }));
    setActiveDiagnosticQuestionIndex((current) => Math.max(0, current - 1));
  };

  const resetDiagnosticForm = () => {
    setDiagnosticForm(INITIAL_DIAGNOSTIC_FORM);
    setEditingDiagnosticId(null);
    setActiveDiagnosticQuestionIndex(0);
    setDiagnosticStatus('');
  };

  const startDiagnosticEdit = (diagnostic) => {
    setEditingDiagnosticId(diagnostic.id);
    setActiveAdminTab('diagnostics');
    setDiagnosticForm({
      id: diagnostic.id,
      title: diagnostic.title || '',
      startsAt: toYekaterinburgDateTimeLocal(diagnostic.startsAt),
      endsAt: toYekaterinburgDateTimeLocal(diagnostic.endsAt),
      durationMinutes: diagnostic.durationMinutes || '',
      isPublished: diagnostic.isPublished !== false,
      questions: Array.isArray(diagnostic.questions)
        ? diagnostic.questions.map(normalizeAdminQuestion)
        : [],
    });
    setActiveDiagnosticQuestionIndex(0);
    setDiagnosticStatus(`Редактирование диагностики: ${diagnostic.title}`);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const submitDiagnosticForm = async (event) => {
    event.preventDefault();
    setDiagnosticStatus('Сохранение диагностики...');

    try {
      const url = isEditingDiagnostic
        ? `/api/admin/diagnostics/${editingDiagnosticId}`
        : '/api/admin/diagnostics';

      const response = await fetch(url, {
        method: isEditingDiagnostic ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(diagnosticForm),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Не удалось сохранить диагностику');
      }

      resetDiagnosticForm();
      window.localStorage.removeItem(DIAGNOSTIC_DRAFT_KEY);
      setHasDiagnosticDraft(false);
      setDraftStatus('');
      setDiagnosticStatus(
        isEditingDiagnostic
          ? 'Диагностика сохранена'
          : 'Диагностика создана'
      );
      await loadDiagnostics();
    } catch (error) {
      setDiagnosticStatus(`Ошибка: ${error.message}`);
    }
  };

  const restoreDiagnosticDraft = () => {
    const rawDraft = window.localStorage.getItem(DIAGNOSTIC_DRAFT_KEY);
    if (!rawDraft) return;

    try {
      const draft = JSON.parse(rawDraft);
      if (!draft?.diagnosticForm) return;

      setDiagnosticForm({
        ...INITIAL_DIAGNOSTIC_FORM,
        ...draft.diagnosticForm,
        questions: Array.isArray(draft.diagnosticForm.questions)
          ? draft.diagnosticForm.questions.map(normalizeAdminQuestion)
          : [],
      });
      setEditingDiagnosticId(draft.editingDiagnosticId || null);
      setActiveDiagnosticQuestionIndex(Number(draft.activeDiagnosticQuestionIndex || 0));
      setActiveAdminTab('diagnostics');
      setDraftStatus(`Черновик восстановлен${draft.savedAt ? ` (${new Date(draft.savedAt).toLocaleString()})` : ''}`);
    } catch {
      setDraftStatus('Не удалось восстановить черновик');
    }
  };

  const createBackup = async () => {
    setIsBackupBusy(true);
    setBackupStatus('Создание backup...');

    try {
      const response = await fetch('/api/admin/backups', {
        method: 'POST',
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Не удалось создать backup');
      }

      setBackupStatus(`Backup создан: ${result.backup.fileName}`);
      await loadBackups();
    } catch (error) {
      setBackupStatus(`Ошибка: ${error.message}`);
    } finally {
      setIsBackupBusy(false);
    }
  };

  const restoreBackup = async (backup) => {
    if (!backup?.restorable) return;

    if (
      !window.confirm(
        `Восстановить данные из ${backup.fileName}? Текущие препараты, диагностики и результаты будут заменены.`
      )
    ) {
      return;
    }

    setIsBackupBusy(true);
    setBackupStatus('Восстановление backup...');

    try {
      const response = await fetch(`/api/admin/backups/${encodeURIComponent(backup.fileName)}/restore`, {
        method: 'POST',
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Не удалось восстановить backup');
      }

      setBackupStatus(`Данные восстановлены из ${result.restoredFrom}`);
      await Promise.all([loadSlides(), loadDiagnostics(), loadBackups()]);
    } catch (error) {
      setBackupStatus(`Ошибка: ${error.message}`);
    } finally {
      setIsBackupBusy(false);
    }
  };

  const deleteDiagnostic = async (id) => {
    if (!window.confirm('Удалить диагностику? Уже выгруженные результаты останутся в файле результатов.')) {
      return;
    }

    const response = await fetch(`/api/admin/diagnostics/${id}`, {
      method: 'DELETE',
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      setDiagnosticStatus(result.error || 'Не удалось удалить диагностику');
      return;
    }

    if (editingDiagnosticId === id) {
      resetDiagnosticForm();
    }

    setDiagnosticStatus(result.message || 'Диагностика удалена');
    await loadDiagnostics();
  };

  const loadDiagnosticResults = async (diagnostic) => {
    setSelectedDiagnosticForResults(diagnostic);
    setSelectedResult(null);
    setResultsStatus('Загрузка результатов...');

    try {
      const response = await fetch(`/api/admin/diagnostics/${diagnostic.id}/results`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить результаты');
      }

      const results = Array.isArray(data) ? data : [];
      setDiagnosticResults(results);
      setSelectedResult(results[0] || null);
      setResultsStatus(results.length ? `Загружено результатов: ${results.length}` : 'Результатов пока нет');
    } catch (error) {
      setResultsStatus(`Ошибка: ${error.message}`);
    }
  };

  const updateSelectedAnswerReview = (questionId, patch) => {
    setSelectedResult((current) => {
      if (!current) return current;

      return {
        ...current,
        answers: (current.answers || []).map((answer) =>
          answer.questionId === questionId
            ? {
                ...answer,
                ...patch,
              }
            : answer
        ),
      };
    });
  };

  const saveResultReview = async () => {
    if (!selectedResult) return;

    setResultsStatus('Сохранение проверки...');

    try {
      const response = await fetch(`/api/admin/results/${selectedResult.id}/review`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reviewComment: selectedResult.reviewComment || '',
          answers: (selectedResult.answers || []).map((answer) => ({
            questionId: answer.questionId,
            earnedPoints: answer.earnedPoints,
            reviewComment: answer.reviewComment || '',
          })),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить проверку');
      }

      setSelectedResult(data.result);
      setDiagnosticResults((current) =>
        current.map((result) => (result.id === data.result.id ? data.result : result))
      );
      setResultsStatus('Проверка сохранена');
    } catch (error) {
      setResultsStatus(`Ошибка: ${error.message}`);
    }
  };

  return (
    <div className="adminPage">
      <header className="adminHeader">
        <div>
          <h1>Админ-панель</h1>
          <p>Добавление и редактирование гистологических препаратов</p>
        </div>

        <div className="adminHeaderActions">
          <a href="/" className="adminBackLink">
            Открыть атлас
          </a>
          <button type="button" className="adminSecondaryButton" onClick={onLogout}>
            Выйти
          </button>
        </div>
      </header>

      <nav className="adminTabs" aria-label="Разделы админ-панели">
        <button
          type="button"
          className={activeAdminTab === 'slides' ? 'active' : ''}
          onClick={() => setActiveAdminTab('slides')}
        >
          Препараты
        </button>
        <button
          type="button"
          className={activeAdminTab === 'diagnostics' ? 'active' : ''}
          onClick={() => setActiveAdminTab('diagnostics')}
        >
          Диагностики
        </button>
        {role === 'admin' && <button
          type="button"
          className={activeAdminTab === 'backups' ? 'active' : ''}
          onClick={() => setActiveAdminTab('backups')}
        >
          Backups
        </button>}
        {role === 'admin' && <button
          type="button"
          className={activeAdminTab === 'teachers' ? 'active' : ''}
          onClick={() => setActiveAdminTab('teachers')}
        >
          Пользователи
        </button>}
      </nav>

      <main className="adminLayout">
        {activeAdminTab === 'slides' && (
        <>
        <section className="adminCard slideImportCard">
          <div className="adminCardHeader">
            <div>
              <h2>Импорт карточек</h2>
              <p>Загрузите CSV или JSON с готовыми DZI-адресами. Файлы препаратов добавляются отдельно.</p>
            </div>
            <label className="adminSecondaryButton importFileButton">
              {isImporting ? 'Импорт...' : 'Выбрать CSV или JSON'}
              <input
                type="file"
                accept=".csv,.json,application/json,text/csv"
                disabled={isImporting}
                onChange={importSlideCards}
              />
            </label>
          </div>
          <p className="adminHint">
            Обязательные поля: <code>title</code>, <code>lesson</code>, <code>system</code>, <code>organ</code>, <code>stain</code>, <code>source</code>. Поле <code>id</code> необязательно; занятые ID пропускаются.
          </p>
          {importStatus && <p className="adminStatus">{importStatus}</p>}
        </section>
        <section className="adminCard slideFormCard">
          <div className="adminCardHeader">
            <div>
              <h2>{isEditing ? 'Редактировать препарат' : 'Добавить препарат'}</h2>
              {isEditing && (
                <p>
                  Сейчас редактируется карточка: <strong>{editingId}</strong>
                </p>
              )}
            </div>

            {isEditing && (
              <button
                type="button"
                className="adminSecondaryButton"
                onClick={resetForm}
              >
                Отменить
              </button>
            )}
          </div>

          <form onSubmit={submitForm} className="adminForm">
            <label>
              ID препарата
              <input
                value={form.id}
                onChange={(event) => updateField('id', event.target.value)}
                placeholder="Например: infarkt-myokardu"
                disabled={isEditing}
              />
            </label>

            {occupiedSlideId && (
              <p className="adminHint adminWarning">
                ID уже занят препаратом: {occupiedSlideId.title}. Выберите другой
                ID или отредактируйте существующую карточку.
              </p>
            )}

            <label>
              Название
              <input
                required
                value={form.title}
                onChange={(event) => updateField('title', event.target.value)}
                placeholder="Инфаркт миокарда"
              />
            </label>

            <label>
              Занятие
              <input
                required
                value={form.lesson}
                onChange={(event) => updateField('lesson', event.target.value)}
                placeholder="Например: Занятие 1. Сердечно-сосудистая система"
              />
            </label>

            <label>
              Раздел / система
              <input
                required
                value={form.system}
                onChange={(event) => updateField('system', event.target.value)}
                placeholder="Сердечно-сосудистая система"
              />
            </label>

            <label>
              Орган
              <input
                required
                value={form.organ}
                onChange={(event) => updateField('organ', event.target.value)}
                placeholder="Сердце"
              />
            </label>

            <label>
              Окраска
              <input
                required
                value={form.stain}
                onChange={(event) => updateField('stain', event.target.value)}
                placeholder="H&E"
              />
            </label>

            <label>
              Moodle-курсы (ID через запятую; пусто — все курсы)
              <input
                value={(form.courseIds || []).join(', ')}
                onChange={(event) => updateField('courseIds', event.target.value.split(',').map((value) => Number(value.trim())).filter(Number.isInteger))}
                placeholder="1, 2"
              />
            </label>

            <label>
              Moodle-группы (ID через запятую; пусто — все группы курса)
              <input
                value={(form.groupIds || []).join(', ')}
                onChange={(event) => updateField('groupIds', event.target.value.split(',').map((value) => Number(value.trim())).filter(Number.isInteger))}
                placeholder="10, 11"
              />
            </label>

            <label className="adminInlineCheck"><input type="checkbox" checked={form.visibleForStudents !== false} onChange={(event) => updateField('visibleForStudents', event.target.checked)} />Доступен студентам</label>
            <label className="adminInlineCheck"><input type="checkbox" checked={form.visibleForResidents === true} onChange={(event) => updateField('visibleForResidents', event.target.checked)} />Доступен ординаторам (обезличенно)</label>

            <label>
              Описание
              <textarea
                rows="5"
                value={form.description}
                onChange={(event) => updateField('description', event.target.value)}
                placeholder="Краткое учебное описание препарата..."
              />
            </label>

            <div className="slideSignsEditor">
              <div className="adminCardHeader compact">
                <div>
                  <h3>Диагностические признаки</h3>
                  <p>Каждый признак можно связать с прямоугольником или стрелкой на препарате.</p>
                </div>
                <button
                  type="button"
                  className="adminSecondaryButton"
                  onClick={addSlideDiagnosticSign}
                >
                  Добавить признак
                </button>
              </div>

              {form.diagnosticSigns.length > 0 ? (
                <div className="slideSignsList">
                  {form.diagnosticSigns.map((sign, signIndex) => (
                    <div
                      key={`${signIndex}-${sign.text}`}
                      className={signIndex === activeSlideSignIndex ? 'slideSignItem active' : 'slideSignItem'}
                    >
                      <button
                        type="button"
                        className="slideSignSelect"
                        onClick={() => setActiveSlideSignIndex(signIndex)}
                      >
                        Признак {signIndex + 1}
                        {sign.marker ? ` · ${sign.marker.type === 'arrow' ? 'стрелка' : 'область'}` : ''}
                      </button>
                      <input
                        value={sign.text}
                        onChange={(event) =>
                          updateSlideDiagnosticSign(signIndex, { text: event.target.value })
                        }
                        placeholder="Например: демаркационная зона"
                      />
                      <button
                        type="button"
                        className="adminDangerButton"
                        onClick={() => removeSlideDiagnosticSign(signIndex)}
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="adminHint">Добавьте первый диагностический признак.</p>
              )}

              {form.diagnosticSigns[activeSlideSignIndex] && (
                <div className="slideSignMarkerEditor">
                  <div className="regionActions">
                    <button
                      type="button"
                      className="adminSecondaryButton"
                      onClick={() => changeSlideSignMarkerType(activeSlideSignIndex, 'rect')}
                    >
                      Прямоугольник
                    </button>
                    <button
                      type="button"
                      className="adminSecondaryButton"
                      onClick={() => changeSlideSignMarkerType(activeSlideSignIndex, 'arrow')}
                    >
                      Стрелка
                    </button>
                    <button
                      type="button"
                      className="adminSecondaryButton"
                      disabled={!form.diagnosticSigns[activeSlideSignIndex].marker}
                      onClick={() => updateSlideDiagnosticSign(activeSlideSignIndex, { marker: null })}
                    >
                      Очистить отметку
                    </button>
                  </div>

                  {form.source ? (
                    <HighlightPicker
                      slide={{ source: form.source }}
                      highlight={form.diagnosticSigns[activeSlideSignIndex].marker}
                      markerType={form.diagnosticSigns[activeSlideSignIndex].marker?.type || 'rect'}
                      onChange={(marker) =>
                        updateSlideDiagnosticSign(activeSlideSignIndex, {
                          marker: {
                            type: marker.type || 'rect',
                            ...marker,
                          },
                        })
                      }
                    />
                  ) : (
                    <div className="highlightEmptyPreview">
                      Укажите DZI-адрес или сохраните препарат с файлом, чтобы отметить признак.
                    </div>
                  )}
                </div>
              )}
            </div>

            <label>
              Вопросы для самопроверки
              <textarea
                rows="6"
                value={form.selfCheckQuestions}
                onChange={(event) =>
                  updateField('selfCheckQuestions', event.target.value)
                }
                placeholder={
                  'Каждый вопрос с новой строки\nКакой орган представлен на препарате?\nКакой патологический процесс изображён?\nКакие признаки подтверждают диагноз?'
                }
              />
            </label>

            <label>
              Готовый DZI-адрес
              <input
                required={!file}
                value={form.source}
                onChange={(event) => updateField('source', event.target.value)}
                placeholder="/slides/infarkt-myokardu.dzi"
              />
            </label>

            <label>
              Файл препарата: SVS / TIFF / NDPI / SCN / KFB / MRXS ZIP / DZI ZIP
              <input
                id="slideFile"
                type="file"
                accept=".svs,.tif,.tiff,.ndpi,.scn,.kfb,.mrxs,.zip"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </label>

            {isEditing && (
              <p className="adminHint">
                Если выбрать новый файл, старый DZI-препарат будет перезаписан
                для этого ID. Для MRXS загружайте ZIP-архив, внутри которого есть
                файл .mrxs и связанная папка данных. Для готовых тайлов можно
                загрузить ZIP-архив с .dzi и папкой *_files.
              </p>
            )}

            <p className="adminHint">
              KFB зависит от серверного конвертера: если libvips/OpenSlide не
              распознает файл, экспортируйте препарат в DZI, TIFF или SVS.
            </p>

            <button disabled={isLoading} type="submit" className="adminPrimarySubmit">
              {isLoading
                ? 'Обработка...'
                : isEditing
                  ? 'Сохранить изменения'
                  : 'Добавить препарат'}
            </button>

            {status && (
              <div className="adminStatus">
                <p>{status}</p>

                {jobProgress !== null && (
                  <div className="adminProgress" aria-label="Прогресс обработки">
                    <div
                      className="adminProgressBar"
                      style={{ width: `${Math.max(0, Math.min(100, jobProgress))}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </form>
        </section>

        <section className="adminCard slideListCard">
          <h2>Список препаратов</h2>
          <div className="adminListToolbar">
            <input
              type="search"
              value={slideListSearch}
              onChange={(event) => setSlideListSearch(event.target.value)}
              placeholder="Поиск по названию, занятию, органу, разделу..."
            />
            <select
              value={slideSystemFilter}
              onChange={(event) => setSlideSystemFilter(event.target.value)}
              aria-label="Фильтр по разделу"
            >
              <option value="all">Все разделы</option>
              {slideSystemOptions.map((system) => (
                <option key={system} value={system}>
                  {system}
                </option>
              ))}
            </select>
            <select
              value={slideOrganFilter}
              onChange={(event) => setSlideOrganFilter(event.target.value)}
              aria-label="Фильтр по органу"
            >
              <option value="all">Все органы</option>
              {slideOrganOptions.map((organ) => (
                <option key={organ} value={organ}>
                  {organ}
                </option>
              ))}
            </select>
            <select
              value={slideStatusFilter}
              onChange={(event) => setSlideStatusFilter(event.target.value)}
              aria-label="Фильтр по состоянию файла"
            >
              <option value="all">Все файлы</option>
              <option value="ready">Готовые</option>
              <option value="missing">Нет файла</option>
              <option value="invalid">Поврежденные</option>
              <option value="external">Внешние</option>
            </select>
            <select
              value={slideSort}
              onChange={(event) => setSlideSort(event.target.value)}
              aria-label="Сортировка препаратов"
            >
              <option value="title">По названию</option>
              <option value="id">По ID</option>
              <option value="organ">По органу</option>
              <option value="status">По статусу файла</option>
            </select>
            <button
              type="button"
              className="adminSecondaryButton"
              onClick={() => {
                setSlideListSearch('');
                setSlideSystemFilter('all');
                setSlideOrganFilter('all');
                setSlideStatusFilter('all');
                setSlideSort('title');
              }}
            >
              Сбросить
            </button>
            <span>
              Показано: {filteredAdminSlides.length} из {slides.length}
            </span>
          </div>

          <div className="adminSlideList">
            {filteredAdminSlides.map((slide) => (
              <div key={slide.id} className="adminSlideItem">
                <div>
                  <strong>{slide.title}</strong>
                  <code className="adminSlideId">ID: {slide.id}</code>
                  <div className="adminSlideStatusRow">
                    <span className={`adminSlideStatus ${getSlideStatusClass(slide.fileStatus?.status)}`}>
                      {slide.fileStatus?.label || 'Статус неизвестен'}
                    </span>
                    {slide.fileStatus?.details && (
                      <small>{slide.fileStatus.details}</small>
                    )}
                  </div>
                  <span>
                    {slide.lesson ? `${slide.lesson} · ` : ''}
                    {slide.system || 'Без раздела'} ·{' '}
                    {slide.organ || 'Орган не указан'} ·{' '}
                    {slide.stain || 'Окраска не указана'}
                  </span>
                  {previewSlideId === slide.id && (
                    <SlideMiniPreview source={slide.source} />
                  )}
                </div>

                <div className="adminSlideActions">
                  <button
                    type="button"
                    className="adminSecondaryButton"
                    disabled={!slide.fileStatus?.previewable}
                    onClick={() =>
                      setPreviewSlideId((current) => (current === slide.id ? '' : slide.id))
                    }
                  >
                    {previewSlideId === slide.id ? 'Скрыть' : 'Просмотр'}
                  </button>

                  <button
                    type="button"
                    className="adminSecondaryButton"
                    onClick={() => startEdit(slide)}
                  >
                    Редактировать
                  </button>

                  <button
                    type="button"
                    className="adminDangerButton"
                    onClick={() => deleteSlide(slide.id)}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ))}

            {slides.length === 0 && <p className="adminHint">Пока препараты не добавлены.</p>}
            {slides.length > 0 && filteredAdminSlides.length === 0 && (
              <p className="adminHint">По этому запросу препараты не найдены.</p>
            )}
          </div>
        </section>
        </>
        )}

        {activeAdminTab === 'diagnostics' && (
        <>
        <section className="adminCard diagnosticsEditor">
          <div className="adminCardHeader">
            <div>
              <h2>{isEditingDiagnostic ? 'Редактировать диагностику' : 'Создать диагностику'}</h2>
              <p>Вопросы, варианты ответов, время доступа и область выделения на препарате.</p>
            </div>

            {isEditingDiagnostic && (
              <button
                type="button"
                className="adminSecondaryButton"
                onClick={resetDiagnosticForm}
              >
                Отменить
              </button>
            )}
          </div>

          <form className="adminForm diagnosticAdminForm" onSubmit={submitDiagnosticForm}>
            <div className="diagnosticDraftBar">
              <span>{draftStatus || 'Черновик диагностики автосохраняется в браузере'}</span>
              <button
                type="button"
                className="adminSecondaryButton"
                disabled={!hasDiagnosticDraft}
                onClick={restoreDiagnosticDraft}
              >
                Восстановить черновик
              </button>
            </div>

            <div className="adminGridTwo">
              <label>
                ID диагностики
                <input
                  value={diagnosticForm.id}
                  onChange={(event) => updateDiagnosticField('id', event.target.value)}
                  placeholder="diagnostika-1"
                  disabled={isEditingDiagnostic}
                />
              </label>

              <label>
                Название
                <input
                  required
                  value={diagnosticForm.title}
                  onChange={(event) => updateDiagnosticField('title', event.target.value)}
                  placeholder="Диагностика по патологии сердца"
                />
              </label>

              <label>
                Открыть с
                <input
                  type="datetime-local"
                  value={diagnosticForm.startsAt}
                  onChange={(event) => updateDiagnosticField('startsAt', event.target.value)}
                />
              </label>

              <label>
                Закрыть после
                <input
                  type="datetime-local"
                  value={diagnosticForm.endsAt}
                  onChange={(event) => updateDiagnosticField('endsAt', event.target.value)}
                />
              </label>

              <label>
                Время на выполнение, мин
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={diagnosticForm.durationMinutes}
                  onChange={(event) => updateDiagnosticField('durationMinutes', event.target.value)}
                  placeholder="Например: 20"
                />
              </label>
              <label>
                Moodle-курсы (ID через запятую)
                <input value={(diagnosticForm.courseIds || []).join(', ')} onChange={(event) => updateDiagnosticField('courseIds', event.target.value.split(',').map((value) => Number(value.trim())).filter(Number.isInteger))} placeholder="Пусто — все" />
              </label>
              <label>
                Moodle-группы (ID через запятую)
                <input value={(diagnosticForm.groupIds || []).join(', ')} onChange={(event) => updateDiagnosticField('groupIds', event.target.value.split(',').map((value) => Number(value.trim())).filter(Number.isInteger))} placeholder="Пусто — все" />
              </label>
            </div>

            <label className="adminInlineCheck">
              <input
                type="checkbox"
                checked={diagnosticForm.isPublished}
                onChange={(event) => updateDiagnosticField('isPublished', event.target.checked)}
              />
              Опубликована
            </label>

            {publicationWarnings.length > 0 && (
              <div className={isPublishedWithWarnings ? 'validationPanel blocking' : 'validationPanel'}>
                <strong>
                  {isPublishedWithWarnings
                    ? 'Перед публикацией исправьте ошибки'
                    : 'Предупреждения черновика'}
                </strong>
                <ul>
                  {publicationWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="diagnosticQuestionsTabs">
              {diagnosticForm.questions.map((question, index) => (
                <button
                  type="button"
                  key={question.id}
                  className={index === activeDiagnosticQuestionIndex ? 'active' : ''}
                  onClick={() => setActiveDiagnosticQuestionIndex(index)}
                >
                  {index + 1}
                </button>
              ))}

              <button type="button" className="addQuestionButton" onClick={addDiagnosticQuestion}>
                + вопрос
              </button>
            </div>

            {activeDiagnosticQuestion ? (
              <div className="diagnosticQuestionEditor">
                <div className="adminGridTwo">
                  <label>
                    Препарат
                    <div className="slideSearchControl">
                      <input
                        type="search"
                        value={diagnosticSlideSearch}
                        onChange={(event) => setDiagnosticSlideSearch(event.target.value)}
                        placeholder="Поиск по названию, органу, разделу, окраске или ID"
                      />
                      <select
                        value={activeDiagnosticQuestion.slideId}
                        onChange={(event) =>
                          updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                            slideId: event.target.value,
                          })
                        }
                      >
                        {diagnosticSlideOptions.map((slide) => (
                          <option key={slide.id} value={slide.id}>
                            {slide.title} · {slide.organ || 'Орган не указан'} · {slide.id}
                          </option>
                        ))}
                      </select>
                      <span className="slideSearchMeta">
                        Найдено: {filteredDiagnosticSlides.length} из {slides.length}
                      </span>
                    </div>
                  </label>

                  <label>
                    Тип вопроса
                    <select
                      value={activeDiagnosticQuestion.type || 'single'}
                      onChange={(event) =>
                        updateQuestionType(activeDiagnosticQuestionIndex, event.target.value)
                      }
                    >
                      <option value="single">Один вариант</option>
                      <option value="multiple">Несколько вариантов</option>
                      <option value="text">Открытый ответ</option>
                      <option value="number">Числовой ответ</option>
                      <option value="matching">Сопоставление</option>
                      <option value="ordering">Упорядочивание</option>
                      <option value="region">Выбор области</option>
                      <option value="combined">Комбинированный</option>
                    </select>
                  </label>
                </div>

                <label>
                  Вопрос
                  <textarea
                    required
                    rows="3"
                    value={activeDiagnosticQuestion.prompt}
                    onChange={(event) =>
                      updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                        prompt: event.target.value,
                      })
                    }
                    placeholder="Какая структура выделена на препарате?"
                  />
                </label>

                {['single', 'multiple', 'combined'].includes(activeDiagnosticQuestion.type || 'single') ? (
                  <>
                    <div className="diagnosticOptionsEditor">
                      {normalizeAdminQuestion(activeDiagnosticQuestion).answer.options.map((option, index) => (
                        <div key={option.id || index} className="optionEditorRow">
                          <label>
                            Вариант {String.fromCharCode(65 + index)}
                            <input
                              value={option.text}
                              onChange={(event) =>
                                updateQuestionOption(activeDiagnosticQuestionIndex, index, event.target.value)
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="adminSecondaryButton"
                            disabled={normalizeAdminQuestion(activeDiagnosticQuestion).answer.options.length <= 2}
                            onClick={() => removeQuestionOption(activeDiagnosticQuestionIndex, index)}
                          >
                            Удалить
                          </button>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      className="adminSecondaryButton"
                      onClick={() => addQuestionOption(activeDiagnosticQuestionIndex)}
                    >
                      Добавить вариант ответа
                    </button>

                    {(activeDiagnosticQuestion.type || 'single') === 'multiple' ? (
                      <div className="correctAnswersEditor">
                        <h3>Правильные варианты</h3>
                        {normalizeAdminQuestion(activeDiagnosticQuestion).answer.options.map((option, index) => (
                          <label key={`${option.id}-${index}`} className="adminInlineCheck">
                            <input
                              type="checkbox"
                              checked={Boolean(option.isCorrect)}
                              onChange={() => toggleCorrectIndex(activeDiagnosticQuestionIndex, index)}
                            />
                            {String.fromCharCode(65 + index)}. {option.text || 'Без текста'}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <label>
                        Правильный ответ
                        <select
                          value={activeDiagnosticQuestion.correctIndex}
                          onChange={(event) =>
                            {
                              const selectedIndex = Number(event.target.value);
                              const normalizedQuestion = normalizeAdminQuestion(activeDiagnosticQuestion);
                              const nextOptions = normalizedQuestion.answer.options.map((option, index) => ({
                                ...option,
                                isCorrect: index === selectedIndex,
                              }));

                              updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                                answer: {
                                  ...normalizedQuestion.answer,
                                  options: nextOptions,
                                },
                                correctIndex: selectedIndex,
                                correctIndices: [selectedIndex],
                              });
                            }
                          }
                        >
                          {normalizeAdminQuestion(activeDiagnosticQuestion).answer.options.map((option, index) => (
                            <option key={`${option.id}-${index}`} value={index}>
                              {String.fromCharCode(65 + index)}. {option.text || 'Без текста'}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                ) : (activeDiagnosticQuestion.type || 'single') === 'text' ? (
                  <label>
                    Правильный открытый ответ
                    <input
                      value={activeDiagnosticQuestion.correctText || ''}
                      onChange={(event) =>
                        updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                          answer: {
                            ...normalizeAdminQuestion(activeDiagnosticQuestion).answer,
                            correctText: event.target.value,
                          },
                          correctText: event.target.value,
                        })
                      }
                      placeholder="Например: демаркационная зона"
                    />
                  </label>
                ) : null}

                {(activeDiagnosticQuestion.type || 'single') === 'combined' && (
                  <label>
                    Правильный открытый ответ
                    <input
                      value={normalizeAdminQuestion(activeDiagnosticQuestion).answer.correctText || ''}
                      onChange={(event) =>
                        updateQuestionAnswer(activeDiagnosticQuestionIndex, {
                          correctText: event.target.value,
                        })
                      }
                      placeholder="Например: демаркационная зона"
                    />
                  </label>
                )}

                {(activeDiagnosticQuestion.type || 'single') === 'number' && (
                  <div className="answerConfigGrid">
                    <label>
                      Точное значение
                      <input
                        type="number"
                        value={normalizeAdminQuestion(activeDiagnosticQuestion).answer.numeric.correctValue}
                        onChange={(event) => {
                          const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                          updateQuestionAnswer(activeDiagnosticQuestionIndex, {
                            numeric: {
                              ...question.answer.numeric,
                              correctValue: event.target.value,
                            },
                          });
                        }}
                      />
                    </label>
                    <label>
                      Допуск
                      <input
                        type="number"
                        value={normalizeAdminQuestion(activeDiagnosticQuestion).answer.numeric.tolerance}
                        onChange={(event) => {
                          const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                          updateQuestionAnswer(activeDiagnosticQuestionIndex, {
                            numeric: {
                              ...question.answer.numeric,
                              tolerance: event.target.value,
                            },
                          });
                        }}
                      />
                    </label>
                    <label>
                      Диапазон от
                      <input
                        type="number"
                        value={normalizeAdminQuestion(activeDiagnosticQuestion).answer.numeric.min}
                        onChange={(event) => {
                          const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                          updateQuestionAnswer(activeDiagnosticQuestionIndex, {
                            numeric: {
                              ...question.answer.numeric,
                              min: event.target.value,
                            },
                          });
                        }}
                      />
                    </label>
                    <label>
                      Диапазон до
                      <input
                        type="number"
                        value={normalizeAdminQuestion(activeDiagnosticQuestion).answer.numeric.max}
                        onChange={(event) => {
                          const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                          updateQuestionAnswer(activeDiagnosticQuestionIndex, {
                            numeric: {
                              ...question.answer.numeric,
                              max: event.target.value,
                            },
                          });
                        }}
                      />
                    </label>
                  </div>
                )}

                {(activeDiagnosticQuestion.type || 'single') === 'matching' && (
                  <div className="structuredAnswerEditor">
                    <h3>Пары сопоставления</h3>
                    {normalizeAdminQuestion(activeDiagnosticQuestion).answer.pairs.map((pair, index) => (
                      <div key={pair.id} className="matchingPairRow">
                        <input
                          value={pair.left}
                          onChange={(event) => {
                            const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                            const pairs = question.answer.pairs.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, left: event.target.value } : item
                            );
                            updateQuestionAnswer(activeDiagnosticQuestionIndex, { pairs });
                          }}
                          placeholder="Левая часть"
                        />
                        <input
                          value={pair.right}
                          onChange={(event) => {
                            const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                            const pairs = question.answer.pairs.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, right: event.target.value } : item
                            );
                            updateQuestionAnswer(activeDiagnosticQuestionIndex, { pairs });
                          }}
                          placeholder="Правая часть"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {(activeDiagnosticQuestion.type || 'single') === 'ordering' && (
                  <div className="structuredAnswerEditor">
                    <h3>Правильный порядок</h3>
                    {normalizeAdminQuestion(activeDiagnosticQuestion).answer.items.map((item, index) => (
                      <label key={item.id}>
                        Позиция {index + 1}
                        <input
                          value={item.text}
                          onChange={(event) => {
                            const question = normalizeAdminQuestion(activeDiagnosticQuestion);
                            const items = question.answer.items.map((currentItem, itemIndex) =>
                              itemIndex === index ? { ...currentItem, text: event.target.value } : currentItem
                            );
                            updateQuestionAnswer(activeDiagnosticQuestionIndex, { items });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}

                <div className="questionSettingsGrid">
                  <label className="adminInlineCheck">
                    <input
                      type="checkbox"
                      checked={normalizeAdminQuestion(activeDiagnosticQuestion).answer.shuffle}
                      disabled={(activeDiagnosticQuestion.type || 'single') === 'text'}
                      onChange={(event) => {
                        const normalizedQuestion = normalizeAdminQuestion(activeDiagnosticQuestion);

                        updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                          answer: {
                            ...normalizedQuestion.answer,
                            shuffle: event.target.checked,
                          },
                        });
                      }}
                    />
                    Перемешивать варианты
                  </label>

                  <label>
                    Баллы за вопрос
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={normalizeAdminQuestion(activeDiagnosticQuestion).grading.points}
                      onChange={(event) => {
                        const normalizedQuestion = normalizeAdminQuestion(activeDiagnosticQuestion);

                        updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                          grading: {
                            ...normalizedQuestion.grading,
                            points: Number(event.target.value),
                          },
                        });
                      }}
                    />
                  </label>

                  {(activeDiagnosticQuestion.type || 'single') === 'region' && (
                    <label>
                      Минимум перекрытия ответа, %
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        value={normalizeAdminQuestion(activeDiagnosticQuestion).grading.regionThreshold}
                        onChange={(event) => {
                          const normalizedQuestion = normalizeAdminQuestion(activeDiagnosticQuestion);

                          updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                            grading: {
                              ...normalizedQuestion.grading,
                              regionThreshold: Number(event.target.value),
                            },
                          });
                        }}
                      />
                    </label>
                  )}
                </div>

                <div className="highlightEditor">
                  <div>
                    <h3>Выделение</h3>
                    <p>Для вопроса с выбором области можно добавить несколько правильных областей. Ответ студента засчитывается, если его выделение достаточно перекрывается с любой из них.</p>
                    <div className="regionTabs">
                      {normalizeAdminQuestion(activeDiagnosticQuestion).regions.length > 0 ? (
                        normalizeAdminQuestion(activeDiagnosticQuestion).regions.map((region, regionIndex) => (
                          <button
                            type="button"
                            key={`${regionIndex}-${region.type}-${region.x ?? region.x1}-${region.y ?? region.y1}`}
                            className={regionIndex === activeRegionIndex ? 'active' : ''}
                            onClick={() => setActiveRegionIndex(regionIndex)}
                          >
                            {region.type === 'arrow' ? 'Стрелка' : 'Область'} {regionIndex + 1}
                          </button>
                        ))
                      ) : (
                        <span className="regionEmptyState">Области не заданы</span>
                      )}
                    </div>
                    <p className="regionModeHint">
                      Режим: потяните внутри области для перемещения, за край или угол для изменения размера.
                    </p>
                    <div className="regionActions highlightRegionActions" aria-label="Действия с областью">
                      <button
                        type="button"
                        className="adminSecondaryButton iconTooltipButton"
                        aria-label="Добавить область"
                        data-tooltip="Добавить область"
                        onClick={() => addQuestionRegion(activeDiagnosticQuestionIndex)}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="adminSecondaryButton iconTooltipButton"
                        aria-label="Прямоугольник"
                        data-tooltip="Прямоугольник"
                        disabled={!normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex]}
                        onClick={() => changeQuestionRegionType(activeDiagnosticQuestionIndex, activeRegionIndex, 'rect')}
                      >
                        ▭
                      </button>
                      <button
                        type="button"
                        className="adminSecondaryButton iconTooltipButton"
                        aria-label="Стрелка"
                        data-tooltip="Стрелка"
                        disabled={!normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex]}
                        onClick={() => changeQuestionRegionType(activeDiagnosticQuestionIndex, activeRegionIndex, 'arrow')}
                      >
                        ↗
                      </button>
                      <button
                        type="button"
                        className="adminSecondaryButton iconTooltipButton dangerIconButton"
                        aria-label="Удалить область"
                        data-tooltip="Удалить область"
                        disabled={normalizeAdminQuestion(activeDiagnosticQuestion).regions.length === 0}
                        onClick={() => removeQuestionRegion(activeDiagnosticQuestionIndex, activeRegionIndex)}
                      >
                        ×
                      </button>
                    </div>
                    {normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex] ? (
                      <div className="highlightGrid">
                        {(
                          normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex]?.type === 'arrow'
                            ? ['x1', 'y1', 'x2', 'y2']
                            : ['x', 'y', 'width', 'height']
                        ).map((field) => (
                          <label key={field}>
                            {field}
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex]?.[field] ?? 0}
                              onChange={(event) =>
                                updateQuestionHighlight(
                                  activeDiagnosticQuestionIndex,
                                  field,
                                  event.target.value
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="adminHint">Добавьте область, чтобы задать координаты или нарисовать выделение.</p>
                    )}
                  </div>

                  {activeDiagnosticSlide ? (
                    <HighlightPicker
                      slide={activeDiagnosticSlide}
                      highlight={normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex] || null}
                      markerType={normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex]?.type || 'rect'}
                      onChange={(highlight) => {
                        const normalizedQuestion = normalizeAdminQuestion(activeDiagnosticQuestion);

                        if (normalizedQuestion.regions[activeRegionIndex]) {
                          setQuestionRegion(activeDiagnosticQuestionIndex, activeRegionIndex, highlight);
                          return;
                        }

                        updateDiagnosticQuestion(activeDiagnosticQuestionIndex, {
                          highlight: normalizeAdminMarker(highlight),
                          region: normalizeAdminMarker(highlight),
                          regions: [normalizeAdminMarker(highlight)],
                        });
                        setActiveRegionIndex(0);
                      }}
                    />
                  ) : (
                    <div className="highlightEmptyPreview">Выберите препарат</div>
                  )}
                </div>

                <button
                  type="button"
                  className="adminDangerButton"
                  onClick={() => removeDiagnosticQuestion(activeDiagnosticQuestionIndex)}
                >
                  Удалить вопрос
                </button>
              </div>
            ) : (
              <p className="adminHint">Добавьте первый вопрос диагностики.</p>
            )}

            <div className="formActions">
              <button type="submit" disabled={diagnosticForm.questions.length === 0 || isPublishedWithWarnings}>
                {isEditingDiagnostic ? 'Сохранить диагностику' : 'Создать диагностику'}
              </button>
              {isEditingDiagnostic && (
                <a
                  className="adminActionLink"
                  href={`/diagnostics/${editingDiagnosticId}?preview=1`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Предпросмотр как студент
                </a>
              )}
            </div>

            {diagnosticStatus && (
              <div className="adminStatus">
                <p>{diagnosticStatus}</p>
              </div>
            )}
          </form>
        </section>

        <section className="adminCard diagnosticsListCard">
          <h2>Диагностики</h2>
          <div className="adminListToolbar">
            <select
              value={diagnosticStatusFilter}
              onChange={(event) => setDiagnosticStatusFilter(event.target.value)}
            >
              <option value="all">Все статусы</option>
              <option value="open">Опубликованные</option>
              <option value="draft">Черновики</option>
              <option value="scheduled">Запланированные</option>
              <option value="closed">Завершенные</option>
            </select>
            <span>
              Показано: {filteredAdminDiagnostics.length} из {diagnostics.length}
            </span>
          </div>

          <div className="adminSlideList">
            {filteredAdminDiagnostics.map((diagnostic) => (
              <div key={diagnostic.id} className="adminSlideItem diagnosticAdminItem">
                <div>
                  <strong>{diagnostic.title}</strong>
                  <span>
                    {diagnostic.status} · вопросов: {diagnostic.questions?.length || 0} · результатов: {diagnostic.resultCount || 0}
                  </span>
                  <a href={`/diagnostics/${diagnostic.id}`} target="_blank" rel="noreferrer">
                    /diagnostics/{diagnostic.id}
                  </a>
                </div>

                <div className="adminSlideActions">
                  <button
                    type="button"
                    className="adminSecondaryButton"
                    onClick={() => startDiagnosticEdit(diagnostic)}
                  >
                    Редактировать
                  </button>
                  <button
                    type="button"
                    className="adminSecondaryButton"
                    onClick={() => loadDiagnosticResults(diagnostic)}
                  >
                    Результаты
                  </button>
                  <a
                    className="adminActionLink"
                    href={`/diagnostics/${diagnostic.id}?preview=1`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Предпросмотр
                  </a>
                  <a
                    className="adminActionLink"
                    href={`/api/admin/diagnostics/${diagnostic.id}/results.csv`}
                  >
                    CSV
                  </a>
                  <a
                    className="adminActionLink"
                    href={`/api/admin/diagnostics/${diagnostic.id}/report.html`}
                  >
                    Отчет
                  </a>
                  <button
                    type="button"
                    className="adminDangerButton"
                    onClick={() => deleteDiagnostic(diagnostic.id)}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ))}

            {diagnostics.length === 0 && <p className="adminHint">Диагностики пока не созданы.</p>}
            {diagnostics.length > 0 && filteredAdminDiagnostics.length === 0 && (
              <p className="adminHint">Диагностики с выбранным статусом не найдены.</p>
            )}
          </div>
        </section>

        {selectedDiagnosticForResults && (
          <section className="adminCard resultsReviewCard">
            <div className="adminCardHeader">
              <div>
                <h2>Ручная проверка результатов</h2>
                <p>{selectedDiagnosticForResults.title}</p>
              </div>
              <div className="adminSlideActions">
                <a
                  className="adminActionLink"
                  href={`/api/admin/diagnostics/${selectedDiagnosticForResults.id}/report.html`}
                >
                  Подробный отчет
                </a>
                <button
                  type="button"
                  className="adminSecondaryButton"
                  onClick={() => loadDiagnosticResults(selectedDiagnosticForResults)}
                >
                  Обновить
                </button>
              </div>
            </div>

            <div className="resultsReviewLayout">
              <aside className="resultsSidebar">
                <div className="resultsReviewTools">
                  <label>
                    Поиск результата
                    <input
                      value={resultSearch}
                      onChange={(event) => setResultSearch(event.target.value)}
                      placeholder="ФИО или группа"
                    />
                  </label>
                  <div className="resultFilterTabs" aria-label="Фильтр результатов">
                    <button
                      type="button"
                      className={resultReviewFilter === 'all' ? 'active' : ''}
                      onClick={() => setResultReviewFilter('all')}
                    >
                      Все <span>{resultReviewStats.all}</span>
                    </button>
                    <button
                      type="button"
                      className={resultReviewFilter === 'needs-review' ? 'active' : ''}
                      onClick={() => setResultReviewFilter('needs-review')}
                    >
                      На проверку <span>{resultReviewStats['needs-review']}</span>
                    </button>
                    <button
                      type="button"
                      className={resultReviewFilter === 'reviewed' ? 'active' : ''}
                      onClick={() => setResultReviewFilter('reviewed')}
                    >
                      Проверены <span>{resultReviewStats.reviewed}</span>
                    </button>
                  </div>
                </div>

                <div className="resultsList">
                {filteredDiagnosticResults.map((result) => (
                  <button
                    type="button"
                    key={result.id}
                    className={selectedResult?.id === result.id ? 'active' : ''}
                    onClick={() => setSelectedResult(result)}
                  >
                    <strong>{result.studentName}</strong>
                    <span>{result.group} · {result.score} / {result.total} · {result.percent}%</span>
                    {getResultReviewState(result) === 'needs-review' && (
                      <em>Требует ручной проверки</em>
                    )}
                    {getResultReviewState(result) === 'reviewed' && (
                      <em>Проверено</em>
                    )}
                  </button>
                ))}
                {diagnosticResults.length === 0 && <p className="adminHint">Результатов пока нет.</p>}
                {diagnosticResults.length > 0 && filteredDiagnosticResults.length === 0 && (
                  <p className="adminHint">По выбранному фильтру результатов нет.</p>
                )}
                </div>
              </aside>

              {selectedResult ? (
                <div className="resultReviewPanel">
                  <div className="resultReviewHeader">
                    <div>
                      <h3>{selectedResult.studentName}</h3>
                      <p>{selectedResult.group} · {selectedResult.submittedAt}</p>
                    </div>
                    <strong>{selectedResult.score} / {selectedResult.total} ({selectedResult.percent}%)</strong>
                  </div>

                  {(selectedResult.answers || []).map((answer, index) => {
                    const reviewQuestion = reviewQuestionById.get(answer.questionId);
                    const reviewSlide = slideById.get(reviewQuestion?.slideId);

                    return (
                      <div key={answer.questionId} className="answerReviewItem">
                        <div>
                          <strong>Вопрос {index + 1}</strong>
                          <span>{answer.type} · авто: {answer.isCorrect ? 'верно' : 'не верно'}</span>
                        </div>
                        <p>Ответ: {formatReviewAnswer(answer)}</p>
                        {(answer.correctOptions?.length > 0 || answer.correctText || answer.correctOption) && (
                          <p>Эталон: {answer.correctOptions?.join('; ') || answer.correctText || answer.correctOption}</p>
                        )}
                        {answer.type === 'region' && (
                          <RegionReviewPreview
                            answer={answer}
                            question={reviewQuestion}
                            slide={reviewSlide}
                          />
                        )}
                        <div className="reviewControls">
                          <label>
                            Баллы
                            <input
                              type="number"
                              min="0"
                              max={answer.points}
                              step="0.1"
                              value={answer.earnedPoints ?? 0}
                              onChange={(event) =>
                                updateSelectedAnswerReview(answer.questionId, {
                                  earnedPoints: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Комментарий
                            <input
                              value={answer.reviewComment || ''}
                              onChange={(event) =>
                                updateSelectedAnswerReview(answer.questionId, {
                                  reviewComment: event.target.value,
                                })
                              }
                              placeholder="Комментарий преподавателя"
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}

                  <label className="diagnosticTextAnswer">
                    Общий комментарий
                    <textarea
                      rows="3"
                      value={selectedResult.reviewComment || ''}
                      onChange={(event) =>
                        setSelectedResult((current) => ({
                          ...current,
                          reviewComment: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <button type="button" className="adminPrimarySubmit" onClick={saveResultReview}>
                    Сохранить проверку
                  </button>
                </div>
              ) : (
                <p className="adminHint">Выберите результат для проверки.</p>
              )}
            </div>

            {resultsStatus && (
              <div className="adminStatus">
                <p>{resultsStatus}</p>
              </div>
            )}
          </section>
        )}
        </>
        )}
        {role === 'admin' && activeAdminTab === 'teachers' && (
          <section className="admin-users-page">
            <div className="admin-page-header">
              <div>
                <h2>Пользователи</h2>
                <p>Локальные пользователи, роли и индивидуальные права доступа.</p>
              </div>
              <button type="button" className="adminPrimarySubmit primary-action" onClick={resetUserForm}>
                Создать пользователя
              </button>
            </div>

            {usersStatus && <p className="adminStatus users-status">{usersStatus}</p>}

            <div className="admin-users-grid">
              <form className="adminCard adminForm user-form-card" onSubmit={saveUser}>
                <div className="adminCardHeader compact">
                  <div>
                    <h3>{userForm.id ? 'Редактирование пользователя' : 'Новый пользователь'}</h3>
                    <p>{userForm.id ? 'Пароль можно оставить пустым, если он не меняется.' : 'Заполните учетные данные и назначьте роль.'}</p>
                  </div>
                </div>

                <div className="form-grid">
                  <label>
                    <span>Логин</span>
                    <input value={userForm.login} onChange={(event) => updateUserForm('login', event.target.value)} placeholder="ivanov" required disabled={Boolean(userForm.id)} />
                  </label>
                  <label>
                    <span>ФИО</span>
                    <input value={userForm.fullName} onChange={(event) => updateUserForm('fullName', event.target.value)} placeholder="Иванов Иван Иванович" required />
                  </label>
                  <label>
                    <span>Email</span>
                    <input type="email" value={userForm.email} onChange={(event) => updateUserForm('email', event.target.value)} placeholder="teacher@example.edu" />
                  </label>
                  <label>
                    <span>Роль</span>
                    <select value={userForm.role} onChange={(event) => updateUserForm('role', event.target.value)}>
                      {USER_ROLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{ROLE_LABELS[option]}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Пароль</span>
                    <input
                      type="password"
                      value={userForm.password}
                      onChange={(event) => updateUserForm('password', event.target.value)}
                      minLength="8"
                      required={!userForm.id}
                      placeholder={userForm.id ? 'Оставьте пустым без изменений' : 'Минимум 8 символов'}
                    />
                  </label>
                  <label className="status-toggle">
                    <input type="checkbox" checked={userForm.isActive} onChange={(event) => updateUserForm('isActive', event.target.checked)} />
                    <span className="status-toggle-control" aria-hidden="true" />
                    <span>
                      <strong>Активен</strong>
                      <small>Пользователь может входить в систему</small>
                    </span>
                  </label>
                </div>

                <div className="adminFormActions user-form-actions">
                  <button type="submit" className="adminPrimarySubmit" disabled={!canSubmitUserForm}>
                    {userForm.id ? 'Сохранить изменения' : 'Создать пользователя'}
                  </button>
                  <button type="button" className="adminSecondaryButton" onClick={resetUserForm}>Очистить форму</button>
                </div>
              </form>

              <aside className="adminCard role-info-card">
                <span className="role-badge">{ROLE_LABELS[userForm.role] || userForm.role}</span>
                <h3>{ROLE_LABELS[userForm.role] || 'Роль'}</h3>
                <p>{ROLE_DESCRIPTIONS[userForm.role] || 'Описание роли не задано.'}</p>
                <div className="role-permission-summary">
                  <strong>{enabledUserFormPermissions}</strong>
                  <span>прав включено</span>
                </div>
              </aside>
            </div>

            <div className="adminCard permissions-card">
              <div className="adminCardHeader compact permissions-header">
                <div>
                  <h3>Права доступа</h3>
                  <p>Индивидуальные права могут отличаться от стандартных прав выбранной роли.</p>
                </div>
                <div className="permissions-toolbar">
                  <span>{enabledUserFormPermissions} из {PERMISSION_KEYS.length} включено</span>
                  <button type="button" className="adminSecondaryButton" onClick={applyRolePermissions}>
                    Применить права по роли
                  </button>
                </div>
              </div>

              <div className="permissions-groups">
                {PERMISSION_GROUPS.map((group) => (
                  <div className="permission-group" key={group.title}>
                    <h4>{group.title}</h4>
                    {group.permissions.map((permission) => {
                      const enabled = getUserFormPermission(permission);
                      const isCustom = Object.hasOwn(userForm.permissionOverrides || {}, permission);

                      return (
                        <label className={`permission-toggle ${enabled ? 'enabled' : ''}`} key={permission}>
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={() => toggleUserPermission(permission)}
                          />
                          <span className="permission-switch" aria-hidden="true" />
                          <span className="permission-toggle-box">
                            <span className="permission-title">{PERMISSION_LABELS[permission]}</span>
                            <span className="permission-status">{enabled ? 'Включено' : 'Выключено'}{isCustom ? ' · индивидуально' : ''}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>

              {changedUserFormPermissions > 0 && (
                <p className="adminHint permissions-note">Индивидуально изменено прав: {changedUserFormPermissions}.</p>
              )}
            </div>

            <div className="adminCard users-list-card">
              <div className="adminCardHeader compact users-list-header">
                <div>
                  <h3>Созданные пользователи</h3>
                  <p>Редактируйте роли, статус, пароль и индивидуальные права доступа.</p>
                </div>
                <span>{users.length} всего</span>
              </div>

              {users.length === 0 ? (
                <div className="users-empty-state">
                  <h3>Пользователи пока не созданы</h3>
                  <p>Добавьте преподавателя, ординатора или студента, чтобы управлять доступом к атласу.</p>
                  <button type="button" className="adminPrimarySubmit" onClick={resetUserForm}>Создать первого пользователя</button>
                </div>
              ) : (
                <div className="users-table-wrap">
                  <table className="users-table">
                    <thead>
                      <tr>
                        <th>Пользователь</th>
                        <th>Email</th>
                        <th>Роль</th>
                        <th>Статус</th>
                        <th>Права</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <strong>{user.fullName || user.name || user.login}</strong>
                            <span>{user.login}</span>
                            <small>Создан: {user.createdAt ? new Date(user.createdAt).toLocaleString('ru-RU') : 'нет данных'}</small>
                          </td>
                          <td>{user.email || 'email не указан'}</td>
                          <td><span className="role-badge">{ROLE_LABELS[user.role] || user.role}</span></td>
                          <td><span className={`status-badge ${user.isActive ? 'active' : 'blocked'}`}>{user.isActive ? 'Активен' : 'Заблокирован'}</span></td>
                          <td>
                            <span className="permission-count">{countEnabledPermissions(user.permissions)} включено</span>
                            <small>Последний вход: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('ru-RU') : 'нет данных'}</small>
                          </td>
                          <td>
                            <div className="users-table-actions">
                              <button type="button" className="adminSecondaryButton" onClick={() => editUser(user)}>Редактировать</button>
                              <button type="button" className="adminSecondaryButton" onClick={() => changeUserPassword(user)}>Сменить пароль</button>
                              <button type="button" className="adminSecondaryButton" onClick={() => toggleUserStatus(user)}>{user.isActive ? 'Заблокировать' : 'Активировать'}</button>
                              <button type="button" className="adminDangerButton" onClick={() => deleteUser(user)}>Удалить</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {role === 'admin' && activeAdminTab === 'backups' && (
          <section className="adminCard backupsCard">
            <div className="adminCardHeader">
              <div>
                <h2>Резервные копии</h2>
                <p>Снимки включают карточки препаратов, диагностики и результаты.</p>
              </div>

              <button
                type="button"
                className="adminPrimarySubmit"
                disabled={isBackupBusy}
                onClick={createBackup}
              >
                {isBackupBusy ? 'Обработка...' : 'Создать backup'}
              </button>
            </div>

            {backupStatus && (
              <div className="adminStatus">
                <p>{backupStatus}</p>
              </div>
            )}

            <div className="backupList">
              {backups.map((backup) => (
                <div key={backup.fileName} className="backupItem">
                  <div>
                    <strong>{backup.fileName}</strong>
                    <span>
                      {formatBackupDate(backup.createdAt)} · {formatFileSize(backup.sizeBytes)}
                    </span>
                    {backup.counts && (
                      <small>
                        Препараты: {backup.counts.slides || 0} · диагностики:{' '}
                        {backup.counts.diagnostics || 0} · результаты:{' '}
                        {backup.counts.diagnostic_results || 0}
                      </small>
                    )}
                    {!backup.restorable && (
                      <small>Доступно только скачивание старого backup-файла.</small>
                    )}
                  </div>

                  <div className="backupActions">
                    <a
                      className="adminSecondaryButton"
                      href={`/api/admin/backups/${encodeURIComponent(backup.fileName)}`}
                    >
                      Скачать
                    </a>
                    <button
                      type="button"
                      className="adminDangerButton"
                      disabled={!backup.restorable || isBackupBusy}
                      onClick={() => restoreBackup(backup)}
                    >
                      Восстановить
                    </button>
                  </div>
                </div>
              ))}

              {backups.length === 0 && (
                <p className="adminHint">Резервные копии пока не созданы.</p>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default AdminLoginGate;
