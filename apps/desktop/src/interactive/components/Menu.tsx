import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Clickable, HoverText } from "../mouse/MouseProvider.tsx";
import { COLORS, ICONS } from "../theme.ts";
import { useEnterLock } from "./use-enter-lock.ts";

export interface MenuItem<T> {
  value: T;
  label: string;
  icon?: string;
  /** Dim text after the label. */
  hint?: string;
  disabled?: boolean;
  /** A non-selectable title row that groups the rows after it. Set `disabled` too. */
  heading?: boolean;
  /** A thin line between two groups of rows. Not selectable, and it gets no number. */
  divider?: boolean;
}

/** A divider row. `value` is never selected, so any placeholder of the menu's value type works. */
export const dividerItem = <T,>(value: T): MenuItem<T> => ({
  value,
  label: "",
  divider: true,
  disabled: true,
});

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
  /** Called with the highlighted value, first on mount and then on every move. */
  onHighlight?: (value: T) => void;
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
/** Menus with more rows than this have no number keys, so no number labels. */
const MAX_NUMBERED = 9;

export function Menu<T>({
  items,
  onSelect,
  onBack,
  initial,
  maxVisible = 12,
  isActive = true,
  onHighlight,
}: MenuProps<T>) {
  const firstEnabled = Math.max(
    0,
    items.findIndex((i) => !i.disabled),
  );
  const [index, setIndex] = useState(() => {
    const at = initial === undefined ? -1 : items.findIndex((i) => i.value === initial);
    return at >= 0 && !items[at]?.disabled ? at : firstEnabled;
  });
  const highlighted = items[index]?.value;
  useEffect(() => {
    if (highlighted !== undefined) onHighlight?.(highlighted);
  }, [highlighted, onHighlight]);

  const claim = useEnterLock();
  /** The number key of each row: dividers are skipped, so the numbers have no gaps. */
  const numberOf = items.map((item, at) =>
    item.divider ? undefined : items.slice(0, at + 1).filter((i) => !i.divider).length,
  );
  /** Number keys select a row only in short menus. */
  const numbered = items.filter((i) => !i.divider).length <= MAX_NUMBERED;

  const select = (item: MenuItem<T> | undefined) => {
    if (item && !item.disabled && claim()) onSelect(item.value);
  };

  useInput(
    (input, key) => {
      if (key.upArrow) setIndex((i) => stepIndex(items, i, -1));
      else if (key.downArrow) setIndex((i) => stepIndex(items, i, 1));
      else if (key.return) select(items[index]);
      else if (key.escape || key.leftArrow) onBack?.();
      else if (/^[1-9]$/.test(input) && numbered) {
        select(items.find((_, at) => numberOf[at] === Number(input)));
      }
    },
    { isActive },
  );

  const rows = items.map((item, position) => ({ item, position }));
  const { start, end } = visibleWindow(index, items.length, maxVisible);
  const labelWidth = Math.min(LABEL_CAP, Math.max(...items.map((i) => i.label.length), 0));

  return (
    <Clickable
      flexDirection="column"
      active={isActive}
      onWheel={(step) => setIndex((i) => stepIndex(items, i, step))}
    >
      {start > 0 && (
        <Text color={COLORS.muted}>
          {"  "}
          {ICONS.warn} {start} more above
        </Text>
      )}
      {rows.slice(start, end).map(({ item, position }) => {
        if (item.divider) {
          return (
            <Box key={position}>
              <Text color={COLORS.muted}>
                {"  "}
                {numbered ? "  " : ""}
                {"─".repeat(Math.max(8, labelWidth + 2))}
              </Text>
            </Box>
          );
        }
        const selected = position === index;
        const color = item.heading
          ? COLORS.accent
          : item.disabled
            ? COLORS.muted
            : selected
              ? COLORS.accent
              : undefined;
        return (
          <Clickable
            key={position}
            active={isActive && !item.disabled}
            onClick={(click) => {
              if (item.disabled) return;
              // The first click can scroll the list, so the second press of a double-click
              // may land on another row: only the row already highlighted is picked.
              if (click.double && position === index) select(item);
              else setIndex(position);
            }}
          >
            <Text color={COLORS.accent}>{selected ? `${ICONS.cursor} ` : "  "}</Text>
            {numbered ? (
              <Text color={selected ? COLORS.accent : COLORS.muted}>
                {item.disabled ? "  " : `${numberOf[position]} `}
              </Text>
            ) : null}
            <HoverText
              color={color}
              bold={selected || item.heading}
              dimColor={item.disabled && !item.heading}
            >
              {item.icon ? `${item.icon} ` : ""}
              {item.label.padEnd(labelWidth)}
            </HoverText>
            {item.hint ? <Text color={COLORS.muted}>{`  ${item.hint}`}</Text> : null}
          </Clickable>
        );
      })}
      {end < items.length && (
        <Text color={COLORS.muted}>
          {"  "}
          {ICONS.download} {items.length - end} more below
        </Text>
      )}
    </Clickable>
  );
}
