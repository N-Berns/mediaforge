import { Box, Text } from "ink";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useDeps } from "../deps.ts";
import { keySequence } from "../mouse/input.ts";
import { Clickable, HoverText, useMouse } from "../mouse/MouseProvider.tsx";
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
  /** The y/N question a click on the Ctrl+C hint asks. Defaults by `ctrlC`. */
  ctrlCQuestion?: string;
  /** Screens that already report the outcome (the result pages) do not repeat the notice. */
  hideNotice?: boolean;
  children: ReactNode;
}

const CTRL_C_QUESTION = { Quit: "Quit MediaForge?", Cancel: "Cancel the download?" } as const;
const CTRL_C = String.fromCharCode(3);
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
  ctrlCQuestion,
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
  const mouse = useMouse();
  const [asking, setAsking] = useState(false);
  const answered = useRef(false);
  const answer = useCallback(
    (yes: boolean) => {
      if (answered.current) return;
      answered.current = true;
      setAsking(false);
      if (yes) mouse.inject(CTRL_C);
    },
    [mouse],
  );
  // While the question shows, keys answer it and reach no screen. Ctrl+C itself still quits.
  useLayoutEffect(() => {
    if (!asking) return;
    answered.current = false;
    return mouse.capture((text) => answer(/^[yY]$/.test(text) || text.includes(CTRL_C)));
  }, [asking, mouse, answer]);
  const question = ctrlCQuestion ?? CTRL_C_QUESTION[ctrlC];

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
        {asking ? (
          <Clickable modal onOutside={() => answer(false)}>
            <Clickable modal onClick={() => answer(true)}>
              <HoverText bold color={COLORS.warn}>
                y
              </HoverText>
            </Clickable>
            <Text color={COLORS.warn}>/</Text>
            <Clickable modal onClick={() => answer(false)}>
              <HoverText color={COLORS.warn}>N</HoverText>
            </Clickable>
            <Text color={COLORS.warn}>{`  ${question}`}</Text>
          </Clickable>
        ) : (
          <Box gap={2}>
            {shownHints.map(([key, label]) => {
              const sequence = keySequence(key);
              return (
                <Clickable
                  key={key}
                  active={sequence !== undefined}
                  onClick={() =>
                    key === "Ctrl+C" ? setAsking(true) : sequence && mouse.inject(sequence)
                  }
                >
                  <HoverText>
                    <Text bold color={COLORS.accent}>
                      {key}
                    </Text>
                    <Text color={COLORS.muted}> {label}</Text>
                  </HoverText>
                </Clickable>
              );
            })}
          </Box>
        )}
        <Text color={COLORS.muted}>v{version}</Text>
      </Box>
    </Box>
  );
}
