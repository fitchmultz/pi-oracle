export interface SnapshotEntry {
  line: string;
  lineIndex: number;
  ref: string;
  kind?: string;
  label?: string;
  value?: string;
  disabled: boolean;
}

export interface StructuralArtifactCandidateInput {
  label?: string;
  paragraphText?: string;
  listItemText?: string;
  paragraphFileButtonCount?: number;
  paragraphOtherTextLength?: number;
  listItemFileButtonCount?: number;
  focusableFileButtonCount?: number;
  focusableOtherTextLength?: number;
}

export interface StructuralArtifactCandidate {
  label: string;
}

export function parseSnapshotEntries(snapshot: string): SnapshotEntry[];
export function filterStructuralArtifactCandidates(
  candidates: StructuralArtifactCandidateInput[],
): StructuralArtifactCandidate[];
