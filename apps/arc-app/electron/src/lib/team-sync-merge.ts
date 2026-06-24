export type TeamCapsuleRecord = Record<string, unknown>;

export interface TeamCapsuleMergeResult {
  capsules: TeamCapsuleRecord[];
  pulled: number;
  skipped: number;
}

export function mergePulledCapsules(
  localCapsules: TeamCapsuleRecord[],
  remoteCapsules: TeamCapsuleRecord[],
): TeamCapsuleMergeResult {
  const byId = new Map(localCapsules.filter(hasStringId).map((capsule) => [capsule.id, capsule]));
  const mergeIndex = new Map<string, string>();
  for (const capsule of localCapsules) {
    if (!hasStringId(capsule)) continue;
    const key = localMergeKey(capsule);
    if (key) mergeIndex.set(key, capsule.id);
  }
  let pulled = 0;
  let skipped = 0;

  for (const capsule of remoteCapsules) {
    if (!hasStringId(capsule)) {
      skipped += 1;
      continue;
    }

    const key = localMergeKey(capsule);
    const existingId = byId.has(capsule.id)
      ? capsule.id
      : key
        ? mergeIndex.get(key)
        : undefined;
    const existing = existingId ? byId.get(existingId) : undefined;
    const remoteUpdatedAt = typeof capsule.updatedAt === "string" ? Date.parse(capsule.updatedAt) : 0;
    const localUpdatedAt = typeof existing?.updatedAt === "string" ? Date.parse(existing.updatedAt) : 0;
    if (existing && Number.isFinite(localUpdatedAt) && localUpdatedAt >= remoteUpdatedAt) {
      skipped += 1;
      continue;
    }

    if (existingId && existingId !== capsule.id) byId.delete(existingId);
    byId.set(capsule.id, capsule);
    if (key) mergeIndex.set(key, capsule.id);
    pulled += 1;
  }

  return {
    capsules: [...byId.values()],
    pulled,
    skipped,
  };
}

function hasStringId(value: TeamCapsuleRecord): value is TeamCapsuleRecord & { id: string } {
  return typeof value.id === "string" && value.id.length > 0;
}

function localMergeKey(value: TeamCapsuleRecord): string | null {
  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  const mergeKey = typeof value.mergeKey === "string" ? value.mergeKey.trim().toLowerCase() : "";
  if (!kind || !mergeKey) return null;
  return `${kind}:${mergeKey}`;
}
