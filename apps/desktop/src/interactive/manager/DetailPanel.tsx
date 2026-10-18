import {
  type DownloadJob,
  formatLimit,
  type Limits,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Clickable, HoverText } from "../mouse/MouseProvider.tsx";
import { COLORS } from "../theme.ts";
import { PRESET_NAMES } from "./LimitPicker.tsx";
import { ORIGIN_LABELS, rowName, statusText } from "./model.ts";

const LABEL_WIDTH = 8;
/** The title and the hint line. */
const CHROME_LINES = 2;

/** Break text into lines of at most `width` characters, at spaces where it can. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest.length > 0; ) {
      const room = line ? width - line.length - 1 : width;
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest;
        rest = "";
      } else if (line) {
        lines.push(line);
        line = "";
      } else {
        // A word longer than the line (a URL): cut it.
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

export interface DetailPanelProps {
  job: DownloadJob;
  unit: SpeedUnit;
  limits: Limits | undefined;
  /** Lines the panel may use; longer content scrolls with ↑↓. */
  height: number;
  width: number;
  onClose: () => void;
  /** The link or the path to the clipboard. */
  onCopy: (field: "url" | "path") => void;
}

/** Everything the table cuts short: full name, link, path, origin, override and error. */
export function DetailPanel({
  job,
  unit,
  limits,
  height,
  width,
  onClose,
  onCopy,
}: DetailPanelProps) {
  const override = job.limitOverride;
  const limit = override
    ? `${PRESET_NAMES[override]} · ${formatLimit(limits?.[override] ?? null, unit)}`
    : "None (shares the global limit)";
  const fields: [string, string][] = [
    ["Name", rowName(job)],
    ["URL", job.request.candidate.url],
    ["Path", job.outputPath ?? "—"],
    ["Origin", job.origin ? ORIGIN_LABELS[job.origin] : "—"],
    ["Limit", limit],
    ["Status", statusText(job)],
    ...(job.error ? [["Error", job.error] as [string, string]] : []),
  ];
  const textWidth = Math.max(10, width - 2 - LABEL_WIDTH);
  const lines = fields.flatMap(([label, value]) =>
    wrapText(value, textWidth).map((text, i) => ({
      id: `${label}-${i}`,
      field: label,
      label: i === 0 ? label : "",
      text,
    })),
  );
  const size = Math.max(1, height - CHROME_LINES);
  const maxTop = Math.max(0, lines.length - size);
  const [top, setTop] = useState(0);

  useInput((input, key) => {
    if (key.escape || key.return) onClose();
    else if (input === "y") onCopy("url");
    else if (input === "Y") onCopy("path");
    else if (key.upArrow) setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow) setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp) setTop((t) => Math.max(0, t - size));
    else if (key.pageDown) setTop((t) => Math.min(maxTop, t + size));
  });

  const first = Math.min(top, maxTop);
  const shown = lines.slice(first, first + size);
  const hint = [
    ...(first > 0 ? ["↑ more"] : []),
    ...(first < maxTop ? ["↓ more"] : []),
    ...(maxTop > 0 ? ["↑↓ scroll"] : []),
    "y copy link · Y copy path",
    "Esc close",
  ].join(" · ");
  return (
    <Clickable
      flexDirection="column"
      paddingX={1}
      onWheel={(step) => setTop((t) => Math.max(0, Math.min(maxTop, t + step)))}
    >
      <Text bold color={COLORS.accent}>
        Details
      </Text>
      {shown.map((line) => (
        <Clickable
          key={line.id}
          {...((line.field === "URL" || line.field === "Path") && {
            onClick: () => onCopy(line.field === "URL" ? "url" : "path"),
          })}
        >
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={COLORS.muted}>{line.label}</Text>
          </Box>
          <HoverText wrap="truncate-end">{line.text}</HoverText>
        </Clickable>
      ))}
      <Text color={COLORS.muted}>{hint}</Text>
    </Clickable>
  );
}
