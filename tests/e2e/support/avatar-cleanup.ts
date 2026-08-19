function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ownedAvatarFileName(
  userId: string,
  candidate: string,
  fixtureUserIds: ReadonlySet<string>
): string | undefined {
  if (!fixtureUserIds.has(userId)) return undefined;
  const pattern = new RegExp(
    `^${escapeRegularExpression(userId)}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`
  );
  return pattern.test(candidate) ? candidate : undefined;
}
