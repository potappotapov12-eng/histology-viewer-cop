import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const AdminPage = lazy(() => import('./AdminPage'));

const ALL_ORGANS_OPTION = 'Все';
const ALL_LESSONS_OPTION = 'Все занятия';
const ALL_SYSTEMS_OPTION = 'Все разделы';
const ALL_STAINS_OPTION = 'Все окраски';
const NO_LESSON_OPTION = 'Без занятия';
const DEFAULT_SYSTEM = 'Без раздела';

function toSearchText(value) {
  return String(value || '').toLowerCase();
}

function getSlideTitle(slide) {
  return slide?.title || 'Без названия';
}

function getSlideOrgan(slide) {
  return slide?.organ || 'Орган не указан';
}

function getSlideStain(slide) {
  return slide?.stain || 'Окраска не указана';
}

function getSlideSystem(slide) {
  return slide?.system || DEFAULT_SYSTEM;
}

function getSlideLesson(slide) {
  return slide?.lesson || NO_LESSON_OPTION;
}

function normalizeDiagnosticSign(sign) {
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

function createTileSource(source) {
  if (!source) return null;

  return source.endsWith('.dzi')
    ? source
    : {
        type: 'image',
        url: source,
      };
}

function formatTimer(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  return `${minutes}:${String(restSeconds).padStart(2, '0')}`;
}

function getDiagnosticDraftKey(diagnosticId, student) {
  const name = String(student?.studentName || '').trim().toLowerCase();
  const group = String(student?.group || '').trim().toLowerCase();

  if (!diagnosticId || !name || !group) return '';

  return `diagnostic-draft:${diagnosticId}:${name}:${group}`;
}

function getQuestionAnswerStatus(question, answer) {
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

function getResultAnswerStatus(answer) {
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

function getMarkerViewportRect(viewer, marker) {
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

function addMarkerOverlay(viewer, marker) {
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

function addHighlightOverlay(viewer, highlight) {
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

function addSelectedRegionOverlay(viewer, region) {
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

function getViewerImagePercentPoint(viewer, OpenSeadragon, event) {
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

function buildRegionFromPoints(startPoint, endPoint) {
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

function isPointInsideRegion(point, region) {
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

function moveRegionByDelta(region, deltaX, deltaY) {
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

function SlideViewer({
  source,
  highlight,
  className = 'viewer',
  isRegionAnswerMode = false,
  selectedRegion = null,
  onRegionChange,
}) {
  const elementRef = useRef(null);
  const viewerRef = useRef(null);
  const openSeadragonRef = useRef(null);
  const dragStartRef = useRef(null);
  const regionInteractionRef = useRef(null);
  const highlightOverlayRef = useRef(null);
  const selectedOverlayRef = useRef(null);
  const [isViewerReady, setIsViewerReady] = useState(false);
  const [regionToolMode, setRegionToolMode] = useState('pan');

  useEffect(() => {
    let isCancelled = false;
    const viewerElement = elementRef.current;
    const tileSources = createTileSource(source);

    if (!viewerElement || !tileSources) return undefined;

    viewerRef.current?.destroy();
    highlightOverlayRef.current = null;
    selectedOverlayRef.current = null;
    setIsViewerReady(false);

    import('openseadragon').then(({ default: OpenSeadragon }) => {
      if (isCancelled) return;
      openSeadragonRef.current = OpenSeadragon;

      const viewer = OpenSeadragon({
        element: viewerElement,
        prefixUrl: '/openseadragon/images/',
        tileSources,
        showNavigator: true,
        showRotationControl: true,
        animationTime: 0.5,
        blendTime: 0.1,
        maxZoomPixelRatio: 8,
        visibilityRatio: 1,
        constrainDuringPan: true,
        gestureSettingsMouse: {
          scrollToZoom: true,
          clickToZoom: false,
          dblClickToZoom: true,
        },
        gestureSettingsTouch: {
          pinchToZoom: true,
          flickEnabled: true,
          clickToZoom: false,
          dblClickToZoom: true,
        },
      });

      viewerRef.current = viewer;

      const handleOpen = () => {
        setIsViewerReady(true);
      };

      viewer.addHandler('open', handleOpen);
    });

    return () => {
      isCancelled = true;
      if (highlightOverlayRef.current) {
        viewerRef.current?.removeOverlay(highlightOverlayRef.current);
        highlightOverlayRef.current = null;
      }
      if (selectedOverlayRef.current) {
        viewerRef.current?.removeOverlay(selectedOverlayRef.current);
        selectedOverlayRef.current = null;
      }
      viewerRef.current?.destroy();
      viewerRef.current = null;
      openSeadragonRef.current = null;
      setIsViewerReady(false);
    };
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !isViewerReady) return undefined;

    if (highlightOverlayRef.current) {
      viewer.removeOverlay(highlightOverlayRef.current);
      highlightOverlayRef.current = null;
    }

    if (highlight) {
      highlightOverlayRef.current = addHighlightOverlay(viewer, highlight);
    }

    return () => {
      if (viewerRef.current === viewer && highlightOverlayRef.current) {
        viewer.removeOverlay(highlightOverlayRef.current);
        highlightOverlayRef.current = null;
      }
    };
  }, [highlight, isViewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !isViewerReady) return undefined;

    if (selectedOverlayRef.current) {
      viewer.removeOverlay(selectedOverlayRef.current);
      selectedOverlayRef.current = null;
    }

    if (selectedRegion) {
      selectedOverlayRef.current = addSelectedRegionOverlay(viewer, selectedRegion);
    }

    return () => {
      if (viewerRef.current === viewer && selectedOverlayRef.current) {
        viewer.removeOverlay(selectedOverlayRef.current);
        selectedOverlayRef.current = null;
      }
    };
  }, [selectedRegion, isViewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !isRegionAnswerMode) return;

    viewer.gestureSettingsMouse.dragToPan = regionToolMode === 'pan';
  }, [isRegionAnswerMode, regionToolMode]);

  useEffect(() => {
    if (isRegionAnswerMode) {
      setRegionToolMode('pan');
    }
  }, [isRegionAnswerMode, source]);

  const startRegion = (event) => {
    if (!isRegionAnswerMode || regionToolMode !== 'select') return;
    const point = getViewerImagePercentPoint(
      viewerRef.current,
      openSeadragonRef.current,
      event
    );
    if (!point) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (isPointInsideRegion(point, selectedRegion)) {
      regionInteractionRef.current = {
        type: 'move',
        startPoint: point,
        startRegion: selectedRegion,
      };
      dragStartRef.current = null;
      return;
    }

    regionInteractionRef.current = { type: 'draw' };
    dragStartRef.current = point;
    onRegionChange?.(buildRegionFromPoints(point, point));
  };

  const updateRegion = (event) => {
    const interaction = regionInteractionRef.current;
    if (!isRegionAnswerMode || regionToolMode !== 'select' || !interaction) return;
    const point = getViewerImagePercentPoint(
      viewerRef.current,
      openSeadragonRef.current,
      event
    );
    if (!point) return;

    event.preventDefault();

    if (interaction.type === 'move') {
      onRegionChange?.(
        moveRegionByDelta(
          interaction.startRegion,
          point.x - interaction.startPoint.x,
          point.y - interaction.startPoint.y
        )
      );
      return;
    }

    if (dragStartRef.current) {
      onRegionChange?.(buildRegionFromPoints(dragStartRef.current, point));
    }
  };

  const finishRegion = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    regionInteractionRef.current = null;
  };

  const zoomRegionViewer = (factor) => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    viewer.viewport.zoomBy(factor);
    viewer.viewport.applyConstraints();
  };

  const resetRegionViewer = () => {
    viewerRef.current?.viewport.goHome();
  };

  const handleRegionKeyDown = (event) => {
    if (!isRegionAnswerMode) return;
    const key = event.key.toLowerCase();

    if (key === 'v' || key === 'м') {
      event.preventDefault();
      setRegionToolMode('pan');
    }

    if (key === 'b' || key === 'и') {
      event.preventDefault();
      setRegionToolMode('select');
    }
  };

  return (
    <div
      className={className}
      tabIndex={isRegionAnswerMode ? 0 : undefined}
      onKeyDown={handleRegionKeyDown}
    >
      <div ref={elementRef} className="viewerCanvas" />
      {isRegionAnswerMode && (
        <>
          <div className="regionAnswerControls" aria-label="Управление областью ответа">
            <button
              type="button"
              className={regionToolMode === 'pan' ? 'active' : ''}
              onClick={() => setRegionToolMode('pan')}
              title="Перемещение препарата (V)"
            >
              Перемещение (V)
            </button>
            <button
              type="button"
              className={regionToolMode === 'select' ? 'active' : ''}
              onClick={() => setRegionToolMode('select')}
              title="Рисование области ответа (B)"
            >
              Выделение (B)
            </button>
            <button type="button" onClick={() => zoomRegionViewer(0.7)} aria-label="Уменьшить масштаб">
              −
            </button>
            <button type="button" onClick={resetRegionViewer}>
              Общий вид
            </button>
            <button type="button" onClick={() => zoomRegionViewer(1.35)} aria-label="Увеличить масштаб">
              +
            </button>
          </div>
          <div
            className={regionToolMode === 'select' ? 'regionAnswerLayer active' : 'regionAnswerLayer'}
            onPointerDown={startRegion}
            onPointerMove={updateRegion}
            onPointerUp={finishRegion}
            onPointerCancel={finishRegion}
          />
        </>
      )}
    </div>
  );
}

const SlideCard = memo(function SlideCard({ slide, isActive, onSelect }) {
  return (
    <button
      type="button"
      className={isActive ? 'slideCard active' : 'slideCard'}
      onClick={() => onSelect(slide)}
      aria-pressed={isActive}
      aria-label={`Открыть препарат: ${getSlideTitle(slide)}`}
    >
      <strong>{getSlideTitle(slide)}</strong>
      <span>{getSlideOrgan(slide)}</span>
      <small>{getSlideStain(slide)}</small>
    </button>
  );
});

const Sidebar = memo(function Sidebar({
  organs,
  lessons,
  systems,
  stains,
  groupedSlides,
  selectedSlideId,
  filteredCount,
  searchQuery,
  selectedOrgan,
  selectedLesson,
  selectedSystem,
  selectedStain,
  onSearchChange,
  onOrganChange,
  onLessonChange,
  onSystemChange,
  onStainChange,
  onResetFilters,
  onSelectSlide,
}) {
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({});
  const activeFiltersCount = [
    selectedSystem !== ALL_SYSTEMS_OPTION,
    selectedLesson !== ALL_LESSONS_OPTION,
    selectedOrgan !== ALL_ORGANS_OPTION,
    selectedStain !== ALL_STAINS_OPTION,
  ].filter(Boolean).length;
  const groupEntries = useMemo(() => Object.entries(groupedSlides), [groupedSlides]);

  useEffect(() => {
    if (groupEntries.length === 0) return;

    setExpandedGroups((current) => {
      const next = { ...current };
      let changed = false;

      groupEntries.forEach(([system], index) => {
        if (next[system] === undefined) {
          next[system] = index === 0;
          changed = true;
        }
      });

      const activeGroup = groupEntries.find(([, slides]) => slides.some((slide) => slide.id === selectedSlideId))?.[0];
      if (activeGroup && !next[activeGroup]) {
        next[activeGroup] = true;
        changed = true;
      }

      return changed ? next : current;
    });
  }, [groupEntries, selectedSlideId]);

  const toggleGroup = useCallback((groupName) => {
    setExpandedGroups((current) => ({
      ...current,
      [groupName]: !current[groupName],
    }));
  }, []);

  return (
    <aside className="sidebar" aria-label="Каталог препаратов">
      <div className="sidebarTop">
        <div className="brand">
          <img src="/logo-ugmu.png" alt="УГМУ" className="brandLogo" />
          <div>
            <h1>Гистологический атлас</h1>
            <p>УГМУ</p>
          </div>
        </div>

        <div className="searchBlock">
          <label htmlFor="search">Поиск препарата</label>
          <input
            id="search"
            type="search"
            placeholder="ID, диагноз, орган, окраска..."
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>

        <button
          type="button"
          className={activeFiltersCount > 0 ? 'filtersToggle active' : 'filtersToggle'}
          onClick={() => setIsFiltersOpen((current) => !current)}
          aria-expanded={isFiltersOpen}
          aria-controls="filters-panel"
        >
          <span>Фильтры{activeFiltersCount > 0 ? ` • ${activeFiltersCount}` : ''}</span>
          <span className="chevron" aria-hidden="true">{isFiltersOpen ? '⌃' : '⌄'}</span>
        </button>

        {isFiltersOpen && (
          <div className="filtersPanel" id="filters-panel">
            <div className="filterBlock">
              <label htmlFor="systemFilter">Раздел</label>
              <select id="systemFilter" value={selectedSystem} onChange={(event) => onSystemChange(event.target.value)}>
                {systems.map((system) => <option key={system} value={system}>{system}</option>)}
              </select>
            </div>

            <div className="filterBlock">
              <label htmlFor="lessonFilter">Занятие</label>
              <select id="lessonFilter" value={selectedLesson} onChange={(event) => onLessonChange(event.target.value)}>
                {lessons.map((lesson) => <option key={lesson} value={lesson}>{lesson}</option>)}
              </select>
            </div>

            <div className="filterBlock">
              <label htmlFor="organFilter">Орган</label>
              <select id="organFilter" value={selectedOrgan} onChange={(event) => onOrganChange(event.target.value)}>
                {organs.map((organ) => <option key={organ} value={organ}>{organ}</option>)}
              </select>
            </div>

            <div className="filterBlock">
              <label htmlFor="stainFilter">Окраска</label>
              <select id="stainFilter" value={selectedStain} onChange={(event) => onStainChange(event.target.value)}>
                {stains.map((stain) => <option key={stain} value={stain}>{stain}</option>)}
              </select>
            </div>

            {activeFiltersCount > 0 && <button type="button" className="resetFilters" onClick={onResetFilters}>Сбросить фильтры</button>}
          </div>
        )}
      </div>

      <div className="slidesListScroll">
        <div className="slideCounter">
          Найдено препаратов: <strong>{filteredCount}</strong>
        </div>

        <div className="slideList">
        {groupEntries.map(([system, systemSlides]) => (
          <div key={system} className="systemGroup">
            <button
              type="button"
              className="systemTitle"
              onClick={() => toggleGroup(system)}
              aria-expanded={Boolean(expandedGroups[system])}
              aria-controls={`slide-group-${system}`}
            >
              <span>{system} <small>({systemSlides.length})</small></span>
              <span className="chevron" aria-hidden="true">{expandedGroups[system] ? '⌃' : '⌄'}</span>
            </button>

            {expandedGroups[system] && <div id={`slide-group-${system}`} className="slideGroupItems">{systemSlides.map((slide) => (
              <SlideCard
                key={slide.id}
                slide={slide}
                isActive={selectedSlideId === slide.id}
                onSelect={onSelectSlide}
              />
            ))}</div>}
          </div>
        ))}

        {filteredCount === 0 && (
          <div className="emptyState">
            Препараты не найдены. Попробуйте изменить поисковый запрос или фильтры.
          </div>
        )}
        </div>
      </div>
    </aside>
  );
});

function ViewerControls({
  isInfoVisible,
  isSelfTestMode,
  isViewerReady,
  onZoomOut,
  onResetView,
  onZoomIn,
  onToggleInfo,
  onToggleSelfTest,
  onToggleFullScreen,
}) {
  return (
    <div className="controls" aria-label="Управление просмотром препарата">
      <div className="controlGroup" aria-label="Масштаб">
        <button
          type="button"
          onClick={onZoomOut}
          disabled={!isViewerReady}
          title="Уменьшить"
          aria-label="Уменьшить масштаб"
        >
          −
        </button>
        <button
          type="button"
          onClick={onResetView}
          disabled={!isViewerReady}
          title="Общий вид"
          aria-label="Вернуться к общему виду"
        >
          Общий вид
        </button>
        <button
          type="button"
          onClick={onZoomIn}
          disabled={!isViewerReady}
          title="Увеличить"
          aria-label="Увеличить масштаб"
        >
          +
        </button>
      </div>
      <div className="controlGroup" aria-label="Режимы просмотра">
        <button
          type="button"
          onClick={onToggleInfo}
          title="Показать или скрыть описание"
          aria-label="Показать или скрыть описание препарата"
        >
          {isInfoVisible ? 'Скрыть' : 'Описание'}
        </button>
        <button
          type="button"
          className={isSelfTestMode ? 'activeControl' : ''}
          onClick={onToggleSelfTest}
          title="Режим самопроверки"
          aria-label="Включить или выключить режим самопроверки"
          aria-pressed={isSelfTestMode}
        >
          {isSelfTestMode ? 'Выйти' : 'Самопроверка'}
        </button>
        <button
          type="button"
          className="iconControl"
          onClick={onToggleFullScreen}
          disabled={!isViewerReady}
          title="Полноэкранный режим"
          aria-label="Открыть полноэкранный режим"
        >
          ⛶
        </button>
      </div>
    </div>
  );
}

function Breadcrumbs({ slide, isAnswerHidden }) {
  return (
    <nav className="breadcrumbs" aria-label="Положение препарата в атласе">
      <span>Главная</span>
      <span>/</span>
      <span>{isAnswerHidden ? 'Самопроверка' : getSlideSystem(slide)}</span>
      {!isAnswerHidden && (
        <>
          <span>/</span>
          <span>{getSlideTitle(slide)}</span>
        </>
      )}
    </nav>
  );
}

function SlideInfo({ slide, isAnswerHidden, activeMarker, onRevealAnswer, onSelectMarker }) {
  const diagnosticSigns = Array.isArray(slide.diagnosticSigns)
    ? slide.diagnosticSigns.map(normalizeDiagnosticSign).filter((sign) => sign.text)
    : [];

  if (isAnswerHidden) {
    return (
      <section className="info selfTestPanel">
        <div className="infoHeader">
          <div>
            <h3>Режим самопроверки</h3>
            <p>Попробуй определить препарат без подсказок</p>
          </div>
        </div>

        <div className="selfTestCard">
          <h4>Что нужно определить?</h4>
          <ul>
            <li>Орган или ткань</li>
            <li>Окраску препарата</li>
            <li>Патологический процесс</li>
            <li>Основные диагностические признаки</li>
          </ul>

          <button type="button" onClick={onRevealAnswer}>
            Показать ответ
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="info">
      <div className="infoHeader">
        <div>
          <h3>Описание препарата</h3>
          <p>Краткая учебная характеристика микропрепарата</p>
        </div>
      </div>

      <div className="descriptionCard">
        <p>{slide.description || 'Описание пока не добавлено.'}</p>
      </div>

      <div className="diagnosticBlock">
        <h3>Диагностические признаки</h3>

        {diagnosticSigns.length > 0 ? (
          <ul className="diagnosticSignsList">
            {diagnosticSigns.map((sign, index) => (
              <li key={`${sign.text}-${index}`}>
                {sign.marker ? (
                  <button
                    type="button"
                    className={activeMarker === sign.marker ? 'active' : ''}
                    onClick={() => onSelectMarker(sign.marker)}
                  >
                    {sign.text}
                  </button>
                ) : (
                  <span>{sign.text}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>Диагностические признаки пока не добавлены.</p>
        )}
      </div>

      <div className="metaGrid">
        <div>
          <span>Раздел</span>
          <strong>{getSlideSystem(slide)}</strong>
        </div>
        <div>
          <span>Занятие</span>
          <strong>{getSlideLesson(slide)}</strong>
        </div>
        <div>
          <span>Орган</span>
          <strong>{getSlideOrgan(slide)}</strong>
        </div>
        <div>
          <span>Окраска</span>
          <strong>{getSlideStain(slide)}</strong>
        </div>
      </div>
    </section>
  );
}

function EmptyApp() {
  return (
    <div className="emptyApp">
      <div className="emptyCard">
        <img src="/logo-ugmu.png" alt="УГМУ" />
        <h1>Гистологический атлас УГМУ</h1>
        <p>
          В атлас пока не добавлены препараты. Администратор может добавить
          первый препарат через панель управления.
        </p>
        <a href="/admin" className="emptyAction">
          Открыть админ-панель
        </a>
      </div>
    </div>
  );
}

function LoadingApp() {
  return (
    <div className="emptyApp">
      <div className="emptyCard">
        <h1>Загрузка препаратов...</h1>
        <p>Подключаемся к серверу атласа.</p>
      </div>
    </div>
  );
}

function ErrorApp({ message }) {
  return (
    <div className="emptyApp">
      <div className="emptyCard">
        <h1>Не удалось загрузить препараты</h1>
        <p>{message}</p>
        <a href="/admin" className="emptyAction">
          Перейти в админ-панель
        </a>
      </div>
    </div>
  );
}

function MoodleLoginRequired() {
  return <div className="emptyApp"><div className="emptyCard"><h1>Откройте атлас через Moodle</h1><p>Войдите в Moodle и откройте внешний инструмент «Гистологический атлас» из нужного курса.</p></div></div>;
}

function ViewerApp() {
  const viewerElementRef = useRef(null);
  const viewerRef = useRef(null);
  const activeMarkerOverlayRef = useRef(null);

  const [slidesData, setSlidesData] = useState([]);
  const [selectedSlide, setSelectedSlide] = useState(null);
  const [activeMarker, setActiveMarker] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrgan, setSelectedOrgan] = useState(ALL_ORGANS_OPTION);
  const [selectedLesson, setSelectedLesson] = useState(ALL_LESSONS_OPTION);
  const [selectedSystem, setSelectedSystem] = useState(ALL_SYSTEMS_OPTION);
  const [selectedStain, setSelectedStain] = useState(ALL_STAINS_OPTION);
  const [isInfoVisible, setIsInfoVisible] = useState(true);
  const [isSelfTestMode, setIsSelfTestMode] = useState(false);
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [isLoadingSlides, setIsLoadingSlides] = useState(true);
  const [slidesError, setSlidesError] = useState('');
  const [viewerLoadError, setViewerLoadError] = useState('');
  const [viewerStatus, setViewerStatus] = useState('idle');
  const [viewerTileStats, setViewerTileStats] = useState({ loaded: 0, failed: 0 });

  const resetFilters = useCallback(() => {
    setSelectedOrgan(ALL_ORGANS_OPTION);
    setSelectedLesson(ALL_LESSONS_OPTION);
    setSelectedSystem(ALL_SYSTEMS_OPTION);
    setSelectedStain(ALL_STAINS_OPTION);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSlides() {
      try {
        setIsLoadingSlides(true);
        setSlidesError('');

        const response = await fetch('/api/slides', {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Ошибка сервера: ${response.status}`);
        }

        const data = await response.json();
        const nextSlides = Array.isArray(data) ? data : [];

        setSlidesData(nextSlides);
        setSelectedSlide((current) => current || nextSlides[0] || null);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setSlidesError(error.message || 'Проверь, запущен ли backend.');
        }
      } finally {
        setIsLoadingSlides(false);
      }
    }

    loadSlides();

    return () => controller.abort();
  }, []);

  const organs = useMemo(() => {
    const uniqueOrgans = new Set();

    slidesData.forEach((slide) => {
      if (slide.organ) uniqueOrgans.add(slide.organ);
    });

    return [ALL_ORGANS_OPTION, ...Array.from(uniqueOrgans)];
  }, [slidesData]);

  const lessons = useMemo(() => {
    const uniqueLessons = new Set();

    slidesData.forEach((slide) => {
      uniqueLessons.add(getSlideLesson(slide));
    });

    return [ALL_LESSONS_OPTION, ...Array.from(uniqueLessons)];
  }, [slidesData]);

  const systems = useMemo(() => {
    const uniqueSystems = new Set();

    slidesData.forEach((slide) => {
      uniqueSystems.add(getSlideSystem(slide));
    });

    return [ALL_SYSTEMS_OPTION, ...Array.from(uniqueSystems).sort((a, b) => a.localeCompare(b, 'ru'))];
  }, [slidesData]);

  const stains = useMemo(() => {
    const uniqueStains = new Set();

    slidesData.forEach((slide) => {
      uniqueStains.add(getSlideStain(slide));
    });

    return [ALL_STAINS_OPTION, ...Array.from(uniqueStains).sort((a, b) => a.localeCompare(b, 'ru'))];
  }, [slidesData]);

  const filteredSlides = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return slidesData.filter((slide) => {
      const matchesOrgan =
        selectedOrgan === ALL_ORGANS_OPTION || slide.organ === selectedOrgan;
      const matchesLesson =
        selectedLesson === ALL_LESSONS_OPTION || getSlideLesson(slide) === selectedLesson;
      const matchesSystem =
        selectedSystem === ALL_SYSTEMS_OPTION || getSlideSystem(slide) === selectedSystem;
      const matchesStain =
        selectedStain === ALL_STAINS_OPTION || getSlideStain(slide) === selectedStain;

      if (!matchesOrgan || !matchesLesson || !matchesSystem || !matchesStain) return false;
      if (!query) return true;

      const searchableText = [
        slide.id,
        slide.title,
        slide.diagnosis,
        slide.lesson,
        slide.system,
        slide.organ,
        slide.stain,
        slide.description,
        ...(slide.diagnosticSigns || []).map((sign) => normalizeDiagnosticSign(sign).text),
      ]
        .map(toSearchText)
        .join(' ');

      return searchableText.includes(query);
    });
  }, [slidesData, searchQuery, selectedLesson, selectedOrgan, selectedStain, selectedSystem]);

  const groupedSlides = useMemo(() => {
    return filteredSlides.reduce((groups, slide) => {
      const system = getSlideSystem(slide);

      if (!groups[system]) groups[system] = [];
      groups[system].push(slide);

      return groups;
    }, {});
  }, [filteredSlides]);

  useEffect(() => {
    if (filteredSlides.length === 0) return;

    const selectedIsVisible = filteredSlides.some(
      (slide) => slide.id === selectedSlide?.id
    );

    if (!selectedIsVisible) {
      setSelectedSlide(filteredSlides[0]);
    }
  }, [filteredSlides, selectedSlide?.id]);

  useEffect(() => {
    setIsAnswerVisible(false);
    setActiveMarker(null);
    setViewerLoadError('');
    setViewerStatus('loading');
    setViewerTileStats({ loaded: 0, failed: 0 });
  }, [selectedSlide?.id]);

  useEffect(() => {
    let isCancelled = false;
    const viewerElement = viewerElementRef.current;
    const tileSources = createTileSource(selectedSlide?.source);

    if (!viewerElement) return undefined;

    if (!tileSources) {
      setViewerLoadError('У препарата не указан DZI-адрес или файл изображения.');
      setViewerStatus('error');
      return undefined;
    }

    viewerRef.current?.destroy();
    setViewerLoadError('');
    setViewerStatus('loading');
    setViewerTileStats({ loaded: 0, failed: 0 });

    import('openseadragon')
      .then(({ default: OpenSeadragon }) => {
        if (isCancelled) return;

        const viewer = OpenSeadragon({
          element: viewerElement,
          prefixUrl: '/openseadragon/images/',
          tileSources,
          showNavigator: true,
          showRotationControl: true,
          animationTime: 0.5,
          blendTime: 0.1,
          maxZoomPixelRatio: 8,
          visibilityRatio: 1,
          constrainDuringPan: true,
          gestureSettingsMouse: {
            scrollToZoom: true,
            clickToZoom: false,
            dblClickToZoom: true,
          },
          gestureSettingsTouch: {
            pinchToZoom: true,
            flickEnabled: true,
            clickToZoom: false,
            dblClickToZoom: true,
          },
        });
        viewer.addHandler('open', () => {
          setViewerStatus('ready');
        });
        viewer.addHandler('tile-loaded', () => {
          if (isCancelled) return;
          setViewerTileStats((current) => ({
            ...current,
            loaded: current.loaded + 1,
          }));
        });
        viewer.addHandler('tile-load-failed', () => {
          if (isCancelled) return;
          setViewerTileStats((current) => ({
            ...current,
            failed: current.failed + 1,
          }));
        });
        viewer.addHandler('open-failed', () => {
          setViewerStatus('error');
          setViewerLoadError('Не удалось загрузить изображение препарата. Проверьте DZI-адрес и наличие тайлов.');
        });
        viewerRef.current = viewer;
      })
      .catch(() => {
        setViewerStatus('error');
        setViewerLoadError('Не удалось загрузить модуль просмотра препарата.');
      });

    return () => {
      isCancelled = true;
      if (activeMarkerOverlayRef.current) {
        viewerRef.current?.removeOverlay(activeMarkerOverlayRef.current);
        activeMarkerOverlayRef.current = null;
      }
      viewerRef.current?.destroy();
      viewerRef.current = null;
      setViewerStatus('idle');
    };
  }, [selectedSlide?.id, selectedSlide?.source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return undefined;

    if (activeMarkerOverlayRef.current) {
      viewer.removeOverlay(activeMarkerOverlayRef.current);
      activeMarkerOverlayRef.current = null;
    }

    if (activeMarker) {
      activeMarkerOverlayRef.current = addMarkerOverlay(viewer, activeMarker);
      const rect = getMarkerViewportRect(viewer, activeMarker);

      if (rect) {
        viewer.viewport.fitBounds(rect, false);
        viewer.viewport.zoomBy(0.75);
        viewer.viewport.applyConstraints();
      }
    }

    return () => {
      if (viewerRef.current === viewer && activeMarkerOverlayRef.current) {
        viewer.removeOverlay(activeMarkerOverlayRef.current);
        activeMarkerOverlayRef.current = null;
      }
    };
  }, [activeMarker]);

  const zoomIn = () => {
    viewerRef.current?.viewport.zoomBy(1.3);
    viewerRef.current?.viewport.applyConstraints();
  };

  const zoomOut = () => {
    viewerRef.current?.viewport.zoomBy(0.7);
    viewerRef.current?.viewport.applyConstraints();
  };

  const resetView = () => {
    viewerRef.current?.viewport.goHome();
  };

  const toggleInfo = () => {
    setIsInfoVisible((value) => !value);
  };

  const toggleSelfTest = () => {
    setIsSelfTestMode((value) => {
      const nextValue = !value;
      setIsInfoVisible(true);
      setIsAnswerVisible(false);
      return nextValue;
    });
  };

  const toggleFullScreen = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    viewer.setFullScreen(!viewer.isFullPage());
  };

  if (isLoadingSlides) return <LoadingApp />;
  if (slidesError) return <ErrorApp message={slidesError} />;
  if (!selectedSlide) return <EmptyApp />;

  const isAnswerHidden = isSelfTestMode && !isAnswerVisible;
  const isViewerReady = viewerStatus === 'ready';
  const viewerLoadingLabel = viewerTileStats.loaded > 0
    ? `Загрузка тайлов: ${viewerTileStats.loaded}${viewerTileStats.failed > 0 ? `, ошибок: ${viewerTileStats.failed}` : ''}`
    : 'Загрузка препарата...';

  return (
    <div className={isInfoVisible ? 'app' : 'app infoHidden'}>
      <Sidebar
        organs={organs}
        lessons={lessons}
        systems={systems}
        stains={stains}
        groupedSlides={groupedSlides}
        selectedSlideId={selectedSlide.id}
        filteredCount={filteredSlides.length}
        searchQuery={searchQuery}
        selectedOrgan={selectedOrgan}
        selectedLesson={selectedLesson}
        selectedSystem={selectedSystem}
        selectedStain={selectedStain}
        onSearchChange={setSearchQuery}
        onOrganChange={setSelectedOrgan}
        onLessonChange={setSelectedLesson}
        onSystemChange={setSelectedSystem}
        onStainChange={setSelectedStain}
        onResetFilters={resetFilters}
        onSelectSlide={setSelectedSlide}
      />

      <main className="main">
        <header className="topbar">
          <div className="titleBlock">
            <Breadcrumbs slide={selectedSlide} isAnswerHidden={isAnswerHidden} />
            <div className="badge">
              {isAnswerHidden ? 'Самопроверка' : getSlideOrgan(selectedSlide)}
            </div>
            <h2>{isAnswerHidden ? 'Определи препарат' : getSlideTitle(selectedSlide)}</h2>
            <p>
              {isAnswerHidden
                ? 'Название, раздел, орган и диагностические признаки скрыты'
                : `${getSlideLesson(selectedSlide)} · ${getSlideSystem(selectedSlide)} · ${getSlideOrgan(selectedSlide)} · ${getSlideStain(selectedSlide)}`}
            </p>
          </div>

          <ViewerControls
            isInfoVisible={isInfoVisible}
            isSelfTestMode={isSelfTestMode}
            isViewerReady={isViewerReady}
            onZoomOut={zoomOut}
            onResetView={resetView}
            onZoomIn={zoomIn}
            onToggleInfo={toggleInfo}
            onToggleSelfTest={toggleSelfTest}
            onToggleFullScreen={toggleFullScreen}
          />
        </header>

        {filteredSlides.length > 0 ? (
          <div className={isInfoVisible ? 'atlasWorkspace' : 'atlasWorkspace infoCollapsed'}>
            <section className="viewerWrap">
              {viewerLoadError && (
                <div className="viewerError">
                  {viewerLoadError}
                </div>
              )}
              <div ref={viewerElementRef} className="viewer" />
              {viewerStatus === 'loading' && !viewerLoadError && (
                <div className="viewerLoading" role="status" aria-live="polite">
                  <span />
                  {viewerLoadingLabel}
                </div>
              )}
              {viewerStatus === 'ready' && viewerTileStats.failed > 0 && (
                <div className="viewerTileWarning" role="status">
                  Не загрузилось тайлов: {viewerTileStats.failed}
                </div>
              )}
            </section>

            {isInfoVisible && (
              <SlideInfo
                slide={selectedSlide}
                isAnswerHidden={isAnswerHidden}
                activeMarker={activeMarker}
                onRevealAnswer={() => setIsAnswerVisible(true)}
                onSelectMarker={setActiveMarker}
              />
            )}
          </div>
        ) : (
          <section className="notFound">
            <h2>Препараты не найдены</h2>
            <p>Попробуй изменить поисковый запрос, занятие или орган.</p>
          </section>
        )}
      </main>
    </div>
  );
}

function DiagnosticPage() {
  const diagnosticId = window.location.pathname.split('/').filter(Boolean)[1];
  const isPreviewMode = new URLSearchParams(window.location.search).get('preview') === '1';

  const [diagnostic, setDiagnostic] = useState(null);
  const [loadingError, setLoadingError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [student, setStudent] = useState({
    studentName: '',
    group: '',
  });
  const [isStarted, setIsStarted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [isCheckingAttempt, setIsCheckingAttempt] = useState(false);
  const [draftStatus, setDraftStatus] = useState('');
  const diagnosticDraftKey = useMemo(
    () => getDiagnosticDraftKey(diagnosticId, student),
    [diagnosticId, student]
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadDiagnostic() {
      try {
        setIsLoading(true);
        setLoadingError('');

        const response = await fetch(
          isPreviewMode
            ? `/api/admin/diagnostics/${diagnosticId}/preview`
            : `/api/diagnostics/${diagnosticId}`,
          {
            signal: controller.signal,
          }
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `Ошибка сервера: ${response.status}`);
        }

        setDiagnostic(data);
        setAnswers({});
        setActiveIndex(0);
        setResult(null);
        setSubmitError('');
        setDraftStatus('');
        if (isPreviewMode) {
          setStudent({
            studentName: 'Предпросмотр',
            group: 'Админка',
          });
          setTimeLeft(null);
          setIsStarted(true);
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          setLoadingError(error.message || 'Не удалось загрузить диагностику');
        }
      } finally {
        setIsLoading(false);
      }
    }

    loadDiagnostic();

    return () => controller.abort();
  }, [diagnosticId, isPreviewMode]);

  const activeQuestion = diagnostic?.questions?.[activeIndex] || null;
  const activeQuestionHighlight =
    activeQuestion?.type === 'region' && activeQuestion.highlight?.type !== 'arrow'
      ? null
      : activeQuestion?.highlight;
  const answeredCount = diagnostic?.questions?.filter((question) =>
    getQuestionAnswerStatus(question, answers[question.id])
  ).length || 0;

  const updateStudentField = (field, value) => {
    setStudent((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const startDiagnostic = async () => {
    setIsCheckingAttempt(true);
    setLoginError('');

    try {
      const response = await fetch(`/api/diagnostics/${diagnostic.id}/check-attempt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(student),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось начать диагностику');
      }

      const durationSeconds = Number(diagnostic.durationMinutes || 0) * 60;
      let restoredDraft = null;

      if (!isPreviewMode && diagnosticDraftKey) {
        try {
          const rawDraft = window.localStorage.getItem(diagnosticDraftKey);
          const parsedDraft = rawDraft ? JSON.parse(rawDraft) : null;

          if (parsedDraft?.diagnosticId === diagnostic.id) {
            restoredDraft = parsedDraft;
          }
        } catch {
          window.localStorage.removeItem(diagnosticDraftKey);
        }
      }

      setAnswers(restoredDraft?.answers || {});
      setActiveIndex(
        Math.max(
          0,
          Math.min(
            diagnostic.questions.length - 1,
            Number(restoredDraft?.activeIndex || 0)
          )
        )
      );
      setTimeLeft(
        restoredDraft && durationSeconds > 0
          ? Math.max(
              0,
              Number(restoredDraft.timeLeft ?? durationSeconds) -
                Math.max(0, Math.floor((Date.now() - new Date(restoredDraft.savedAt || Date.now()).getTime()) / 1000))
            )
          : durationSeconds > 0
            ? durationSeconds
            : null
      );
      setDraftStatus(restoredDraft ? 'Черновик ответов восстановлен' : '');
      setIsStarted(true);
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setIsCheckingAttempt(false);
    }
  };

  const submitDiagnostic = useCallback(async ({ isAutoSubmitted = false } = {}) => {
    if (!diagnostic || isSubmitting || result || isPreviewMode) return;

    setIsSubmitting(true);
    setSubmitError(isAutoSubmitted ? 'Время вышло. Отправляем текущие ответы...' : '');

    try {
      const response = await fetch(`/api/diagnostics/${diagnostic.id}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...student,
          answers: Object.entries(answers).map(([questionId, answer]) => ({
            questionId,
            ...answer,
          })),
          isAutoSubmitted,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить ответы');
      }

      setResult(data);
      if (diagnosticDraftKey) {
        window.localStorage.removeItem(diagnosticDraftKey);
      }
    } catch (error) {
      setSubmitError(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }, [answers, diagnostic, diagnosticDraftKey, isPreviewMode, isSubmitting, result, student]);

  useEffect(() => {
    if (!isStarted || result || isPreviewMode || !diagnostic || !diagnosticDraftKey) {
      return;
    }

    const draft = {
      diagnosticId: diagnostic.id,
      student,
      answers,
      activeIndex,
      timeLeft,
      savedAt: new Date().toISOString(),
    };

    try {
      window.localStorage.setItem(diagnosticDraftKey, JSON.stringify(draft));
      if (Object.keys(answers).length > 0) {
        setDraftStatus('Ответы сохранены в браузере');
      }
    } catch {
      setDraftStatus('Не удалось сохранить ответы в браузере');
    }
  }, [
    activeIndex,
    answers,
    diagnostic,
    diagnosticDraftKey,
    isPreviewMode,
    isStarted,
    result,
    student,
    timeLeft,
  ]);

  useEffect(() => {
    if (!isStarted || result || isSubmitting || isPreviewMode) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isPreviewMode, isStarted, isSubmitting, result]);

  useEffect(() => {
    if (!isStarted || result || isSubmitting || timeLeft === null) return undefined;

    if (timeLeft <= 0) {
      submitDiagnostic({ isAutoSubmitted: true });
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setTimeLeft((current) => (current === null ? null : current - 1));
    }, 1000);

    return () => window.clearTimeout(timerId);
  }, [isStarted, isSubmitting, result, submitDiagnostic, timeLeft]);

  useEffect(() => {
    if (!result?.id || !student.studentName || !student.group) return undefined;

    const refreshResult = async () => {
      const query = new URLSearchParams({
        studentName: student.studentName,
        group: student.group,
      });
      const response = await fetch(`/api/diagnostics/${diagnosticId}/results/${result.id}?${query}`);
      if (response.ok) setResult(await response.json());
    };

    refreshResult().catch(() => {});
    const intervalId = window.setInterval(() => refreshResult().catch(() => {}), 30000);
    return () => window.clearInterval(intervalId);
  }, [diagnosticId, result?.id, student.group, student.studentName]);

  if (isLoading) return <LoadingApp />;

  if (loadingError) {
    return (
      <div className="diagnosticShell">
        <div className="diagnosticMessage">
          <img src="/logo-ugmu.png" alt="УГМУ" />
          <h1>Диагностика недоступна</h1>
          <p>{loadingError}</p>
          <a href="/" className="emptyAction">Открыть атлас</a>
        </div>
      </div>
    );
  }

  if (!diagnostic || diagnostic.questions.length === 0) {
    return (
      <div className="diagnosticShell">
        <div className="diagnosticMessage">
          <h1>В диагностике нет вопросов</h1>
          <p>Сообщите преподавателю, что тест нужно заполнить в админ-панели.</p>
        </div>
      </div>
    );
  }

  if (result) {
    const resultAnswerById = new Map(
      (Array.isArray(result.answers) ? result.answers : []).map((answer) => [
        answer.questionId,
        answer,
      ])
    );

    return (
      <div className="diagnosticShell">
        <div className="diagnosticMessage diagnosticResultCard">
          <img src="/logo-ugmu.png" alt="УГМУ" />
          <h1>Ответы отправлены</h1>
          <p>
            Результат: <strong>{result.score} из {result.total}</strong> ({result.percent}%).
          </p>
          {result.reviewComment && (
            <p className="diagnosticReviewComment">Комментарий преподавателя: {result.reviewComment}</p>
          )}
          <div className="diagnosticResultList">
            {diagnostic.questions.map((question, index) => {
              const answer = resultAnswerById.get(question.id);

              return (
                <div
                  key={question.id}
                  className={answer?.isCorrect ? 'diagnosticResultItem correct' : 'diagnosticResultItem'}
                >
                  <div>
                    <strong>Вопрос {index + 1}</strong>
                    <span>{question.prompt}</span>
                  </div>
                  <em>{getResultAnswerStatus(answer)}</em>
                  <small>
                    {Number(answer?.earnedPoints || 0)} / {Number(answer?.points || 0)}
                  </small>
                  {answer?.reviewComment && <p>{answer.reviewComment}</p>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (!isStarted) {
    return (
      <div className="diagnosticShell">
        <form
          className="diagnosticLogin"
          onSubmit={(event) => {
            event.preventDefault();
            startDiagnostic();
          }}
        >
          <img src="/logo-ugmu.png" alt="УГМУ" />
          <div>
            <span>Диагностика препаратов</span>
            <h1>{diagnostic.title}</h1>
            <p>
              Введите данные перед началом выполнения.
              {diagnostic.durationMinutes
                ? ` Время на выполнение: ${diagnostic.durationMinutes} мин.`
                : ''}
            </p>
          </div>

          <label>
            ФИО
            <input
              required
              value={student.studentName}
              onChange={(event) => updateStudentField('studentName', event.target.value)}
              placeholder="Иванов Иван Иванович"
            />
          </label>

          <label>
            Группа
            <input
              required
              value={student.group}
              onChange={(event) => updateStudentField('group', event.target.value)}
              placeholder="Л-301"
            />
          </label>

          {loginError && <p className="diagnosticError">{loginError}</p>}

          <button type="submit" disabled={isCheckingAttempt}>
            {isCheckingAttempt ? 'Проверка...' : 'Начать диагностику'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="diagnosticPage">
      <header className="diagnosticTopbar">
        <div>
          <span>{student.studentName} · {student.group}</span>
          <h1>{diagnostic.title}</h1>
          <p>
            {isPreviewMode ? 'Предпросмотр без сохранения ответов. ' : ''}
            Вопрос {activeIndex + 1} из {diagnostic.questions.length}. Ответов: {answeredCount}.
            {draftStatus && !isPreviewMode ? (
              <span className="diagnosticDraftStatus"> {draftStatus}</span>
            ) : null}
          </p>
        </div>

        {timeLeft !== null && (
          <div className={timeLeft <= 60 ? 'diagnosticTimer warning' : 'diagnosticTimer'}>
            {formatTimer(timeLeft)}
          </div>
        )}

        <button
          type="button"
          disabled={isSubmitting || isPreviewMode}
          onClick={() => submitDiagnostic()}
        >
          {isPreviewMode ? 'Предпросмотр' : isSubmitting ? 'Отправка...' : 'Завершить'}
        </button>
      </header>

      <main className={activeQuestion.type === 'region' ? 'diagnosticLayout regionMode' : 'diagnosticLayout'}>
        <section className="diagnosticViewerPanel">
          <SlideViewer
            key={activeQuestion.id}
            source={activeQuestion.slide.source}
            highlight={activeQuestionHighlight}
            className="diagnosticViewer"
            isRegionAnswerMode={activeQuestion.type === 'region'}
            selectedRegion={answers[activeQuestion.id]?.selectedRegion}
            onRegionChange={(selectedRegion) => {
              setAnswers((current) => ({
                ...current,
                [activeQuestion.id]: {
                  selectedRegion,
                },
              }));
            }}
          />
        </section>

        <aside className="diagnosticQuestionPanel">
          <div>
            <div className="badge">{activeQuestion.slide.title}</div>
            <h2>{activeQuestion.prompt}</h2>
          </div>

          <div className="diagnosticOptions">
            {activeQuestion.type === 'text' ? (
              <label className="diagnosticTextAnswer">
                Ответ
                <textarea
                  rows="5"
                  value={answers[activeQuestion.id]?.textAnswer || ''}
                  onChange={(event) => {
                    setAnswers((current) => ({
                      ...current,
                      [activeQuestion.id]: {
                        textAnswer: event.target.value,
                      },
                    }));
                  }}
                  placeholder="Введите ответ"
                />
              </label>
            ) : activeQuestion.type === 'number' ? (
              <label className="diagnosticTextAnswer">
                Числовой ответ
                <input
                  type="number"
                  value={answers[activeQuestion.id]?.numberAnswer || ''}
                  onChange={(event) => {
                    setAnswers((current) => ({
                      ...current,
                      [activeQuestion.id]: {
                        numberAnswer: event.target.value,
                      },
                    }));
                  }}
                  placeholder="Введите число"
                />
              </label>
            ) : activeQuestion.type === 'matching' ? (
              <div className="matchingAnswer">
                {activeQuestion.answer.pairs.left.map((leftItem) => (
                  <label key={leftItem.id}>
                    {leftItem.text}
                    <select
                      value={answers[activeQuestion.id]?.selectedPairs?.[leftItem.id] || ''}
                      onChange={(event) => {
                        setAnswers((current) => ({
                          ...current,
                          [activeQuestion.id]: {
                            selectedPairs: {
                              ...(current[activeQuestion.id]?.selectedPairs || {}),
                              [leftItem.id]: event.target.value,
                            },
                          },
                        }));
                      }}
                    >
                      <option value="">Выберите соответствие</option>
                      {activeQuestion.answer.pairs.right.map((rightItem) => (
                        <option key={rightItem.id} value={rightItem.id}>
                          {rightItem.text}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            ) : activeQuestion.type === 'ordering' ? (
              <div className="orderingAnswer">
                {(answers[activeQuestion.id]?.orderedItemIds || activeQuestion.answer.items.map((item) => item.id)).map((itemId, orderIndex, currentOrder) => {
                  const item = activeQuestion.answer.items.find((entry) => entry.id === itemId);
                  return (
                    <div key={itemId} className="orderingItem">
                      <span>{orderIndex + 1}. {item?.text || itemId}</span>
                      <button
                        type="button"
                        disabled={orderIndex === 0}
                        onClick={() => {
                          const nextOrder = [...currentOrder];
                          [nextOrder[orderIndex - 1], nextOrder[orderIndex]] = [nextOrder[orderIndex], nextOrder[orderIndex - 1]];
                          setAnswers((current) => ({
                            ...current,
                            [activeQuestion.id]: {
                              orderedItemIds: nextOrder,
                            },
                          }));
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={orderIndex === currentOrder.length - 1}
                        onClick={() => {
                          const nextOrder = [...currentOrder];
                          [nextOrder[orderIndex], nextOrder[orderIndex + 1]] = [nextOrder[orderIndex + 1], nextOrder[orderIndex]];
                          setAnswers((current) => ({
                            ...current,
                            [activeQuestion.id]: {
                              orderedItemIds: nextOrder,
                            },
                          }));
                        }}
                      >
                        ↓
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : activeQuestion.type === 'region' ? (
              <div className="diagnosticInstruction">
                <p>Выделите область ответа прямоугольником на увеличенном препарате слева.</p>
                <button
                  type="button"
                  disabled={!answers[activeQuestion.id]?.selectedRegion}
                  onClick={() => {
                    setAnswers((current) => ({
                      ...current,
                      [activeQuestion.id]: {
                        selectedRegion: null,
                      },
                    }));
                  }}
                >
                  Очистить выделение
                </button>
              </div>
            ) : (
              (activeQuestion.answer?.options || activeQuestion.options.map((option, index) => ({
                id: `legacy-${index}`,
                text: option,
              }))).map((option, index) => {
                const currentAnswer = answers[activeQuestion.id] || {};
                const selectedOptionIds = currentAnswer.selectedOptionIds || [];
                const selectedOptions = currentAnswer.selectedOptions || [];
                const isSelected =
                  activeQuestion.type === 'multiple'
                    ? selectedOptionIds.includes(option.id) || selectedOptions.includes(option.text)
                    : currentAnswer.selectedOptionId === option.id || currentAnswer.selectedOption === option.text;

                return (
                  <button
                    type="button"
                    key={`${activeQuestion.id}-${option.id}-${index}`}
                    className={isSelected ? 'diagnosticOption selected' : 'diagnosticOption'}
                    onClick={() => {
                      setAnswers((current) => {
                        if (activeQuestion.type === 'multiple') {
                          const existingOptionIds =
                            current[activeQuestion.id]?.selectedOptionIds || [];
                          const existingOptions =
                            current[activeQuestion.id]?.selectedOptions || [];
                          const nextOptionIds = existingOptionIds.includes(option.id)
                            ? existingOptionIds.filter((item) => item !== option.id)
                            : [...existingOptionIds, option.id];
                          const nextOptions = existingOptions.includes(option.text)
                            ? existingOptions.filter((item) => item !== option.text)
                            : [...existingOptions, option.text];

                          return {
                            ...current,
                            [activeQuestion.id]: {
                              selectedOptionIds: nextOptionIds,
                              selectedOptions: nextOptions,
                            },
                          };
                        }

                        return {
                          ...current,
                          [activeQuestion.id]: {
                            selectedOptionId: option.id,
                            selectedOption: option.text,
                          },
                        };
                      });
                    }}
                  >
                    <span>{activeQuestion.type === 'multiple' ? (isSelected ? '✓' : '') : String.fromCharCode(65 + index)}</span>
                    {option.text}
                  </button>
                );
              })
            )}

            {activeQuestion.type === 'combined' && (
              <label className="diagnosticTextAnswer">
                Дополнительный текстовый ответ
                <textarea
                  rows="4"
                  value={answers[activeQuestion.id]?.textAnswer || ''}
                  onChange={(event) => {
                    setAnswers((current) => ({
                      ...current,
                      [activeQuestion.id]: {
                        ...(current[activeQuestion.id] || {}),
                        textAnswer: event.target.value,
                      },
                    }));
                  }}
                  placeholder="Введите ответ"
                />
              </label>
            )}
          </div>

          <div className="diagnosticNav">
            <button
              type="button"
              disabled={activeIndex === 0}
              onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
            >
              Назад
            </button>
            <button
              type="button"
              disabled={activeIndex === diagnostic.questions.length - 1}
              onClick={() =>
                setActiveIndex((index) =>
                  Math.min(diagnostic.questions.length - 1, index + 1)
                )
              }
            >
              Далее
            </button>
          </div>

          <div className="diagnosticQuestionDots">
            {diagnostic.questions.map((question, index) => (
              <button
                type="button"
                key={question.id}
                className={[
                  index === activeIndex ? 'active' : '',
                  getQuestionAnswerStatus(question, answers[question.id]) ? 'answered' : '',
                ].join(' ')}
                onClick={() => setActiveIndex(index)}
                aria-label={`Открыть вопрос ${index + 1}`}
              >
                {index + 1}
              </button>
            ))}
          </div>

          {submitError && <p className="diagnosticError">{submitError}</p>}
        </aside>
      </main>
    </div>
  );
}

function App() {
  if (window.location.pathname.startsWith('/admin')) {
    return (
      <Suspense fallback={<LoadingApp />}>
        <AdminPage />
      </Suspense>
    );
  }

  return <LtiProtectedApp />;
}

function LtiProtectedApp() {
  const [state, setState] = useState({ loading: true, user: null });
  useEffect(() => {
    fetch('/api/me').then((response) => response.ok ? response.json() : { authenticated: false })
      .then((user) => setState({
        loading: false,
        user: user.authenticated || user.permissions?.canViewSlides ? user : null,
      }))
      .catch(() => setState({ loading: false, user: null }));
  }, []);
  if (state.loading) return <LoadingApp />;
  if (!state.user) return <MoodleLoginRequired />;
  if (window.location.pathname.startsWith('/diagnostics/')) return <DiagnosticPage />;
  return <ViewerApp />;
}

export default App;
