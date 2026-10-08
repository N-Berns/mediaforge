import { DEFAULT_PROFILE_ID, getProfile } from "@mediaforge/media-profiles";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, MAX_CONCURRENCY, type Settings } from "../../settings.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { useDeps } from "../deps.ts";
import { effectiveFolder } from "../flow.ts";
import { COLORS, ICONS } from "../theme.ts";
import { PathPickerScreen } from "./PathPickerScreen.tsx";
import { profileItems } from "./QualityScreen.tsx";

type Choice =
  | "folder"
  | "askFolder"
  | "quality"
  | "askQuality"
  | "sortByType"
  | "concurrency"
  | "reset"
  | "back";
type Mode = "menu" | "folder" | "quality" | "concurrency" | "reset";
type Note = { tone: "ok" | "error"; text: string };

const yesNo = (ask: boolean) =>
  `${ask ? ICONS.on : ICONS.off} ${ask ? "Yes" : "No, use the default"}`;

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const deps = useDeps();
  const [settings, setSettings] = useState<Settings>();
  const [mode, setMode] = useState<Mode>("menu");
  const [last, setLast] = useState<Choice>("folder");
  const [note, setNote] = useState<Note>();

  useEffect(() => {
    let live = true;
    deps.download.settings.load().then((s) => live && setSettings(s));
    return () => {
      live = false;
    };
  }, [deps]);

  if (!settings) return null;

  const save = async (next: Settings) => {
    try {
      await deps.download.settings.save(next);
      setSettings(next);
      setNote({ tone: "ok", text: "Saved" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNote({ tone: "error", text: `Could not save settings: ${text}` });
    }
    setMode("menu");
  };

  const folder = effectiveFolder(deps.download.env, settings, deps.defaultOutputDir);
  const qualityName = getProfile(settings.quality ?? DEFAULT_PROFILE_ID)?.name;

  if (mode === "folder") {
    return (
      <PathPickerScreen
        crumbs={["Home", "Settings", "Folder"]}
        startDir={folder}
        onPick={(value) => void save({ ...settings, folder: value })}
        onCancel={() => setMode("menu")}
      />
    );
  }

  if (mode === "quality") {
    return (
      <Frame
        crumbs={["Home", "Settings", "Quality"]}
        icon={ICONS.video}
        title="Default quality"
        hints={[
          ["↑↓", "Move"],
          ["Enter", "Save"],
          ["Esc", "Cancel"],
        ]}
      >
        <Menu<string>
          items={profileItems()}
          initial={settings.quality ?? DEFAULT_PROFILE_ID}
          onBack={() => setMode("menu")}
          onSelect={(value) => void save({ ...settings, quality: value })}
        />
      </Frame>
    );
  }

  if (mode === "concurrency") {
    return (
      <Frame
        crumbs={["Home", "Settings", "Downloads at once"]}
        icon={ICONS.download}
        title="How many links download at the same time?"
        hints={[
          ["↑↓", "Move"],
          ["Enter", "Save"],
          ["Esc", "Cancel"],
        ]}
      >
        <Box marginBottom={1}>
          <Text color={COLORS.muted}>
            Used when you give several links. More at once can be faster, but some sites slow down
            or block many downloads in a row.
          </Text>
        </Box>
        <Menu<number>
          initial={settings.concurrency}
          onBack={() => setMode("menu")}
          onSelect={(value) => void save({ ...settings, concurrency: value })}
          items={Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1).map((n) => ({
            value: n,
            icon: ICONS.download,
            label: n === 1 ? "1 at a time" : `${n} at a time`,
            ...(n === DEFAULT_SETTINGS.concurrency && { hint: "default" }),
          }))}
        />
      </Frame>
    );
  }

  if (mode === "reset") {
    return (
      <Frame
        crumbs={["Home", "Settings", "Reset"]}
        icon={ICONS.warn}
        tone="warn"
        title="Reset all settings?"
        hints={[
          ["↑↓", "Move"],
          ["Enter", "Select"],
          ["Esc", "Cancel"],
        ]}
      >
        <Box marginBottom={1}>
          <Text color={COLORS.muted}>
            All settings go back to the built-in defaults, and you will be asked each time.
          </Text>
        </Box>
        <Menu<boolean>
          initial={false}
          onBack={() => setMode("menu")}
          onSelect={(yes) => (yes ? void save({ ...DEFAULT_SETTINGS }) : setMode("menu"))}
          items={[
            { value: false, icon: ICONS.back, label: "No, keep my settings" },
            { value: true, icon: ICONS.retry, label: "Yes, reset" },
          ]}
        />
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={["Home", "Settings"]}
      icon={ICONS.settings}
      title="Settings"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Change"],
        ["Esc", "Back"],
      ]}
    >
      <Menu<Choice>
        key={note?.text}
        initial={last}
        onBack={onBack}
        onSelect={(choice) => {
          setLast(choice);
          setNote(undefined);
          if (choice === "back") onBack();
          else if (choice === "askFolder")
            void save({ ...settings, askFolder: !settings.askFolder });
          else if (choice === "askQuality") {
            void save({ ...settings, askQuality: !settings.askQuality });
          } else if (choice === "sortByType") {
            void save({ ...settings, sortByType: !settings.sortByType });
          } else setMode(choice);
        }}
        items={[
          { value: "folder", icon: ICONS.folder, label: "Default download folder", hint: folder },
          {
            value: "askFolder",
            icon: ICONS.settings,
            label: "Ask for the folder each time",
            hint: yesNo(settings.askFolder),
          },
          { value: "quality", icon: ICONS.video, label: "Default quality", hint: qualityName },
          {
            value: "askQuality",
            icon: ICONS.settings,
            label: "Ask for the quality each time",
            hint: yesNo(settings.askQuality),
          },
          {
            value: "sortByType",
            icon: ICONS.folder,
            label: "Sort into folders by type",
            hint: `${settings.sortByType ? ICONS.on : ICONS.off} ${settings.sortByType ? "Yes (Video, Video only, Audio)" : "No, save straight into the folder"}`,
          },
          {
            value: "concurrency",
            icon: ICONS.download,
            label: "Downloads at once",
            hint: `${settings.concurrency} (when you give several links)`,
          },
          { value: "reset", icon: ICONS.retry, label: "Reset to built-in defaults" },
          { value: "back", icon: ICONS.back, label: "Back" },
        ]}
      />
      {note ? (
        <Box marginTop={1}>
          <Text color={note.tone === "ok" ? COLORS.ok : COLORS.error}>
            {note.tone === "ok" ? ICONS.ok : ICONS.error} {note.text}
          </Text>
        </Box>
      ) : null}
    </Frame>
  );
}
