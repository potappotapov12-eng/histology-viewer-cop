export const INITIAL_FORM = {
  id: '',
  title: '',
  lesson: '',
  system: '',
  organ: '',
  stain: 'H&E',
  description: '',
  diagnosticSigns: [],
  selfCheckQuestions: '',
  source: '',
  courseIds: [],
  groupIds: [],
  visibleForStudents: true,
  visibleForResidents: false,
};

export const INITIAL_DIAGNOSTIC_FORM = {
  id: '',
  title: '',
  startsAt: '',
  endsAt: '',
  durationMinutes: '',
  isPublished: true,
  courseIds: [],
  groupIds: [],
  questions: [],
};

export const DEFAULT_REGION_THRESHOLD = 70;
export const DIAGNOSTIC_DRAFT_KEY = 'histology-viewer-diagnostic-draft';
const DIAGNOSTIC_TIME_ZONE = 'Asia/Yekaterinburg';
export const DIAGNOSTIC_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  timeZone: DIAGNOSTIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const ROLE_LABELS = {
  admin: 'Администратор',
  teacher_full: 'Преподаватель с полным доступом',
  teacher_limited: 'Преподаватель с ограниченным доступом',
  resident: 'Ординатор',
  student: 'Студент',
};

export const ROLE_DESCRIPTIONS = {
  admin: 'Полный доступ к управлению сайтом, препаратами, диагностикой, пользователями и настройками.',
  teacher_full: 'Может добавлять, редактировать и удалять препараты, создавать диагностики и проверять результаты.',
  teacher_limited: 'Может смотреть препараты, создавать диагностики и проверять результаты, но не может управлять препаратами.',
  resident: 'Видит только обезличенный просмотрщик препаратов без названий и описаний.',
  student: 'Может смотреть доступные препараты и проходить диагностики без доступа к админке.',
};

export const USER_ROLE_OPTIONS = ['teacher_full', 'teacher_limited', 'resident', 'student'];

export const PERMISSION_LABELS = {
  canCreateSlideCards: 'Создание карточек препаратов',
  canEditSlideCards: 'Редактирование карточек препаратов',
  canDeleteSlideCards: 'Удаление карточек препаратов',
  canUploadSlides: 'Загрузка препаратов',
  canEditSlides: 'Редактирование препаратов',
  canDeleteSlides: 'Удаление препаратов',
  canCreateDiagnostics: 'Создание диагностик',
  canEditOwnDiagnostics: 'Редактирование своих диагностик',
  canEditAllDiagnostics: 'Редактирование всех диагностик',
  canDeleteDiagnostics: 'Удаление диагностик',
  canViewResults: 'Просмотр результатов',
  canGradeResults: 'Проверка результатов',
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS);

export const ROLE_PERMISSION_PRESETS = {
  admin: PERMISSION_KEYS.reduce((permissions, key) => ({ ...permissions, [key]: true }), {}),
  teacher_full: PERMISSION_KEYS.reduce((permissions, key) => ({ ...permissions, [key]: true }), {}),
  teacher_limited: {
    canCreateSlideCards: false,
    canEditSlideCards: false,
    canDeleteSlideCards: false,
    canUploadSlides: false,
    canEditSlides: false,
    canDeleteSlides: false,
    canCreateDiagnostics: true,
    canEditOwnDiagnostics: true,
    canEditAllDiagnostics: false,
    canDeleteDiagnostics: false,
    canViewResults: true,
    canGradeResults: true,
  },
  resident: PERMISSION_KEYS.reduce((permissions, key) => ({ ...permissions, [key]: false }), {}),
  student: PERMISSION_KEYS.reduce((permissions, key) => ({ ...permissions, [key]: false }), {}),
};

export const PERMISSION_GROUPS = [
  {
    title: 'Карточки препаратов',
    permissions: ['canCreateSlideCards', 'canEditSlideCards', 'canDeleteSlideCards'],
  },
  {
    title: 'Препараты',
    permissions: ['canUploadSlides', 'canEditSlides', 'canDeleteSlides'],
  },
  {
    title: 'Диагностики',
    permissions: ['canCreateDiagnostics', 'canEditOwnDiagnostics', 'canEditAllDiagnostics', 'canDeleteDiagnostics'],
  },
  {
    title: 'Результаты',
    permissions: ['canViewResults', 'canGradeResults'],
  },
];

export function createEmptyUserForm() {
  return {
    id: null,
    login: '',
    email: '',
    fullName: '',
    password: '',
    role: 'teacher_limited',
    isActive: true,
    permissionOverrides: {},
  };
}

export const IMPORT_FIELD_ALIASES = {
  id: 'id',
  идентификатор: 'id',
  title: 'title',
  название: 'title',
  lesson: 'lesson',
  занятие: 'lesson',
  system: 'system',
  раздел: 'system',
  organ: 'organ',
  орган: 'organ',
  stain: 'stain',
  окраска: 'stain',
  source: 'source',
  'dzi-адрес': 'source',
  description: 'description',
  описание: 'description',
  diagnosticsigns: 'diagnosticSigns',
  'диагностические признаки': 'diagnosticSigns',
  selfcheckquestions: 'selfCheckQuestions',
  'вопросы для самопроверки': 'selfCheckQuestions',
};
