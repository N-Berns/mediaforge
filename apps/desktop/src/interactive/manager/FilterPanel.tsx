import { Box, Text, useInput } from "ink";
import { useState } from "react";
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

type Option =
  | { group: "Status"; value: (typeof STATUS_FILTERS)[number] }
  | { group: "Origin"; value: (typeof ORIGINS)[number] }
  | { group: "Last try"; value: (typeof LAST_TRY_FILTERS)[number] };

const OPTIONS: Option[] = [
  ...STATUS_FILTERS.map((value) => ({ group: "Status" as const, value })),
  ...ORIGINS.map((value) => ({ group: "Origin" as const, value })),
  ...LAST_TRY_FILTERS.map((value) => ({ group: "Last try" as const, value })),
];

const labelOf = (option: Option) =>
  option.group === "Status"
    ? STATUS_FILTER_LABELS[option.value]
    : option.group === "Origin"
      ? ORIGIN_LABELS[option.value]
      : LAST_TRY_LABELS[option.value];

const isOn = (option: Option, filters: Filters) =>
  option.group === "Status"
    ? filters.statuses.includes(option.value)
    : option.group === "Origin"
      ? filters.origins.includes(option.value)
      : filters.lastTry === option.value;

const toggled = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

function toggle(option: Option, filters: Filters): Filters {
  if (option.group === "Status") {
    return { ...filters, statuses: toggled(filters.statuses, option.value) };
  }
  if (option.group === "Origin") {
    return { ...filters, origins: toggled(filters.origins, option.value) };
  }
  return { ...filters, lastTry: option.value };
}

export interface FilterPanelProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  onClose: () => void;
}

/** Status, origin and last-try filters, combined with AND. Changes apply as they are made. */
export function FilterPanel({ filters, onChange, onClose }: FilterPanelProps) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
    else if (input === " ") {
      const option = OPTIONS[index];
      if (option) onChange(toggle(option, filters));
    } else if (key.return || key.escape || input === "f") onClose();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={COLORS.accent}>
        Filter
      </Text>
      {OPTIONS.map((option, i) => {
        const first = i === 0 || OPTIONS[i - 1]?.group !== option.group;
        const radio = option.group === "Last try";
        const mark = isOn(option, filters) ? (radio ? "(•)" : "[x]") : radio ? "( )" : "[ ]";
        return (
          <Box key={`${option.group}-${option.value}`} flexDirection="column">
            {first ? <Text color={COLORS.muted}>{option.group}</Text> : null}
            <Text {...(i === index && { color: COLORS.accent })}>
              {`${i === index ? ">" : " "} ${mark} ${labelOf(option)}`}
            </Text>
          </Box>
        );
      })}
      <Text color={COLORS.muted}>↑↓ move · Space toggle · Enter or Esc close</Text>
    </Box>
  );
}
