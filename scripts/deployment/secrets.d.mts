export function assertSecretDirectoryPlatform(mode: number, platform: string): number;
export function inspectSecretDirectories(
  directories: Iterable<string>,
  options?: {
    platform?: string;
    lstat?: (path: string) => Promise<{ isDirectory(): boolean; mode: number }>;
  },
): Promise<Map<string, number>>;
