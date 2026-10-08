import type { InstallProgress } from "@mediaforge/binary-resolver";
import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { useDeps } from "../deps.ts";
import {
  describeInstallFailure,
  describeInstallProgress,
  installPercent,
} from "../install-progress.ts";
import { COLORS, ICONS } from "../theme.ts";

type Choice = "again" | "anyway" | "back";

export interface UpdateScreenProps {
  /** Called once yt-dlp is updated and the download can be retried. */
  onDone: () => void;
  onBack: () => void;
}

/** What the screen shows besides the progress bar: nothing, an error, or a warning. */
type Problem = { kind: "failed"; message: string } | { kind: "shadowed"; message: string };

/** Downloads the latest yt-dlp, then hands control back so the download can be retried. */
export function UpdateScreen({ onDone, onBack }: UpdateScreenProps) {
  const deps = useDeps();
  const [progress, setProgress] = useState<InstallProgress>();
  const [problem, setProblem] = useState<Problem>();
  const alive = useRef(true);
  // The callback changes on every render; keep the latest one without restarting the update.
  const done = useRef(onDone);
  done.current = onDone;

  const start = useCallback(() => {
    setProblem(undefined);
    setProgress(undefined);
    const update = async () => {
      await deps.installTool("yt-dlp", (p) => {
        if (alive.current) setProgress(p);
      });
      // The download only helps if it is the yt-dlp that gets used. If the check itself
      // fails, assume it is and let the retry show the real result.
      const reports = await deps.inspectTools().catch(() => []);
      const active = reports.find((r) => r.tool === "yt-dlp" && r.found);
      if (!alive.current) return;
      if (active && active.source !== "cache") {
        setProblem({
          kind: "shadowed",
          message: `A yt-dlp from ${active.source} (${active.path}) is used before the downloaded copy, so this update has no effect. Remove it, or unset MEDIAFORGE_YTDLP_PATH, to use the downloaded one.`,
        });
      } else {
        done.current();
      }
    };
    update().catch((error) => {
      if (alive.current) setProblem({ kind: "failed", message: describeInstallFailure(error) });
    });
  }, [deps]);

  useEffect(() => {
    alive.current = true;
    start();
    return () => {
      alive.current = false;
    };
  }, [start]);

  const onSelect = (choice: Choice) => {
    if (choice === "again") start();
    else if (choice === "anyway") done.current();
    else onBack();
  };

  return (
    <Frame
      crumbs={["Home", "Download", "Update yt-dlp"]}
      icon={ICONS.download}
      tone={problem?.kind === "failed" ? "error" : problem ? "warn" : "accent"}
      title="Updating yt-dlp"
      hints={
        problem
          ? [
              ["↑↓", "Move"],
              ["Enter", "Select"],
              ["Esc", "Back"],
            ]
          : [["Ctrl+C", "Quit"]]
      }
    >
      {problem ? (
        <Box flexDirection="column">
          <Text color={problem.kind === "failed" ? COLORS.error : COLORS.warn}>
            {problem.message}
          </Text>
          <Box marginTop={1}>
            <Menu<Choice>
              onBack={onBack}
              onSelect={onSelect}
              items={
                problem.kind === "failed"
                  ? [
                      { value: "again", icon: ICONS.retry, label: "Try again" },
                      { value: "back", icon: ICONS.back, label: "Back" },
                    ]
                  : [
                      { value: "anyway", icon: ICONS.retry, label: "Retry the download anyway" },
                      { value: "back", icon: ICONS.back, label: "Back" },
                    ]
              }
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>{progress ? describeInstallProgress(progress) : "Starting..."}</Text>
          <ProgressBar percent={progress ? installPercent(progress) : undefined} width={30} />
        </Box>
      )}
    </Frame>
  );
}
