import { Text } from "ink";
import { BAR, COLORS } from "../theme.ts";

/** A bar of `width` cells filled to `percent` (0 to 100). */
export function renderBar(
  percent: number | undefined,
  width: number,
  chars: { full: string; empty: string } = BAR,
): string {
  const clamped = Math.min(100, Math.max(0, percent ?? 0));
  const full = Math.round((clamped / 100) * width);
  return chars.full.repeat(full) + chars.empty.repeat(width - full);
}

export interface ProgressBarProps {
  percent: number | undefined;
  width: number;
  color?: string;
  chars?: { full: string; empty: string };
  bold?: boolean;
}

export function ProgressBar({
  percent,
  width,
  color = COLORS.accent,
  chars = BAR,
  bold = true,
}: ProgressBarProps) {
  const full = Math.round((Math.min(100, Math.max(0, percent ?? 0)) / 100) * width);
  const bar = renderBar(percent, width, chars);
  return (
    <Text>
      <Text color={color}>{bar.slice(0, full)}</Text>
      <Text color={COLORS.muted}>{bar.slice(full)}</Text>
      <Text bold={bold} color={bold ? undefined : color}>
        {" "}
        {percent === undefined ? "  --" : `${Math.floor(percent)}%`.padStart(4)}
      </Text>
    </Text>
  );
}
