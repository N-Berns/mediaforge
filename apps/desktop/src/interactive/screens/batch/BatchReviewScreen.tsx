import { Box, Text } from "ink";
import {
  type BatchItem,
  choiceFor,
  choiceWarning,
  clearChoices,
  downloadable,
  isUnusable,
  itemTitle,
  KIND_LABELS,
  waitingItems,
} from "../../batch.ts";
import { shorten } from "../../clipboard-hint.ts";
import { Frame } from "../../components/Frame.tsx";
import { dividerItem, Menu, type MenuItem } from "../../components/Menu.tsx";
import { useTerminalSize } from "../../components/use-terminal-size.ts";
import { siteOf } from "../../links.ts";
import { COLORS, ICONS } from "../../theme.ts";
import { KIND_ICONS } from "./BatchQualityScreen.tsx";

/** The type icons are two characters wide; the others are padded so the labels line up. */
const wide = (icon: string) => icon.padEnd(2);

/** "start", "all", "back", or the index of a link (as a number) to change it alone. */
export type ReviewChoice = "start" | "all" | "back" | number;

export interface BatchReviewScreenProps {
  items: BatchItem[];
  /** The row to highlight, e.g. the link that was just changed. */
  initial?: ReviewChoice;
  onSelect: (choice: ReviewChoice) => void;
}

const linkCount = (n: number) => (n === 1 ? "1 link" : `${n} links`);

/** What will be downloaded for each link, with a way to change single links before starting. */
export function BatchReviewScreen({ items, initial, onSelect }: BatchReviewScreenProps) {
  const { columns, rows } = useTerminalSize();
  const width = Math.min(columns, 100);
  // Cap at 34 (Menu's LABEL_CAP) so every link label pads to the same width.
  const titleWidth = Math.min(34, Math.max(16, Math.floor(width * 0.4)));
  const maxVisible = rows ? Math.max(4, rows - 18) : 12;
  const ready = downloadable(items).length;
  // With nothing to download there is nothing to start, so the row is left out.
  const startRow: MenuItem<ReviewChoice>[] =
    ready > 0
      ? [
          {
            value: "start",
            icon: wide(ICONS.download),
            label: `Start downloading ${linkCount(ready)}`,
          },
        ]
      : [];

  // Asking again only makes sense if some link would be left without a type; when every link was
  // changed on its own (or cannot be downloaded) the type step would have nothing to show.
  const changeAllRow: MenuItem<ReviewChoice>[] =
    waitingItems(clearChoices(items)).length > 0
      ? [{ value: "all", icon: wide(ICONS.format), label: "Change the type and quality for all" }]
      : [];

  const linkRows: MenuItem<ReviewChoice>[] = items.map((item, index) => {
    const choice = choiceFor(item);
    const unusable = isUnusable(item);
    const warning = choice && !unusable ? choiceWarning(item, choice) : undefined;
    const what = unusable
      ? "no downloadable formats"
      : choice
        ? `${KIND_LABELS[choice.kind]}: ${choice.label}${item.override ? " (changed)" : ""}`
        : "no type chosen";
    const note = unusable ? what : (warning ?? (item.lookupError ? "no details" : what));
    return {
      value: index,
      icon:
        unusable || warning || item.lookupError || !choice
          ? wide(ICONS.warn)
          : KIND_ICONS[choice.kind],
      label: shorten(itemTitle(item), titleWidth).padEnd(titleWidth),
      hint: [siteOf(item.url), note].join(" · "),
    };
  });

  const warnings = items.filter((i) => {
    const choice = choiceFor(i);
    return choice && !isUnusable(i) && choiceWarning(i, choice);
  }).length;
  const skipped = items.filter(isUnusable).length;

  return (
    <Frame
      crumbs={["Home", "Download", "Review"]}
      icon={ICONS.download}
      title={ready === 0 ? "Nothing to download" : `Ready to download ${linkCount(ready)}`}
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={COLORS.muted}>Select a link to change its type or quality.</Text>
        {skipped ? (
          <Text color={COLORS.warn}>
            {ICONS.warn} {linkCount(skipped)} {skipped === 1 ? "has" : "have"} nothing to download
            and will be skipped.
          </Text>
        ) : null}
        {warnings ? (
          <Text color={COLORS.warn}>
            {ICONS.warn} {linkCount(warnings)} cannot give this; change{" "}
            {warnings === 1 ? "it" : "them"} or {warnings === 1 ? "it" : "they"} will fail.
          </Text>
        ) : null}
      </Box>
      <Menu<ReviewChoice>
        initial={initial ?? "start"}
        maxVisible={maxVisible}
        onBack={() => onSelect("back")}
        onSelect={onSelect}
        items={[
          ...startRow,
          // -1 is not a link index, so the divider can never match a real choice.
          ...(startRow.length > 0 && linkRows.length > 0 ? [dividerItem<ReviewChoice>(-1)] : []),
          ...linkRows,
          ...changeAllRow,
          { value: "back", icon: wide(ICONS.back), label: "Back" },
        ]}
      />
    </Frame>
  );
}
