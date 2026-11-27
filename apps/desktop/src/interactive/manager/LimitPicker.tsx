import {
  formatLimit,
  LIMIT_PRESETS,
  type LimitPreset,
  type Limits,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import { Box, Text } from "ink";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { COLORS } from "../theme.ts";

export const PRESET_NAMES: Record<LimitPreset, string> = {
  high: "High",
  med: "Med",
  low: "Low",
  custom: "Custom",
};

type Choice = LimitPreset | "none";

export interface LimitPickerProps {
  limits: Limits;
  unit: SpeedUnit;
  /** The cursor row's override, highlighted first; None when it has none. */
  current?: LimitPreset;
  count: number;
  onPick: (preset: LimitPreset | null) => void;
  onCancel: () => void;
}

/** Pick a per-download speed cap for the affected rows, each preset shown with its value. */
export function LimitPicker({ limits, unit, current, count, onPick, onCancel }: LimitPickerProps) {
  const items: MenuItem<Choice>[] = [
    ...LIMIT_PRESETS.map((preset) => ({
      value: preset,
      label: `${PRESET_NAMES[preset]} · ${formatLimit(limits[preset], unit)}`,
    })),
    { value: "none", label: "None", hint: "share the global limit" },
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={COLORS.accent}>
        {`Limit for ${count} download${count === 1 ? "" : "s"}`}
      </Text>
      <Menu<Choice>
        items={items}
        initial={current ?? "none"}
        onSelect={(choice) => onPick(choice === "none" ? null : choice)}
        onBack={onCancel}
      />
    </Box>
  );
}
