import { Box, Text, useInput } from "ink";
import { SELECT_TIP } from "../about.ts";
import { COLORS } from "../theme.ts";

const KEYS: [string, string][] = [
  ["↑ ↓ PgUp PgDn Home End", "Move the cursor"],
  ["Space, Ctrl+A", "Tick the row, tick all visible rows"],
  ["a", "Add a link"],
  ["p", "Pause"],
  ["r", "Resume paused, retry failed"],
  ["c", "Cancel"],
  ["x", "Remove from the list"],
  ["Del", "Move the files to the trash"],
  ["C", "Clear finished rows"],
  ["o", "Open the folder"],
  ["/", "Search name and link"],
  ["f", "Filter"],
  ["l", "Cycle the global limit"],
  ["L", "Set the override for the rows"],
  ["b", "Switch bytes and bits"],
  ["Enter", "Details"],
  ["1-6", "Sort by Name, Size, Status, Speed, ETA, Last try"],
  ["R", "Resume the downloads in the notice"],
  ["z", "Dismiss the session notice"],
  ["y, Y", "Copy the link, the path (in Details)"],
  ["Mouse", "Click moves, [ ] ticks, Ctrl+click ticks a range, double-click opens"],
  ["Esc", "Close, clear search and filters, or go back"],
  ["Ctrl+C", "Quit"],
];

const KEY_WIDTH = 24;

/** Every key the manager knows. Any of Esc, Enter or ? closes it. */
export function KeyList({ onClose }: { onClose: () => void }) {
  useInput((input, key) => {
    if (key.escape || key.return || input === "?") onClose();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={COLORS.accent}>
        Keys
      </Text>
      {KEYS.map(([key, what]) => (
        <Box key={key}>
          <Box width={KEY_WIDTH} flexShrink={0}>
            <Text color={COLORS.accent}>{key}</Text>
          </Box>
          <Text>{what}</Text>
        </Box>
      ))}
      <Text color={COLORS.muted}>{SELECT_TIP}</Text>
    </Box>
  );
}
