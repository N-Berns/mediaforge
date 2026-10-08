import { Box, Text } from "ink";
import {
  type BatchItem,
  isAssigned,
  KIND_LABELS,
  PRESETS,
  type PresetId,
  takers,
  waitingItems,
} from "../../batch.ts";
import { Frame } from "../../components/Frame.tsx";
import { Menu, type MenuItem } from "../../components/Menu.tsx";
import type { MediaKind } from "../../format-choices.ts";
import { COLORS, ICONS } from "../../theme.ts";

export const KIND_ICONS: Record<MediaKind, string> = {
  "video-audio": ICONS.kindVideoAudio,
  video: ICONS.kindVideo,
  audio: ICONS.kindAudio,
};

const KINDS: MediaKind[] = ["video-audio", "video", "audio"];

export interface BatchQualityScreenProps {
  items: BatchItem[];
  onPick: (kind: MediaKind, preset: PresetId) => void;
  onBack: () => void;
}

const linkCount = (n: number) => (n === 1 ? "1 link" : `${n} links`);

/**
 * Pick a type and quality per section. A choice applies only to the links that can give that
 * type; links left over are asked again, with the sections recounted over what is left.
 */
export function BatchQualityScreen({ items, onPick, onBack }: BatchQualityScreenProps) {
  const waiting = waitingItems(items);
  const firstRound = !items.some(isAssigned);

  const rows: MenuItem<string>[] = KINDS.flatMap((kind) => {
    const able = takers(items, kind).length;
    return [
      {
        value: `heading:${kind}`,
        label: `${KIND_LABELS[kind]} · ${able} of ${linkCount(waiting.length)}`,
        heading: true,
        disabled: true,
      },
      ...PRESETS[kind].map((p) => ({
        value: `${kind}:${p.id}`,
        icon: KIND_ICONS[kind],
        label: p.label,
        hint: p.hint,
        disabled: able === 0,
      })),
    ];
  });

  return (
    <Frame
      crumbs={["Home", "Download", "Type"]}
      icon={ICONS.video}
      title={
        firstRound
          ? `What do you want to save from these ${items.length} links?`
          : `${linkCount(waiting.length)} still ${waiting.length === 1 ? "needs" : "need"} a type`
      }
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>
          {firstRound
            ? "A choice applies only to the links that can give that type. You can change single links on the next screen."
            : "Choose a type for the links that are left."}
        </Text>
      </Box>
      <Menu<string>
        items={rows}
        onBack={onBack}
        onSelect={(value) => {
          const [kind, id] = value.split(":") as [MediaKind, PresetId];
          onPick(kind, id);
        }}
      />
    </Frame>
  );
}
