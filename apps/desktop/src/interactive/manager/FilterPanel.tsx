import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Clickable, HoverText } from "../mouse/MouseProvider.tsx";
import { COLORS } from "../theme.ts";
import { KIND_ICONS, ORIGIN_ICONS, STATUS_STYLE } from "./icons.ts";
import {
  type Filters,
  KIND_LABELS,
  KINDS,
  ORIGIN_LABELS,
  ORIGINS,
  STATUS_FILTER_LABELS,
  STATUS_FILTERS,
} from "./model.ts";

interface Option {
  label: string;
  /** Two cells wide, so the labels of a column line up. */
  icon: string;
  color?: string;
  on: (f: Filters) => boolean;
  toggle: (f: Filters) => Filters;
}

interface Group {
  name: string;
  options: Option[];
}

const toggled = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

const GROUPS: Group[] = [
  {
    name: "Status",
    options: STATUS_FILTERS.map((value) => ({
      label: STATUS_FILTER_LABELS[value],
      ...STATUS_STYLE[value],
      on: (f) => f.statuses.includes(value),
      toggle: (f) => ({ ...f, statuses: toggled(f.statuses, value) }),
    })),
  },
  {
    name: "Type",
    options: KINDS.map((value) => ({
      label: KIND_LABELS[value],
      icon: KIND_ICONS[value],
      color: COLORS.accent,
      on: (f) => f.types.includes(value),
      toggle: (f) => ({ ...f, types: toggled(f.types, value) }),
    })),
  },
  {
    name: "Origin",
    options: ORIGINS.map((value) => ({
      label: ORIGIN_LABELS[value],
      icon: ORIGIN_ICONS[value],
      color: COLORS.accent,
      on: (f) => f.origins.includes(value),
      toggle: (f) => ({ ...f, origins: toggled(f.origins, value) }),
    })),
  },
];

/** The keys of this page, for the key bar while it is open. */
export const FILTER_KEYS: [string, string][] = [
  ["←→", "Group"],
  ["↑↓", "Option"],
  ["Space", "Toggle"],
  ["Enter", "Done"],
  ["Esc", "Close"],
];

/** Every column is as wide as the widest option, plus a gap: "> [ ] ►♪ Video only". */
const COLUMN_WIDTH = Math.max(...GROUPS.flatMap((g) => g.options.map((o) => o.label.length))) + 11;

export interface FilterPanelProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  onClose: () => void;
}

/**
 * Status, type and origin filters, combined with AND: one column per group. ←→ picks
 * the group, ↑↓ the option, Space toggles. Changes apply as they are made.
 */
export function FilterPanel({ filters, onChange, onClose }: FilterPanelProps) {
  const [group, setGroup] = useState(0);
  const [picks, setPicks] = useState(() => GROUPS.map(() => 0));
  const current = GROUPS[group] as Group;
  const pick = picks[group] ?? 0;
  const movePick = (by: number) =>
    setPicks((p) =>
      p.map((v, i) =>
        i === group ? Math.max(0, Math.min(current.options.length - 1, v + by)) : v,
      ),
    );

  useInput((input, key) => {
    if (key.leftArrow) setGroup((g) => Math.max(0, g - 1));
    else if (key.rightArrow) setGroup((g) => Math.min(GROUPS.length - 1, g + 1));
    else if (key.upArrow) movePick(-1);
    else if (key.downArrow) movePick(1);
    else if (input === " ") {
      const option = current.options[pick];
      if (option) onChange(option.toggle(filters));
    } else if (key.return || key.escape || input === "f") onClose();
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.accent}>
          Filter
        </Text>
      </Box>
      <Box>
        {GROUPS.map((g, gi) => (
          <Box key={g.name} flexDirection="column" width={COLUMN_WIDTH} flexShrink={0}>
            <Clickable onClick={() => setGroup(gi)} paddingLeft={2}>
              <HoverText bold={gi === group} color={gi === group ? COLORS.accent : COLORS.muted}>
                {g.name}
              </HoverText>
            </Clickable>
            <Text color={COLORS.muted}>{`  ${"─".repeat(g.name.length)}`}</Text>
            {g.options.map((option, oi) => {
              const on = option.on(filters);
              const mark = on ? "[x]" : "[ ]";
              const here = gi === group && oi === (picks[gi] ?? 0);
              return (
                <Clickable
                  key={option.label}
                  onClick={() => {
                    setGroup(gi);
                    setPicks((p) => p.map((v, i) => (i === gi ? oi : v)));
                    onChange(option.toggle(filters));
                  }}
                >
                  {/* The table's cursor: a > before the option, no highlight. */}
                  <Text color={COLORS.accent}>{here ? "> " : "  "}</Text>
                  <HoverText>
                    <Text color={on ? COLORS.accent : undefined}>{mark}</Text>
                    <Text color={option.color}>{` ${option.icon.padEnd(2)}`}</Text>
                    {` ${option.label}`}
                  </HoverText>
                </Clickable>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
