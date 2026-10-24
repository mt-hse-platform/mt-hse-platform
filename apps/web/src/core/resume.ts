// "Resume unfinished inspection": which of the server's in-progress inspections the home screen offers to continue.
import type { InspectionDto } from './types.ts';

/** My own unfinished inspections, newest first. Other people's drafts are theirs to continue. */
export function pickResumable(items: InspectionDto[], userId: string, max = 5): InspectionDto[] {
  return items
    .filter((i) => i.status === 'in_progress' && i.startedBy === userId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, max));
}
