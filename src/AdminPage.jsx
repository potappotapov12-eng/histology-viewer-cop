import { useEffect, useMemo, useRef, useState } from 'react';

const INITIAL_FORM = {
  id: '',
  title: '',
  system: '',
  organ: '',
  stain: 'H&E',
  description: '',
  diagnosticSigns: '',
  selfCheckQuestions: '',
  source: '',
};

const INITIAL_DIAGNOSTIC_FORM = {
  id: '',
  title: '',
  startsAt: '',
  endsAt: '',
  durationMinutes: '',
  isPublished: true,
  questions: [],
};

const DEFAULT_REGION_THRESHOLD = 70;
const DIAGNOSTIC_DRAFT_KEY = 'histology-viewer-diagnostic-draft';
const DIAGNOSTIC_TIME_ZONE = 'Asia/Yekaterinburg';
const DIAGNOSTIC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: DIAGNOSTIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

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

function createHighlightOverlayElement() {
  const element = document.createElement('div');
  element.className = 'diagnosticHighlightOverlay';
  return element;
}

function addPickerHighlightOverlay(viewer, highlight) {
  if (!viewer || !highlight) return null;

  const tiledImage = viewer.world.getItemAt(0);
  const size = tiledImage?.source?.dimensions;

  if (!tiledImage || !size?.x || !size?.y) return null;

  const element = createHighlightOverlayElement();
  const rect = tiledImage.imageToViewportRectangle(
    (Number(highlight.x) / 100) * size.x,
    (Number(highlight.y) / 100) * size.y,
    (Number(highlight.width) / 100) * size.x,
    (Number(highlight.height) / 100) * size.y
  );

  viewer.addOverlay({
    element,
    location: rect,
  });

  return element;
}

function HighlightPicker({ slide, highlight, onChange }) {
  const viewerElementRef = useRef(null);
  const viewerRef = useRef(null);
  const openSeadragonRef = useRef(null);
  const dragStartRef = useRef(null);
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

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = point;
    onChange(buildHighlightFromPoints(point, point));
  };

  const updateDrawing = (event) => {
    if (mode !== 'select' || !dragStartRef.current) return;
    const point = getImagePercentPoint(
      viewerRef.current,
      openSeadragonRef.current,
      event
    );
    if (!point) return;

    onChange(buildHighlightFromPoints(dragStartRef.current, point));
  };

  const finishDrawing = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
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

