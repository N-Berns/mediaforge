import { Box, Text } from "ink";
import { useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { COLORS, ICONS } from "../theme.ts";
import { PathPickerScreen } from "./PathPickerScreen.tsx";

type Choice = "default" | "other";

export interface FolderScreenProps {
  defaultDir: string;
  /** Type subfolder the file will go into, when sorting is on. */
  subfolder?: string;
  /** Replaces the subfolder sentence, e.g. for several links that go to different folders. */
  note?: string;
  onPick: (dir: string) => void;
  onBack: () => void;
}

export function FolderScreen({ defaultDir, subfolder, note, onPick, onBack }: FolderScreenProps) {
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <PathPickerScreen
        crumbs={["Home", "Download", "Folder"]}
        startDir={defaultDir}
        onPick={onPick}
        onCancel={() => setPicking(false)}
      />
    );
  }

  return (
    <Frame
      crumbs={["Home", "Download", "Folder"]}
      icon={ICONS.folder}
      title="Where should it be saved?"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      {note || subfolder ? (
        <Box marginBottom={1}>
          <Text color={COLORS.muted}>
            {ICONS.info}{" "}
            {note ?? `It will go into a "${subfolder}" folder inside the one you choose.`}
          </Text>
        </Box>
      ) : null}
      <Menu<Choice>
        onBack={onBack}
        onSelect={(choice) => (choice === "default" ? onPick(defaultDir) : setPicking(true))}
        items={[
          { value: "default", icon: ICONS.folder, label: defaultDir, hint: "default" },
          { value: "other", icon: ICONS.type, label: "Choose another folder..." },
        ]}
      />
    </Frame>
  );
}
