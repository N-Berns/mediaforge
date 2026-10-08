import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID } from "@mediaforge/media-profiles";
import type { OutputProfile } from "@mediaforge/shared-types";
import type { Settings } from "../../settings.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import type { Draft } from "../flow.ts";
import { availableKinds, type MediaKind } from "../format-choices.ts";
import { mediaRows } from "../hints.ts";
import { ICONS } from "../theme.ts";

export type QualityChoice = { profileId: string } | { kind: MediaKind };

/** "mp4 · up to 1080p" or "mp3 · 320 kbps": what a profile produces. */
export function profileHint(profile: OutputProfile): string {
  const parts: string[] = [profile.container];
  if (profile.maxHeight) parts.push(`up to ${profile.maxHeight}p`);
  if (profile.audioBitrate) parts.push(`${profile.audioBitrate} kbps`);
  return parts.join(" · ");
}

export function profileItems(): MenuItem<string>[] {
  return BUILTIN_PROFILES.map((p) => ({
    value: p.id as string,
    icon: p.kind === "audio" ? ICONS.audio : ICONS.video,
    label: p.name,
    hint: profileHint(p),
  }));
}

export interface QualityScreenProps {
  draft: Draft;
  settings: Settings;
  onPick: (choice: QualityChoice) => void;
  onBack: () => void;
}

const KIND_ITEMS: { value: MediaKind; icon: string; label: string; hint: string }[] = [
  {
    value: "video-audio",
    icon: ICONS.kindVideoAudio,
    label: "Video with audio",
    hint: "a normal video",
  },
  { value: "video", icon: ICONS.kindVideo, label: "Video only", hint: "picture without sound" },
  { value: "audio", icon: ICONS.kindAudio, label: "Audio only", hint: "music or speech" },
];

const HINTS: [string, string][] = [
  ["↑↓", "Move"],
  ["Enter", "Select"],
  ["Esc", "Back"],
];

export function QualityScreen({ draft, settings, onPick, onBack }: QualityScreenProps) {
  const available = draft.info ? availableKinds(draft.info) : undefined;
  const hasKinds = available !== undefined && Object.values(available).some(Boolean);

  // Without details from the lookup there is nothing to filter, so offer the ready-made profiles.
  if (!available || !hasKinds) {
    return (
      <Frame
        crumbs={["Home", "Download", "Quality"]}
        icon={ICONS.video}
        title="Choose a quality"
        hints={HINTS}
      >
        {draft.info ? <Card rows={mediaRows(draft.info)} /> : null}
        <Menu<string>
          items={profileItems()}
          initial={draft.profileId ?? settings.quality ?? DEFAULT_PROFILE_ID}
          onBack={onBack}
          onSelect={(value) => onPick({ profileId: value })}
        />
      </Frame>
    );
  }

  const items: MenuItem<MediaKind>[] = KIND_ITEMS.map((item) => ({
    ...item,
    disabled: !available[item.value],
    hint: available[item.value] ? item.hint : "not offered for this link",
  }));

  return (
    <Frame
      crumbs={["Home", "Download", "Type"]}
      icon={ICONS.video}
      title="What do you want to save?"
      hints={HINTS}
    >
      {draft.info ? <Card rows={mediaRows(draft.info)} /> : null}
      <Menu<MediaKind>
        items={items}
        initial="video-audio"
        onBack={onBack}
        onSelect={(kind) => onPick({ kind })}
      />
    </Frame>
  );
}
