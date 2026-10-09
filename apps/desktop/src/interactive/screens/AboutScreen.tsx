import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { isRequired, type ToolReport } from "../../doctor.ts";
import { formatBytes } from "../../progress-view.ts";
import type { UpdateInfo, UpdateProgress } from "../../self-update.ts";
import { SUPPORTED_SITES_URL } from "../../sites.ts";
import { aboutRows, developerRows, NOTICES } from "../about.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu, type MenuItem } from "../components/Menu.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import { describeInstallFailure } from "../install-progress.ts";
import { COLORS, ICONS } from "../theme.ts";

type UpdateState =
  | { kind: "checking" }
  | { kind: "unknown" }
  | { kind: "current" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; progress?: UpdateProgress }
  | { kind: "done"; info: UpdateInfo }
  | { kind: "failed"; info: UpdateInfo; message: string };

type Choice = "update" | "tools" | "back";

export function AboutScreen({ onBack, onSetup }: { onBack: () => void; onSetup: () => void }) {
  const deps = useDeps();
  const [reports, setReports] = useState<ToolReport[]>();
  const [update, setUpdate] = useState<UpdateState>({ kind: "checking" });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    deps
      .checkUpdate()
      .then((info) => {
        if (alive.current)
          setUpdate(info.newer ? { kind: "available", info } : { kind: "current" });
      })
      .catch(() => alive.current && setUpdate({ kind: "unknown" }));
    return () => {
      alive.current = false;
    };
  }, [deps]);

  const install = useCallback(
    (info: UpdateInfo) => {
      setUpdate({ kind: "installing", info });
      deps
        .installUpdate(info, (progress) => {
          if (alive.current) setUpdate({ kind: "installing", info, progress });
        })
        .then(() => alive.current && setUpdate({ kind: "done", info }))
        .catch((error) => {
          if (alive.current) {
            setUpdate({ kind: "failed", info, message: describeInstallFailure(error) });
          }
        });
    },
    [deps],
  );

  const missing = reports?.filter((r) => !r.found) ?? [];

  const canUpdate =
    (update.kind === "available" && update.info.installable) || update.kind === "failed";
  const items: MenuItem<Choice>[] = [
    ...(missing.length > 0
      ? [
          {
            value: "tools" as const,
            icon: ICONS.download,
            label: "Download missing tools",
            hint: missing.map((m) => m.tool).join(" and "),
          },
        ]
      : []),
    ...(canUpdate
      ? [
          {
            value: "update" as const,
            icon: ICONS.download,
            label: update.kind === "failed" ? "Try again" : `Update to ${update.info.latest}`,
          },
        ]
      : []),
    { value: "back", icon: ICONS.back, label: "Back" },
  ];

  useEffect(() => {
    let live = true;
    deps.inspectTools().then((r) => live && setReports(r));
    return () => {
      live = false;
    };
  }, [deps]);

  return (
    <Frame
      crumbs={["Home", "About"]}
      icon={ICONS.info}
      title="About MediaForge"
      hints={[
        ["Enter", "Back"],
        ["Esc", "Back"],
      ]}
    >
      <Card
        rows={[
          ...aboutRows({
            version: deps.version,
            target: deps.target,
            configPath: deps.configPath,
          }),
          ...developerRows(),
          ["Supported sites", SUPPORTED_SITES_URL],
        ]}
      />
      {!reports ? (
        <Spinner label="Looking for yt-dlp, ffmpeg and deno..." />
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {reports.map((r) => (
            <Text
              key={r.tool}
              color={r.found ? undefined : isRequired(r.tool) ? COLORS.error : COLORS.warn}
            >
              {r.found ? ICONS.ok : isRequired(r.tool) ? ICONS.error : ICONS.warn} {r.tool}
              <Text color={COLORS.muted}>
                {r.found
                  ? `  ${r.version ?? "unknown version"}  (${r.source})  ${r.path}`
                  : isRequired(r.tool)
                    ? "  not found"
                    : "  not found (needed for YouTube)"}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginBottom={1}>
        <UpdateStatus state={update} />
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {NOTICES.map((n) => (
          <Text key={n.name} color={COLORS.muted}>
            {n.name}: {n.license}. {n.url}
          </Text>
        ))}
      </Box>
      {update.kind === "installing" ? null : (
        <Menu<Choice>
          key={`${update.kind}-${missing.length}`}
          onBack={onBack}
          onSelect={(choice) => {
            if (choice === "back") onBack();
            else if (choice === "tools") onSetup();
            else if (update.kind === "available" || update.kind === "failed") install(update.info);
          }}
          items={items}
        />
      )}
    </Frame>
  );
}

function UpdateStatus({ state }: { state: UpdateState }) {
  switch (state.kind) {
    case "checking":
      return <Spinner label="Checking for a newer MediaForge..." />;
    case "unknown":
      return <Text color={COLORS.muted}>Could not check for updates. Are you online?</Text>;
    case "current":
      return <Text color={COLORS.ok}>{ICONS.ok} MediaForge is up to date.</Text>;
    case "available":
      return (
        <Box flexDirection="column">
          <Text color={COLORS.warn}>
            {ICONS.warn} Version {state.info.latest} is available (you have {state.info.current}).
          </Text>
          {state.info.installable ? null : (
            <Text color={COLORS.muted}>
              Updating works only in the installed program, not when run through Node.
            </Text>
          )}
        </Box>
      );
    case "installing": {
      const { progress } = state;
      const percent =
        progress?.phase === "downloading" && progress.total
          ? ((progress.received ?? 0) / progress.total) * 100
          : undefined;
      const label =
        progress?.phase === "downloading" && progress.received
          ? `Downloading ${formatBytes(progress.received)}${progress.total ? ` of ${formatBytes(progress.total)}` : ""}`
          : progress?.phase === "verifying"
            ? "Verifying checksum"
            : progress?.phase === "installing"
              ? "Installing"
              : "Starting";
      return (
        <Box flexDirection="column">
          <Text>
            Updating to {state.info.latest}: {label}
          </Text>
          <ProgressBar percent={percent} width={30} />
        </Box>
      );
    }
    case "done":
      return (
        <Text color={COLORS.ok}>
          {ICONS.ok} Updated to {state.info.latest}. Restart MediaForge to use it.
        </Text>
      );
    case "failed":
      return <Text color={COLORS.error}>{state.message}</Text>;
  }
}
