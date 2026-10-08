import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { missingToolHint } from "../../binaries.ts";
import type { ToolReport } from "../../doctor.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import { COLORS, ICONS } from "../theme.ts";

type Choice = "again" | "back";

export function SetupScreen({ onBack }: { onBack: () => void }) {
  const deps = useDeps();
  const [reports, setReports] = useState<ToolReport[]>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the check on demand
  useEffect(() => {
    let live = true;
    setReports(undefined);
    deps.inspectTools().then((r) => live && setReports(r));
    return () => {
      live = false;
    };
  }, [deps, attempt]);

  const allFound = reports?.every((r) => r.found);

  return (
    <Frame
      crumbs={["Home", "Check setup"]}
      icon={ICONS.setup}
      tone={reports && !allFound ? "warn" : "accent"}
      title="Check setup"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      {!reports ? (
        <Spinner label="Looking for yt-dlp and ffmpeg..." />
      ) : (
        <Box flexDirection="column">
          {reports.map((r) => (
            <Box key={r.tool} flexDirection="column" marginBottom={1}>
              <Text color={r.found ? COLORS.ok : COLORS.error} bold>
                {r.found ? ICONS.ok : ICONS.error} {r.tool}
                <Text color={COLORS.muted} bold={false}>
                  {r.found ? `  ${r.version ?? "unknown version"}  (${r.source})` : "  not found"}
                </Text>
              </Text>
              {r.found ? (
                <Text color={COLORS.muted}>{`  ${r.path}`}</Text>
              ) : (
                <Text color={COLORS.muted}>{`  ${missingToolHint(r.tool, deps.binDir)}`}</Text>
              )}
            </Box>
          ))}
          <Text color={allFound ? COLORS.ok : COLORS.warn}>
            {allFound
              ? "Everything is ready."
              : "Some tools are missing. Downloads will not work until they are installed."}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Menu<Choice>
          initial="back"
          onBack={onBack}
          onSelect={(choice) => (choice === "again" ? setAttempt((n) => n + 1) : onBack())}
          items={[
            { value: "again", icon: ICONS.retry, label: "Check again" },
            { value: "back", icon: ICONS.back, label: "Back" },
          ]}
        />
      </Box>
    </Frame>
  );
}
