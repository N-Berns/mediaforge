import { Box, Text } from "ink";
import { COLORS } from "../theme.ts";

export interface CardProps {
  rows: readonly (readonly [label: string, value: string])[];
  tone?: "muted" | "ok" | "error" | "warn";
  /** False drops the frame and the space under it, for screens short on rows. */
  bordered?: boolean;
}

/** A bordered box of label/value rows, e.g. details of the media being downloaded. */
export function Card({ rows, tone = "muted", bordered = true }: CardProps) {
  if (rows.length === 0) return null;
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return (
    <Box
      {...(bordered && { borderStyle: "single" as const, borderColor: COLORS[tone], paddingX: 1 })}
      flexDirection="column"
      marginBottom={bordered ? 1 : 0}
    >
      {rows.map(([label, value]) => (
        <Box key={label}>
          <Text color={COLORS.muted}>{label.padEnd(labelWidth)} </Text>
          <Text wrap="truncate-end">{value}</Text>
        </Box>
      ))}
    </Box>
  );
}
