export async function runCleanupAndClose(
  cleanup: () => Promise<void>,
  close: () => Promise<void>
): Promise<void> {
  const failures: unknown[] = [];
  try {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  } finally {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Test cleanup and app close both failed');
  }
}