function signsToText(signs) {
  if (!Array.isArray(signs)) return '';
  return signs.join('\n');
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

  const fallbackHighlight = question.region || question.highlight || { x: 35, y: 35, width: 20, height: 18 };
  const regions = Array.isArray(question.regions)
    ? question.regions
    : [fallbackHighlight];

  return {
    ...question,
    type,
    answer: {
      type,
      shuffle: question.answer?.shuffle !== false,
      options,
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
    slide?.system,
    slide?.organ,
    slide?.stain,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

function getDiagnosticValidationWarnings(diagnostic, slides) {
  const slideById = new Map(slides.map((slide) => [slide.id, slide]));
  const warnings = [];

  if (!diagnostic.title.trim()) {
    warnings.push('Укажите название диагностики.');
  }

  if (diagnostic.questions.length === 0) {
    warnings.push('Добавьте хотя бы один вопрос.');
  }

  diagnostic.questions.map(normalizeAdminQuestion).forEach((question, index) => {
    const number = index + 1;

    if (!question.prompt.trim()) {
      warnings.push(`Вопрос ${number}: не указан текст вопроса.`);
    }

    if (!question.slideId || !slideById.has(question.slideId)) {
      warnings.push(`Вопрос ${number}: выбранный препарат недоступен.`);
    }

    if (['single', 'multiple', 'combined'].includes(question.type) && question.answer.options.filter((option) => option.text.trim()).length < 2) {
      warnings.push(`Вопрос ${number}: нужно минимум два варианта ответа.`);
    }

    if (question.type === 'region' && question.regions.length === 0) {
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

function AdminPage() {
  const [slides, setSlides] = useState([]);
  const [status, setStatus] = useState('');
  const [jobProgress, setJobProgress] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [file, setFile] = useState(null);
  const [editingId, setEditingId] = useState(null);
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

  useEffect(() => {
    loadSlides().catch((error) => {
      setStatus(`Ошибка: ${error.message}`);
    });
    loadDiagnostics().catch((error) => {
      setDiagnosticStatus(`Ошибка: ${error.message}`);
    });
  }, []);

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

  const updateField = (field, value) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const resetForm = ({ clearStatus = true } = {}) => {
    setForm(INITIAL_FORM);
    setFile(null);
    setEditingId(null);
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
      system: slide.system || '',
      organ: slide.organ || '',
      stain: slide.stain || 'H&E',
      description: slide.description || '',
      diagnosticSigns: signsToText(slide.diagnosticSigns),
      selfCheckQuestions: questionsToText(slide.selfCheckQuestions),
      source: slide.source || '',
    });

    setFile(null);
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
        formData.append(key, value);
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
      index === regionIndex ? region : item
    );

    updateDiagnosticQuestion(questionIndex, {
      highlight: nextRegions[0],
      region: nextRegions[0],
      regions: nextRegions,
    });
  };

  const addQuestionRegion = (questionIndex) => {
    const question = normalizeAdminQuestion(diagnosticForm.questions[questionIndex]);
    const baseRegion =
      question.regions[Math.min(activeRegionIndex, Math.max(0, question.regions.length - 1))] ||
      question.highlight ||
      { x: 35, y: 35, width: 20, height: 18 };
    const nextRegions = [
      ...question.regions,
      {
        ...baseRegion,
        x: Math.min(95, Number(baseRegion.x || 0) + 3),
        y: Math.min(95, Number(baseRegion.y || 0) + 3),
      },
    ];

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

        <a href="/" className="adminBackLink">
          Открыть атлас
        </a>
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
      </nav>

      <main className="adminLayout">
        {activeAdminTab === 'slides' && (
        <>
        <section className="adminCard">
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
              Раздел / система
              <input
                value={form.system}
                onChange={(event) => updateField('system', event.target.value)}
                placeholder="Сердечно-сосудистая система"
              />
            </label>

            <label>
              Орган
              <input
                value={form.organ}
                onChange={(event) => updateField('organ', event.target.value)}
                placeholder="Сердце"
              />
            </label>

            <label>
              Окраска
              <input
                value={form.stain}
                onChange={(event) => updateField('stain', event.target.value)}
                placeholder="H&E"
              />
            </label>

            <label>
              Описание
              <textarea
                rows="5"
                value={form.description}
                onChange={(event) => updateField('description', event.target.value)}
                placeholder="Краткое учебное описание препарата..."
              />
            </label>

            <label>
              Диагностические признаки
              <textarea
                rows="6"
                value={form.diagnosticSigns}
                onChange={(event) =>
                  updateField('diagnosticSigns', event.target.value)
                }
                placeholder={
                  'Каждый признак с новой строки\nНекроз кардиомиоцитов\nКариолизис\nДемаркационная зона'
                }
              />
            </label>

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
                value={form.source}
                onChange={(event) => updateField('source', event.target.value)}
                placeholder="/slides/infarkt-myokardu.dzi"
              />
            </label>

            <label>
              Файл препарата: SVS / TIFF / NDPI / SCN / MRXS ZIP / DZI ZIP
              <input
                id="slideFile"
                type="file"
                accept=".svs,.tif,.tiff,.ndpi,.scn,.mrxs,.zip"
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

        <section className="adminCard">
          <h2>Список препаратов</h2>

          <div className="adminSlideList">
            {slides.map((slide) => (
              <div key={slide.id} className="adminSlideItem">
                <div>
                  <strong>{slide.title}</strong>
                  <span>
                    {slide.system || 'Без раздела'} ·{' '}
                    {slide.organ || 'Орган не указан'} ·{' '}
                    {slide.stain || 'Окраска не указана'}
                  </span>
                </div>

                <div className="adminSlideActions">
                  <button type="button" onClick={() => startEdit(slide)}>
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

            {slides.length === 0 && <p>Пока препараты не добавлены.</p>}
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
                            key={`${regionIndex}-${region.x}-${region.y}`}
                            className={regionIndex === activeRegionIndex ? 'active' : ''}
                            onClick={() => setActiveRegionIndex(regionIndex)}
                          >
                            Область {regionIndex + 1}
                          </button>
                        ))
                      ) : (
                        <span className="regionEmptyState">Области не заданы</span>
                      )}
                    </div>
                    <div className="regionActions">
                      <button
                        type="button"
                        className="adminSecondaryButton"
                        onClick={() => addQuestionRegion(activeDiagnosticQuestionIndex)}
                      >
                        Добавить область
                      </button>
                      <button
                        type="button"
                        className="adminSecondaryButton"
                        disabled={normalizeAdminQuestion(activeDiagnosticQuestion).regions.length === 0}
                        onClick={() => removeQuestionRegion(activeDiagnosticQuestionIndex, activeRegionIndex)}
                      >
                        Удалить область
                      </button>
                    </div>
                    {normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex] ? (
                      <div className="highlightGrid">
                        {['x', 'y', 'width', 'height'].map((field) => (
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

                  {activeDiagnosticSlide && normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex] ? (
                    <HighlightPicker
                      slide={activeDiagnosticSlide}
                      highlight={normalizeAdminQuestion(activeDiagnosticQuestion).regions[activeRegionIndex]}
                      onChange={(highlight) =>
                        setQuestionRegion(activeDiagnosticQuestionIndex, activeRegionIndex, highlight)
                      }
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

          <div className="adminSlideList">
            {diagnostics.map((diagnostic) => (
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
                  <button type="button" onClick={() => startDiagnosticEdit(diagnostic)}>
                    Редактировать
                  </button>
                  <button type="button" onClick={() => loadDiagnosticResults(diagnostic)}>
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

            {diagnostics.length === 0 && <p>Диагностики пока не созданы.</p>}
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
              <div className="resultsList">
                {diagnosticResults.map((result) => (
                  <button
                    type="button"
                    key={result.id}
                    className={selectedResult?.id === result.id ? 'active' : ''}
                    onClick={() => setSelectedResult(result)}
                  >
                    <strong>{result.studentName}</strong>
                    <span>{result.group} · {result.score} / {result.total} · {result.percent}%</span>
                  </button>
                ))}
                {diagnosticResults.length === 0 && <p className="adminHint">Результатов пока нет.</p>}
              </div>

              {selectedResult ? (
                <div className="resultReviewPanel">
                  <div className="resultReviewHeader">
                    <div>
                      <h3>{selectedResult.studentName}</h3>
                      <p>{selectedResult.group} · {selectedResult.submittedAt}</p>
                    </div>
                    <strong>{selectedResult.score} / {selectedResult.total} ({selectedResult.percent}%)</strong>
                  </div>

                  {(selectedResult.answers || []).map((answer, index) => (
                    <div key={answer.questionId} className="answerReviewItem">
                      <div>
                        <strong>Вопрос {index + 1}</strong>
                        <span>{answer.type} · авто: {answer.isCorrect ? 'верно' : 'не верно'}</span>
                      </div>
                      <p>Ответ: {formatReviewAnswer(answer)}</p>
                      {(answer.correctOptions?.length > 0 || answer.correctText || answer.correctOption) && (
                        <p>Эталон: {answer.correctOptions?.join('; ') || answer.correctText || answer.correctOption}</p>
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
                  ))}

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
      </main>
    </div>
  );
}

export default AdminPage;
