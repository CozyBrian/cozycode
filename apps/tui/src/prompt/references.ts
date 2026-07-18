import { rankFileReferences, type RankOptions, type RankedSuggestion } from "@cozycode/commands";
import type {
  WorkspaceReferenceCandidate,
  WorkspaceReferenceIndex,
} from "@cozycode/core/workspace-references";

export * from "@cozycode/core/workspace-references";

export function searchWorkspaceReferenceCandidates(
  index: WorkspaceReferenceIndex,
  query: string,
  options: RankOptions = {},
): RankedSuggestion<WorkspaceReferenceCandidate>[] {
  return rankFileReferences(index.candidates, query, options);
}
