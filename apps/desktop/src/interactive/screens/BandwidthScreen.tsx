import { formatLimit, LIMIT_PRESETS, type LimitPreset, parseRate } from "@mediaforge/shared-types";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Settings } from "../../settings.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { TextField } from "../components/TextField.tsx";
import { COLORS, ICONS } from "../theme.ts";

export const PRESET_NAMES: Record<LimitPreset, string> = {
  high: "High",
  med: "Med",
  low: "Low",
  custom: "Custom",
};

interface BandwidthScreenProps {
  settings: Settings;
  /** The result of the last save, shown under the list. */
  note?: { tone: "ok" | "error"; text: string };
  /** Save the whole settings object; the caller sets `note` and tells the core. */
  onSave: (next: Settings) => void;
  onBack: () => void;
}

/** The four presets with their values: Enter makes one the global limit, `e` edits its value. */
export function BandwidthScreen({ settings, note, onSave, onBack }: BandwidthScreenProps) {
  const [highlighted, setHighlighted] = useState<LimitPreset>(settings.limitPreset);
  const [editing, setEditing] = useState<LimitPreset>();
  const unit = settings.speedUnit;
  const unitName = unit === "bits" ? "Mbps" : "MB/s";

  useInput(
    (input) => {
      if (input === "e") setEditing(highlighted);
    },
    { isActive: editing === undefined },
  );

  if (editing) {
    const current = settings.limits[editing];
    return (
      <Frame
        crumbs={["Home", "Settings", "Bandwidth limit", PRESET_NAMES[editing]]}
        icon={ICONS.download}
        title={`Limit for ${PRESET_NAMES[editing]}`}
        hints={[
          ["Enter", "Save"],
          ["Esc", "Cancel"],
        ]}
      >
        <Box marginBottom={1}>
          <Text color={COLORS.muted}>
            {`In ${unitName} unless you type a unit (MB/s, Mbps, kB/s…). Empty or 0 for no limit.`}
          </Text>
        </Box>
        <TextField
          initial={current === null ? "" : formatLimit(current, unit)}
          validate={(value) => {
            const parsed = parseRate(value, unit);
            return parsed.ok ? undefined : parsed.error;
          }}
          onSubmit={(value) => {
            const parsed = parseRate(value, unit);
            if (!parsed.ok) return;
            setEditing(undefined);
            onSave({
              ...settings,
              limits: { ...settings.limits, [editing]: parsed.bytesPerSec },
            });
          }}
          onCancel={() => setEditing(undefined)}
        />
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={["Home", "Settings", "Bandwidth limit"]}
      icon={ICONS.download}
      title="Bandwidth limit"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Use"],
        ["e", "Edit value"],
        ["Esc", "Back"],
      ]}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>
          Shared evenly by the downloads that are running. Downloads with their own limit are not
          counted.
        </Text>
      </Box>
      <Menu<LimitPreset>
        // The row last on, so the list comes back where it was after an edit.
        initial={highlighted}
        onBack={onBack}
        onHighlight={setHighlighted}
        onSelect={(preset) => onSave({ ...settings, limitPreset: preset })}
        items={LIMIT_PRESETS.map((preset) => ({
          value: preset,
          icon: preset === settings.limitPreset ? ICONS.on : ICONS.off,
          label: PRESET_NAMES[preset].padEnd(8),
          hint: `${formatLimit(settings.limits[preset], unit)}${preset === settings.limitPreset ? "  (in use)" : ""}`,
        }))}
      />
      {note ? (
        <Box marginTop={1}>
          <Text color={note.tone === "ok" ? COLORS.ok : COLORS.error}>
            {note.tone === "ok" ? ICONS.ok : ICONS.error} {note.text}
          </Text>
        </Box>
      ) : null}
    </Frame>
  );
}
