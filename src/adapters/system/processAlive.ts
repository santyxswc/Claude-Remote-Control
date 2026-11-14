/**
 * Whether a process with this pid exists, on Windows and Unix alike. Signal 0
 * only checks existence; EPERM means it exists but belongs to someone else.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
