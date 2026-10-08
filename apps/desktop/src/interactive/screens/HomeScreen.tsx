import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { COLORS, ICONS } from "../theme.ts";

export type HomeChoice = "download" | "settings" | "setup" | "about" | "quit";

export function HomeScreen({ onPick }: { onPick: (choice: HomeChoice) => void }) {
  const [confirming, setConfirming] = useState(false);

  // Esc on Home has nowhere to go back to, so it offers to quit.
  useInput((_input, key) => key.escape && setConfirming(true), {
    isActive: !confirming,
  });
  useInput(
    (input, key) => {
      if (input.toLowerCase() === "y") onPick("quit");
      else if (input.toLowerCase() === "n" || key.escape || key.return) setConfirming(false);
    },
    { isActive: confirming },
  );

  if (confirming) {
    return (
      <Frame
        crumbs={["Home"]}
        icon={ICONS.quit}
        tone="warn"
        title="Quit MediaForge? (Y/N)"
        hints={[
          ["Y", "Quit"],
          ["N / Esc", "Stay"],
        ]}
      >
        <Text color={COLORS.muted}>Press Y to quit, or N to go back.</Text>
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={["Home"]}
      icon={ICONS.app}
      title="What would you like to do?"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["1-5", "Jump"],
        ["Ctrl+C", "Quit"],
      ]}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>Download video and audio from a link.</Text>
      </Box>
      <Menu<HomeChoice>
        onSelect={onPick}
        items={[
          {
            value: "download",
            icon: ICONS.download,
            label: "Download media",
            hint: "video or audio from a link",
          },
          {
            value: "settings",
            icon: ICONS.settings,
            label: "Settings",
            hint: "default folder and quality",
          },
          {
            value: "setup",
            icon: ICONS.setup,
            label: "Check setup",
            hint: "yt-dlp and ffmpeg",
          },
          {
            value: "about",
            icon: ICONS.info,
            label: "About",
            hint: "version, tools and credits",
          },
          { value: "quit", icon: ICONS.quit, label: "Quit" },
        ]}
      />
    </Frame>
  );
}
