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
  selector?: string;
  controlLabel?: string;
  paragraphText?: string;
  listItemText?: string;
  paragraphInteractiveCount?: number;
  paragraphArtifactLabelCount?: number;
  paragraphOtherTextLength?: number;
  listItemInteractiveCount?: number;
  listItemArtifactLabelCount?: number;
  focusableInteractiveCount?: number;
  focusableArtifactLabelCount?: number;
  focusableOtherTextLength?: number;
  fromResponseTextLabel?: boolean;
}

export interface StructuralArtifactCandidate {
  label: string;
  selector?: string;
  controlLabel?: string;
}

export interface StructuralArtifactCandidatePartition {
  confirmed: StructuralArtifactCandidate[];
  suspicious: StructuralArtifactCandidate[];
}

export function parseSnapshotEntries(snapshot: string): SnapshotEntry[];
export function extractArtifactLabels(value: string): string[];
export function filterStructuralArtifactCandidates(
  candidates: StructuralArtifactCandidateInput[],
): StructuralArtifactCandidate[];
export function partitionStructuralArtifactCandidates(
  candidates: StructuralArtifactCandidateInput[],
): StructuralArtifactCandidatePartition;
