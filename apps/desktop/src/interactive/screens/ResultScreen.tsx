import { basename, dirname } from "node:path";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { EngineJob } from "../../engine/index.ts";
import { isStaleExtractorError } from "../../stale-extractor.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { useDeps } from "../deps.ts";
import { failureHint, formatBytes } from "../hints.ts";
import { COLORS, ICONS } from "../theme.ts";

export type ResultAction = "open" | "again" | "retry" | "update" | "quality" | "home" | "quit";

export interface ResultScreenProps {
  job: EngineJob;
  /** Whether the lookup gave details, so "different quality" can offer formats. */
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

export function ResultScreen({ job, onAction }: ResultScreenProps) {
  const size = useFileSize(job.outputPath);
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
      icon={cancelled ? ICONS.warn : ICONS.error}
      tone={cancelled ? "warn" : "error"}
      title={cancelled ? "Download cancelled" : "Download failed"}
      hints={[...hints]}
    >
      {cancelled ? null : (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.error}>{job.error ?? "Something went wrong."}</Text>
          <Text color={COLORS.muted}>{failureHint(job.errorKind, job.error ?? "")}</Text>
        </Box>
      )}
      <Menu<ResultAction>
        onSelect={onAction}
        onBack={() => onAction("home")}
        items={[
          { value: "retry", icon: ICONS.retry, label: "Try again", hint: "same link and choices" },
          ...(isStaleExtractorError(job.error)
            ? [
                {
                  value: "update" as const,
                  icon: ICONS.download,
                  label: "Update yt-dlp and retry",
                  hint: "downloads the latest nightly",
                },
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
