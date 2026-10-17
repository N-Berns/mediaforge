import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Clickable, HoverText } from "../mouse/MouseProvider.tsx";
import { COLORS } from "../theme.ts";
import {
  type Filters,
  LAST_TRY_FILTERS,
  LAST_TRY_LABELS,
  ORIGIN_LABELS,
  ORIGINS,
  STATUS_FILTER_LABELS,
  STATUS_FILTERS,
} from "./model.ts";

interface Group {
  name: string;
  /** Last try picks one; the others toggle each option. */
  radio: boolean;
  options: { label: string; on: (f: Filters) => boolean; toggle: (f: Filters) => Filters }[];
}

const toggled = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

const GROUPS: Group[] = [
  {
    name: "Status",
    radio: false,
    options: STATUS_FILTERS.map((value) => ({
      label: STATUS_FILTER_LABELS[value],
      on: (f) => f.statuses.includes(value),
      toggle: (f) => ({ ...f, statuses: toggled(f.statuses, value) }),
    })),
  },
  {
    name: "Origin",
    radio: false,
    options: ORIGINS.map((value) => ({
      label: ORIGIN_LABELS[value],
      on: (f) => f.origins.includes(value),
      toggle: (f) => ({ ...f, origins: toggled(f.origins, value) }),
    })),
  },
  {
    name: "Last try",
    radio: true,
    options: LAST_TRY_FILTERS.map((value) => ({
      label: LAST_TRY_LABELS[value],
      on: (f) => f.lastTry === value,
      toggle: (f) => ({ ...f, lastTry: value }),
    })),
  },
];

const GROUP_WIDTH = 10;

export interface FilterPanelProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  onClose: () => void;
}

/**
 * Status, origin and last-try filters, combined with AND: one line per group. ↑↓ picks the
 * group, ←→ the option, Space toggles. Changes apply as they are made.
 */
export function FilterPanel({ filters, onChange, onClose }: FilterPanelProps) {
  const [row, setRow] = useState(0);
  const [cols, setCols] = useState(() => GROUPS.map(() => 0));
  const group = GROUPS[row] as Group;
  const col = cols[row] ?? 0;
  const moveCol = (by: number) =>
    setCols((c) =>
      c.map((v, i) => (i === row ? Math.max(0, Math.min(group.options.length - 1, v + by)) : v)),
    );

  useInput((input, key) => {
    if (key.upArrow) setRow((r) => Math.max(0, r - 1));
    else if (key.downArrow) setRow((r) => Math.min(GROUPS.length - 1, r + 1));
    else if (key.leftArrow) moveCol(-1);
    else if (key.rightArrow) moveCol(1);
    else if (input === " ") {
      const option = group.options[col];
      if (option) onChange(option.toggle(filters));
    } else if (key.return || key.escape || input === "f") onClose();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={COLORS.accent}>
        Filter
      </Text>
      {GROUPS.map((g, gi) => (
        <Box key={g.name} overflow="hidden">
          <Clickable width={GROUP_WIDTH} flexShrink={0} onClick={() => setRow(gi)}>
            <HoverText color={gi === row ? COLORS.accent : COLORS.muted}>{g.name}</HoverText>
          </Clickable>
          {g.options.map((option, oi) => {
            const on = option.on(filters);
            const mark = g.radio ? (on ? "(•)" : "( )") : on ? "[x]" : "[ ]";
            const here = gi === row && oi === (cols[gi] ?? 0);
            return (
              <Clickable
                key={option.label}
                flexShrink={0}
                onClick={() => {
                  setRow(gi);
                  setCols((c) => c.map((v, i) => (i === gi ? oi : v)));
                  onChange(option.toggle(filters));
                }}
              >
                <HoverText {...(here && { inverse: true })}>{`${mark} ${option.label}`}</HoverText>
                {oi < g.options.length - 1 ? <Text>{"  "}</Text> : null}
              </Clickable>
            );
          })}
        </Box>
      ))}
      <Text color={COLORS.muted}>↑↓ group · ←→ option · Space toggle · Enter or Esc close</Text>
    </Box>
  );
}
