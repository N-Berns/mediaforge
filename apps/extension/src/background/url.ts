const withoutHash = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
};

/**
 * True when a tab's URL moved only within the same document (an SPA hash route), so its sniffed
 * candidates and probe still belong to the page.
 */
export function isHashOnlyChange(previous: string | undefined, next: string): boolean {
  if (previous === undefined || previous === next) return false;
  const before = withoutHash(previous);
  return before !== undefined && before === withoutHash(next);
}
