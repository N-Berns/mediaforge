import type { MediaInfo } from "../../formats.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { type FormatPick, formatChoices, type MediaKind } from "../format-choices.ts";
import { mediaRows } from "../hints.ts";
import { ICONS } from "../theme.ts";

export interface FormatsScreenProps {
  info: MediaInfo;
  kind: MediaKind;
  onPick: (pick: FormatPick) => void;
  onBack: () => void;
}

const TITLES: Record<MediaKind, string> = {
  "video-audio": "Choose a video quality",
  video: "Choose a video quality (no sound)",
  audio: "Choose an audio format",
};

export function FormatsScreen({ info, kind, onPick, onBack }: FormatsScreenProps) {
  const { rows } = useTerminalSize();
  const items = formatChoices(info, kind);
  // Leave room for the title bar, info card, heading, scroll hints and key hints.
  const maxVisible = rows ? Math.max(3, rows - 20) : 10;

  return (
    <Frame
      crumbs={["Home", "Download", "Type", "Format"]}
      icon={kind === "audio" ? ICONS.audio : ICONS.video}
      title={TITLES[kind]}
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      <Card rows={mediaRows(info)} />
      <Menu<FormatPick> items={items} maxVisible={maxVisible} onSelect={onPick} onBack={onBack} />
    </Frame>
  );
}
