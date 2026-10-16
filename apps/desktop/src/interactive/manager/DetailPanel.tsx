import {
  type DownloadJob,
  formatLimit,
  type Limits,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import { Box, Text, useInput } from "ink";
import { COLORS } from "../theme.ts";
import { PRESET_NAMES } from "./LimitPicker.tsx";
import { ORIGIN_LABELS, rowName, statusText } from "./model.ts";

const LABEL_WIDTH = 8;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text color={COLORS.muted}>{label}</Text>
      </Box>
      <Text wrap="wrap">{value}</Text>
    </Box>
  );
}

export interface DetailPanelProps {
  job: DownloadJob;
  unit: SpeedUnit;
  limits: Limits | undefined;
  onClose: () => void;
}

/** Everything the table cuts short: full name, link, path, origin, override and error. */
export function DetailPanel({ job, unit, limits, onClose }: DetailPanelProps) {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose();
  });
  const override = job.limitOverride;
  const limit = override
    ? `${PRESET_NAMES[override]} · ${formatLimit(limits?.[override] ?? null, unit)}`
    : "None (shares the global limit)";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={COLORS.accent}>
        Details
      </Text>
      <Field label="Name" value={rowName(job)} />
      <Field label="URL" value={job.request.candidate.url} />
      <Field label="Path" value={job.outputPath ?? "—"} />
      <Field label="Origin" value={job.origin ? ORIGIN_LABELS[job.origin] : "—"} />
      <Field label="Limit" value={limit} />
      <Field label="Status" value={statusText(job)} />
      {job.error ? <Field label="Error" value={job.error} /> : null}
      <Text color={COLORS.muted}>Esc close</Text>
    </Box>
  );
}
