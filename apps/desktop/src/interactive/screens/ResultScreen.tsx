import { basename, dirname } from "node:path";
import { formatBytes } from "@mediaforge/shared-types";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { EngineJob } from "../../engine/index.ts";
import { isStaleExtractorError } from "../../stale-extractor.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { useDeps } from "../deps.ts";
import { failureHint } from "../hints.ts";
import { COLORS, ICONS } from "../theme.ts";

export type ResultAction =
  | "open"
  | "again"
  | "retry"
  | "update"
  | "update-nightly"
  | "update-master"
  | "quality"
  | "home"
  | "quit";

/** The channels the failed screen can switch to, besides the saved one. */
const SWITCH_CHANNELS = [
  { channel: "nightly", value: "update-nightly" },
  { channel: "master", value: "update-master" },
] as const;

export interface ResultScreenProps {
  job: EngineJob;
  /** Whether the lookup gave details, so "different quality" can offer formats. */
  /** The saved yt-dlp channel, so the switch entries are right on the first frame. */
  channel: string;
  /** Why the last attempt to switch channel failed. */
  error?: string;
  onAction: (action: ResultAction) => void;
}

function useFileSize(path: string | undefined): string | undefined {
  const deps = useDeps();
  const [size, setSize] = useState<string>();
  useEffect(() => {
    if (!path) return;
    let live = true;
    deps.fileSize(path).then((bytes) => live && bytes !== undefined && setSize(formatBytes(bytes)));
    return () => {
      live = false;
    };
  }, [deps, path]);
  return size;
}

const FOOTER_ITEMS: MenuItem<ResultAction>[] = [
  { value: "home", icon: ICONS.app, label: "Back to home" },
  { value: "quit", icon: ICONS.quit, label: "Quit" },
];

export function ResultScreen({ job, channel, error, onAction }: ResultScreenProps) {
  const size = useFileSize(job.outputPath);
  const stale = job.status !== "completed" && isStaleExtractorError(job.error);
  const hints = [
    ["↑↓", "Move"],
    ["Enter", "Select"],
  ] as const;

  if (job.status === "completed" && job.outputPath) {
    return (
      <Frame
        crumbs={["Home", "Download", "Done"]}
        icon={ICONS.ok}
        tone="ok"
        title="Download complete"
        hints={[...hints]}
        hideNotice
      >
        <Card
          tone="ok"
          rows={[
            ["File", basename(job.outputPath)],
            ...(size ? ([["Size", size]] as const) : []),
            ["Folder", dirname(job.outputPath)],
          ]}
        />
        <Menu<ResultAction>
          onSelect={onAction}
          onBack={() => onAction("home")}
          items={[
            { value: "open", icon: ICONS.folder, label: "Open folder" },
            { value: "again", icon: ICONS.download, label: "Download another" },
            ...FOOTER_ITEMS,
          ]}
        />
      </Frame>
    );
  }

  const cancelled = job.status === "cancelled";
  return (
    <Frame
      crumbs={["Home", "Download", cancelled ? "Cancelled" : "Failed"]}
      icon={cancelled ? ICONS.stop : ICONS.error}
      tone={cancelled ? "error" : "failed"}
      title={cancelled ? "Download cancelled" : "Download failed"}
      hints={[...hints]}
      hideNotice
    >
      {cancelled ? null : (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.error}>{job.error ?? "Something went wrong."}</Text>
          <Text color={COLORS.muted}>{failureHint(job.errorKind, job.error ?? "")}</Text>
          {error ? <Text color={COLORS.error}>{error}</Text> : null}
        </Box>
      )}
      <Menu<ResultAction>
        onSelect={onAction}
        onBack={() => onAction("home")}
        items={[
          { value: "retry", icon: ICONS.retry, label: "Try again", hint: "same link and choices" },
          ...(stale
            ? [
                {
                  value: "update" as const,
                  icon: ICONS.download,
                  label: "Update yt-dlp and retry",
                  hint: "reinstalls yt-dlp from your channel",
                },
                ...SWITCH_CHANNELS.filter((c) => c.channel !== channel).map((c) => ({
                  value: c.value,
                  icon: ICONS.download,
                  label: `Update yt-dlp to ${c.channel} and retry`,
                  hint: "switches your channel and downloads that build",
                })),
              ]
            : []),
          { value: "quality", icon: ICONS.format, label: "Choose a different quality" },
          { value: "again", icon: ICONS.link, label: "Use a different link" },
          ...FOOTER_ITEMS,
        ]}
      />
    </Frame>
  );
}
