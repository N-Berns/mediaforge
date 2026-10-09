import type { InstallProgress } from "@mediaforge/binary-resolver";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { missingToolHint } from "../../binaries.ts";
import { isRequired, type ToolReport } from "../../doctor.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import {
  describeInstallFailure,
  describeInstallProgress,
  installPercent,
} from "../install-progress.ts";
import { COLORS, ICONS } from "../theme.ts";

type Choice = "install" | "continue" | "again" | "back";

export interface SetupScreenProps {
  onBack: () => void;
  /** Set when the user came here because a tool is missing before a download. Adds "Continue". */
  onReady?: () => void;
  /** Start downloading the missing tools as soon as the check finds some (once). */
  autoDownload?: boolean;
}

export function SetupScreen({ onBack, onReady, autoDownload }: SetupScreenProps) {
  const deps = useDeps();
  const [reports, setReports] = useState<ToolReport[]>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<InstallProgress>();
  const [failure, setFailure] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the check on demand
  useEffect(() => {
    let live = true;
    setReports(undefined);
    deps.inspectTools().then((r) => live && setReports(r));
    return () => {
      live = false;
    };
  }, [deps, attempt]);

  const missing = reports?.filter((r) => !r.found) ?? [];
  const allFound = reports !== undefined && missing.length === 0;
  /** Optional tools (Deno) do not hold up a download. */
  const ready = reports !== undefined && missing.every((r) => !isRequired(r.tool));

  const autoStarted = useRef(false);

  const downloadMissing = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      for (const report of missing) await deps.installTool(report.tool, setProgress);
    } catch (error) {
      setFailure(describeInstallFailure(error));
    }
    setProgress(undefined);
    setBusy(false);
    setAttempt((n) => n + 1);
  };

  // Arrived from About's "Download missing tools": start without another keypress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the first check ends
  useEffect(() => {
    if (!autoDownload || autoStarted.current || !reports) return;
    autoStarted.current = true;
    if (missing.length > 0) void downloadMissing();
  }, [reports]);

  const items: MenuItem<Choice>[] = [];
  if (missing.length > 0) {
    items.push({
      value: "install",
      icon: ICONS.download,
      label: "Download missing tools",
      hint: missing.map((r) => r.tool).join(" and "),
    });
  }
  if (onReady && ready) items.push({ value: "continue", icon: ICONS.ok, label: "Continue" });
  items.push(
    { value: "again", icon: ICONS.retry, label: "Check again" },
    { value: "back", icon: ICONS.back, label: "Back" },
  );
  const initial: Choice = missing.length > 0 ? "install" : onReady ? "continue" : "back";

  const onSelect = (choice: Choice) => {
    if (choice === "install") void downloadMissing();
    else if (choice === "continue") onReady?.();
    else if (choice === "again") setAttempt((n) => n + 1);
    else onBack();
  };

  return (
    <Frame
      crumbs={onReady ? ["Home", "Download", "Tools"] : ["Home", "Check setup"]}
      icon={onReady ? ICONS.download : ICONS.setup}
      tone={reports && !ready ? "warn" : "accent"}
      title={onReady ? "Download the tools first" : "Check setup"}
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      {!reports ? (
        <Spinner label="Looking for yt-dlp, ffmpeg and deno..." />
      ) : (
        <Box flexDirection="column">
          {reports.map((r) => (
            <Box key={r.tool} flexDirection="column" marginBottom={1}>
              <Text
                color={r.found ? COLORS.ok : isRequired(r.tool) ? COLORS.error : COLORS.warn}
                bold
              >
                {r.found ? ICONS.ok : isRequired(r.tool) ? ICONS.error : ICONS.warn} {r.tool}
                <Text color={COLORS.muted} bold={false}>
                  {r.found ? `  ${r.version ?? "unknown version"}  (${r.source})` : "  not found"}
                </Text>
              </Text>
              {r.found ? (
                <Text color={COLORS.muted}>{`  ${r.path}`}</Text>
              ) : (
                <Text color={COLORS.muted}>{`  ${
                  failure
                    ? missingToolHint(r.tool, deps.binDir)
                    : 'Choose "Download missing tools" below. MediaForge manages it, no PATH needed.'
                }`}</Text>
              )}
            </Box>
          ))}
          <Text color={ready ? COLORS.ok : COLORS.warn}>
            {!ready
              ? "Some tools are missing. Downloads will not work until they are set up."
              : allFound
                ? "Everything is ready."
                : "Ready. Download deno to make YouTube work."}
          </Text>
          {failure ? <Text color={COLORS.error}>{failure}</Text> : null}
        </Box>
      )}
      {busy ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{progress ? describeInstallProgress(progress) : "Starting..."}</Text>
          <ProgressBar percent={progress ? installPercent(progress) : undefined} width={30} />
        </Box>
      ) : reports ? (
        <Box marginTop={1}>
          <Menu<Choice>
            key={`${attempt}-${missing.length}`}
            initial={initial}
            onBack={onBack}
            onSelect={onSelect}
            items={items}
          />
        </Box>
      ) : null}
    </Frame>
  );
}
