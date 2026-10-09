import { Box, Text } from "ink";
import { type ReactNode, useContext, useEffect } from "react";
import { useDeps } from "../deps.ts";
import { NoticeContext } from "../notice.tsx";
import { COLORS, ICONS, LOGO } from "../theme.ts";
import { useTerminalSize } from "./use-terminal-size.ts";

export type Hint = readonly [key: string, label: string];

export interface FrameProps {
  /** Where the user is, e.g. ["Home", "Download", "Quality"]. */
  crumbs: string[];
  icon: string;
  title: string;
  hints: Hint[];
  /** Colour of the icon and title. */
  tone?: "accent" | "ok" | "error" | "warn";
  /** What Ctrl+C does here. It cancels the running download on the download screens. */
  ctrlC?: "Quit" | "Cancel";
  /** Screens that already report the outcome (the result pages) do not repeat the notice. */
  hideNotice?: boolean;
  children: ReactNode;
}

const MAX_WIDTH = 100;
/** The wordmark is 39 columns wide; below this the plain name is shown instead. */
const LOGO_MIN_WIDTH = 52;

/** The fixed chrome around every screen: title bar, breadcrumb, heading, key hints. */
export function Frame({
  crumbs,
  icon,
  title,
  hints,
  tone = "accent",
  ctrlC = "Quit",
  hideNotice = false,
  children,
}: FrameProps) {
  const { version } = useDeps();
  const { notice, seen } = useContext(NoticeContext);
  const visibleNotice = hideNotice ? undefined : notice;
  const noticeId = visibleNotice?.id;
  useEffect(() => {
    if (noticeId !== undefined) seen(noticeId);
  }, [noticeId, seen]);
  const { columns, rows } = useTerminalSize();
  const width = Math.min(columns, MAX_WIDTH);
  const color = COLORS[tone === "accent" ? "accent" : tone];
  // Ctrl+C works on every screen, so it is always the last key hint.
  const shownHints: Hint[] = [...hints.filter(([key]) => key !== "Ctrl+C"), ["Ctrl+C", ctrlC]];

  return (
    <Box flexDirection="column" width={width} height={rows ? rows - 1 : undefined}>
      <Box paddingX={1} justifyContent="center">
        {width >= LOGO_MIN_WIDTH ? (
          <Box flexDirection="column">
            {LOGO.map((line) => (
              <Text key={line} bold color={COLORS.accent}>
                {line}
              </Text>
            ))}
          </Box>
        ) : (
          <Text bold color={COLORS.accent}>
            {ICONS.app} MediaForge
          </Text>
        )}
      </Box>

      {/* A blank line keeps the breadcrumb clearly apart from the logo. */}
      <Box paddingX={1} marginTop={1}>
        <Text color={COLORS.muted}>{crumbs.join(` ${ICONS.chevron} `)}</Text>
      </Box>

      <Box flexDirection="column" paddingX={2} paddingTop={1} flexGrow={1}>
        <Box marginBottom={1}>
          <Text bold color={color}>
            {icon} {title}
          </Text>
        </Box>
        {children}
      </Box>

      {visibleNotice ? (
        <Box paddingX={2}>
          <Text color={COLORS[visibleNotice.kind]}>
            {ICONS[visibleNotice.kind]} {visibleNotice.text}
          </Text>
        </Box>
      ) : null}
      <Box paddingX={1}>
        <Text color={COLORS.muted}>{"─".repeat(Math.max(0, width - 2))}</Text>
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={2}>
          {shownHints.map(([key, label]) => (
            <Text key={key}>
              <Text bold color={COLORS.accent}>
                {key}
              </Text>
              <Text color={COLORS.muted}> {label}</Text>
            </Text>
          ))}
        </Box>
        <Text color={COLORS.muted}>v{version}</Text>
      </Box>
    </Box>
  );
}
