/**
 * A comparable key for a project directory (F14): forward slashes, no
 * duplicate or trailing slash, lowercased where the file system ignores
 * case (Windows). The caller passes an absolute path; resolving is the
 * adapters' job.
 */
export function projectKey(path: string, caseInsensitive: boolean): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

/** True when `key` is the project `project` or a directory inside it. */
export function isWithinProject(project: string, key: string): boolean {
  if (key === project) return true
  const prefix = project.endsWith('/') ? project : `${project}/`
  return key.startsWith(prefix)
}
