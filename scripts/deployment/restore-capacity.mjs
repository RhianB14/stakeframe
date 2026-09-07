export function restoreDiskReady(stat, starting = false) {
  const free = stat.bavail * stat.bsize;
  const percent = stat.blocks > 0n ? (stat.bavail * 100n) / stat.blocks : 0n;
  return free >= (starting ? 10n : 5n) * 1024n ** 3n && percent >= (starting ? 20n : 10n);
}
