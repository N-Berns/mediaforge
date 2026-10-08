import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { COLORS, ICONS } from "../theme.ts";

export interface MenuItem<T> {
  value: T;
  label: string;
  icon?: string;
  /** Dim text after the label. */
  hint?: string;
  disabled?: boolean;
  /** A non-selectable title row that groups the rows after it. Set `disabled` too. */
  heading?: boolean;
}

export interface MenuProps<T> {
  items: MenuItem<T>[];
  onSelect: (value: T) => void;
  /** Called on Esc or the left arrow. */
  onBack?: () => void;
  /** Value to highlight first. Defaults to the first enabled item. */
  initial?: T;
  /** How many rows to show before scrolling. */
  maxVisible?: number;
  isActive?: boolean;
}

/** Which slice of a long list to show so the selected row stays visible. */
export function visibleWindow(index: number, total: number, size: number) {
  if (total <= size) return { start: 0, end: total };
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), total - size);
  return { start, end: start + size };
}

/** Next enabled index in a direction, wrapping around. Returns `from` if none is enabled. */
export function stepIndex(
  items: readonly { disabled?: boolean }[],
  from: number,
  direction: 1 | -1,
): number {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const candidate = (from + direction * i + n * i) % n;
    if (!items[candidate]?.disabled) return candidate;
  }
  return from;
}

const LABEL_CAP = 34;

export function Menu<T>({
  items,
  onSelect,
  onBack,
  initial,
  maxVisible = 12,
  isActive = true,
}: MenuProps<T>) {
  const firstEnabled = Math.max(
    0,
    items.findIndex((i) => !i.disabled),
  );
  const [index, setIndex] = useState(() => {
    const at = initial === undefined ? -1 : items.findIndex((i) => i.value === initial);
    return at >= 0 && !items[at]?.disabled ? at : firstEnabled;
  });

  useInput(
    (input, key) => {
      if (key.upArrow) setIndex((i) => stepIndex(items, i, -1));
      else if (key.downArrow) setIndex((i) => stepIndex(items, i, 1));
      else if (key.return) {
        const item = items[index];
        if (item && !item.disabled) onSelect(item.value);
      } else if (key.escape || key.leftArrow) onBack?.();
      else if (/^[1-9]$/.test(input) && items.length <= 9) {
        const item = items[Number(input) - 1];
        if (item && !item.disabled) onSelect(item.value);
      }
    },
    { isActive },
  );

  const rows = items.map((item, position) => ({ item, position }));
  const { start, end } = visibleWindow(index, items.length, maxVisible);
  const labelWidth = Math.min(LABEL_CAP, Math.max(...items.map((i) => i.label.length), 0));

  return (
    <Box flexDirection="column">
      {start > 0 && (
        <Text color={COLORS.muted}>
          {"  "}
          {ICONS.warn} {start} more above
        </Text>
      )}
      {rows.slice(start, end).map(({ item, position }) => {
        const selected = position === index;
        const color = item.heading
          ? COLORS.accent
          : item.disabled
            ? COLORS.muted
            : selected
              ? COLORS.accent
              : undefined;
        return (
          <Box key={position}>
            <Text color={COLORS.accent}>{selected ? `${ICONS.pointer} ` : "  "}</Text>
            <Text
              color={color}
              bold={selected || item.heading}
              dimColor={item.disabled && !item.heading}
            >
              {item.icon ? `${item.icon} ` : ""}
              {item.label.padEnd(labelWidth)}
            </Text>
            {item.hint ? <Text color={COLORS.muted}>{`  ${item.hint}`}</Text> : null}
          </Box>
        );
      })}
      {end < items.length && (
        <Text color={COLORS.muted}>
          {"  "}
          {ICONS.download} {items.length - end} more below
        </Text>
      )}
    </Box>
  );
}
