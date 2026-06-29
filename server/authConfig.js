export const ROLE_PERMISSIONS = {
  admin: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: true, canEditSlideCards: true, canDeleteSlideCards: true, canUploadSlides: true, canEditSlides: true, canDeleteSlides: true, canCreateDiagnostics: true, canEditOwnDiagnostics: true, canEditAllDiagnostics: true, canDeleteDiagnostics: true, canViewResults: true, canGradeResults: true, canManageTeachers: true, canManageUsers: true, canManageRoles: true, canManageMoodle: true, canManageLti: true, canSendGradesToMoodle: true },
  teacher_full: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: true, canEditSlideCards: true, canDeleteSlideCards: true, canUploadSlides: true, canEditSlides: true, canDeleteSlides: true, canCreateDiagnostics: true, canEditOwnDiagnostics: true, canEditAllDiagnostics: true, canDeleteDiagnostics: true, canViewResults: true, canGradeResults: true, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
  teacher_limited: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: false, canEditSlideCards: false, canDeleteSlideCards: false, canUploadSlides: false, canEditSlides: false, canDeleteSlides: false, canCreateDiagnostics: true, canEditOwnDiagnostics: true, canEditAllDiagnostics: false, canDeleteDiagnostics: false, canViewResults: true, canGradeResults: true, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
  resident: { canViewSlides: true, canViewSlideCards: false, canViewSlideDescriptions: false, canCreateSlideCards: false, canEditSlideCards: false, canDeleteSlideCards: false, canUploadSlides: false, canEditSlides: false, canDeleteSlides: false, canCreateDiagnostics: false, canEditOwnDiagnostics: false, canEditAllDiagnostics: false, canDeleteDiagnostics: false, canViewResults: false, canGradeResults: false, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
  student: { canViewSlides: true, canViewSlideCards: true, canViewSlideDescriptions: true, canCreateSlideCards: false, canEditSlideCards: false, canDeleteSlideCards: false, canUploadSlides: false, canEditSlides: false, canDeleteSlides: false, canCreateDiagnostics: false, canEditOwnDiagnostics: false, canEditAllDiagnostics: false, canDeleteDiagnostics: false, canViewResults: false, canGradeResults: false, canManageTeachers: false, canManageUsers: false, canManageRoles: false, canManageMoodle: false, canManageLti: false, canSendGradesToMoodle: false },
};

export const USER_ROLES = Object.keys(ROLE_PERMISSIONS);

export function normalizeRole(role, fallback = 'student') {
  return USER_ROLES.includes(role) ? role : fallback;
}

export function normalizePermissionOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.keys(ROLE_PERMISSIONS.admin)
      .filter((key) => typeof value[key] === 'boolean')
      .map((key) => [key, value[key]])
  );
}

export function permissionsForRole(role, overrides = {}) {
  return {
    ...(ROLE_PERMISSIONS[normalizeRole(role)] || ROLE_PERMISSIONS.student),
    ...normalizePermissionOverrides(overrides),
  };
}
