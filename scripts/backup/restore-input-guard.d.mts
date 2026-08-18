export interface SnapshotSource {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  readable(): AsyncIterable<Buffer>;
}

export interface SnapshotDestination {
  write(buffer: Buffer): Promise<unknown>;
  sync(): Promise<unknown>;
}

export interface AvatarArchiveLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
}

export function copyOpenRegularFile(
  source: SnapshotSource,
  destination: SnapshotDestination,
  maximumBytes: number
): Promise<number>;
export function snapshotRegularFile(source: string, destination: string, maximumBytes: number): Promise<number>;
export function validateAvatarArchive(
  archive: string,
  limits: AvatarArchiveLimits
): Promise<{ entries: number; files: number; totalBytes: number }>;
