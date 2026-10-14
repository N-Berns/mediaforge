const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const INSET = 8;

/** The button text after a click, from the background's download status. */
export function labelFor(status: string | undefined): string {
  switch (status) {
    case "started":
      return "Started";
    case "needs-picker":
      return "Pick quality in the toolbar popup";
    case "nothing":
      return "Nothing found";
    default:
      return "Failed";
  }
}

export function isWorthOverlay(rect: { width: number; height: number }, hidden: boolean): boolean {
  return !hidden && rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
}

/** Top-right corner of the element, inset a little, in document coordinates. */
export function placeButton(
  rect: { top: number; left: number; width: number; height: number },
  scroll: { x: number; y: number },
  button: { width: number; height: number },
): { top: number; left: number } {
  return {
    top: rect.top + scroll.y + INSET,
    left: rect.left + scroll.x + rect.width - button.width - INSET,
  };
}

/** Index of the first video or audio in an ordered list of elements, if any. */
export function findMediaIndex(elements: ReadonlyArray<{ tagName?: string }>): number | undefined {
  const index = elements.findIndex((el) => {
    const tag = el.tagName?.toUpperCase();
    return tag === "VIDEO" || tag === "AUDIO";
  });
  return index === -1 ? undefined : index;
}
