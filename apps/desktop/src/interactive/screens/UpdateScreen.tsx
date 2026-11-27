import type { InstallProgress, Tool, ToolCheck, YtDlpChannel } from "@mediaforge/binary-resolver";
import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
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

type Choice = "again" | "anyway" | "back";

export type UpdateScreenProps =
  | {
      /** A download failed and the user chose to update: install straight away, then retry. */
      mode: "retry";
      /** Called once yt-dlp is updated and the download can be retried. */
      onDone: () => void;
      onBack: () => void;
    }
  | {
      /** "Check for tool updates": look first, download only what the user picks. */
      mode: "check";
      onBack: () => void;
    };

export function UpdateScreen(props: UpdateScreenProps) {
  return props.mode === "retry" ? (
    <RetryUpdate onDone={props.onDone} onBack={props.onBack} />
  ) : (
    <ToolUpdates onBack={props.onBack} />
  );
}

/** What the screen shows besides the progress bar: nothing, an error, or a warning. */
type Problem = { kind: "failed"; message: string } | { kind: "shadowed"; message: string };

/** The warning for a yt-dlp that is used before the downloaded copy, if there is one. */
async function shadowWarning(
  inspect: () => Promise<{ tool: Tool; found: boolean; source?: string; path?: string }[]>,
): Promise<string | undefined> {
  // If the check itself fails, assume the download is the one in use.
  const reports = await inspect().catch(() => []);
  const active = reports.find((r) => r.tool === "yt-dlp" && r.found);
  if (!active || active.source === "cache") return undefined;
  const who = active.source === "env" ? "MEDIAFORGE_YTDLP_PATH" : `A yt-dlp from ${active.source}`;
  return `${who} (${active.path}) is used before the downloaded copy, so this update has no effect. Unset MEDIAFORGE_YTDLP_PATH to use the downloaded one.`;
}

/** How long the "updated" line stays before the download is retried. */
const OUTCOME_MS = 1200;

/** Downloads the newest yt-dlp from the saved channel, then hands control back for the retry. */
function RetryUpdate({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const deps = useDeps();
  const [progress, setProgress] = useState<InstallProgress>();
  const [problem, setProblem] = useState<Problem>();
  const [channel, setChannel] = useState<YtDlpChannel>("stable");
  const [from, setFrom] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The callback changes on every render; keep the latest one without restarting the update.
  const done = useRef(onDone);
  done.current = onDone;

  const start = useCallback(() => {
    setProblem(undefined);
    setProgress(undefined);
    setOutcome(undefined);
    setFrom(undefined);
    let chosen: YtDlpChannel = "stable";
    const update = async () => {
      chosen =
        (await deps.download.settings.load().catch(() => undefined))?.ytDlpChannel ?? "stable";
      if (alive.current) setChannel(chosen);
      // Where the update starts from; leave the line out when the check fails.
      void deps
        .inspectTools()
        .then((reports) => {
          const active = reports.find((r) => r.tool === "yt-dlp" && r.found);
          const version = active ? active.version : "not installed";
          if (alive.current && version) setFrom(version);
        })
        .catch(() => {});
      const result = await deps.installTool("yt-dlp", (p) => {
        if (alive.current) setProgress(p);
      });
      // The download only helps if it is the yt-dlp that gets used.
      const message = await shadowWarning(() => deps.inspectTools());
      if (!alive.current) return;
      if (message) {
        setProblem({
          kind: "shadowed",
          message: `Downloaded yt-dlp ${result.version} (${chosen}). ${message}`,
        });
        return;
      }
      // The next screen clears notices, so show the outcome here for a moment first.
      const before = result.previous ?? "not installed";
      setOutcome(
        result.previous === result.version
          ? `yt-dlp is already up to date (${result.version}, ${chosen})`
          : `yt-dlp updated: ${before} -> ${result.version} (${chosen})`,
      );
      timer.current = setTimeout(() => done.current(), OUTCOME_MS);
    };
    update().catch((error) => {
      if (alive.current) {
        setProblem({
          kind: "failed",
          message: `Could not update yt-dlp to ${chosen}. ${describeInstallFailure(error)}`,
        });
      }
    });
  }, [deps]);

  useEffect(() => {
    alive.current = true;
    start();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
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
      title={`Updating yt-dlp to ${channel}`}
      hints={
        problem
          ? [
              ["↑↓", "Move"],
              ["Enter", "Select"],
              ["Esc", "Back"],
            ]
          : []
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
          <Text>Channel: {channel}</Text>
          {from ? <Text>From: {from}</Text> : null}
          {outcome ? (
            <Text color={COLORS.ok}>{outcome}</Text>
          ) : (
            <>
              <Text>{progress ? describeInstallProgress(progress) : "Starting..."}</Text>
              <ProgressBar percent={progress ? installPercent(progress) : undefined} width={30} />
            </>
          )}
        </Box>
      )}
    </Frame>
  );
}

type UpdateChoice = "yt-dlp" | "ffmpeg" | "all" | "again" | "back";

type View =
  | { kind: "checking" }
  | { kind: "list"; checks: ToolCheck[]; channel: YtDlpChannel; note?: Problem }
  | { kind: "installing"; progress?: InstallProgress };

const CHECKED: Tool[] = ["yt-dlp", "ffmpeg"];
const hasUpdate = (c: ToolCheck | undefined) =>
  c !== undefined && c.error === undefined && !c.upToDate;

/** One row, worded like `mediaforge update --check`. */
function rowText(check: ToolCheck, channel: YtDlpChannel): string {
  const installed = check.installed ?? "not installed";
  if (check.error !== undefined) return `${installed}  could not check: ${check.error}`;
  if (check.upToDate) return `${installed} up to date`;
  const tag = check.tool === "yt-dlp" ? ` (${channel})` : "";
  return `${installed} -> ${check.latest ?? "unknown"}${tag}  update available`;
}

/**
 * Lists yt-dlp and ffmpeg as installed versus newest and downloads only what the user picks.
 * An offline check still shows the installed versions, with a way to try again.
 */
function ToolUpdates({ onBack }: { onBack: () => void }) {
  const deps = useDeps();
  const [view, setView] = useState<View>({ kind: "checking" });
  const alive = useRef(true);

  /** Look at what is installed and what is newest; `note` carries the result of an install. */
  const load = useCallback(
    async (note?: Problem) => {
      setView({ kind: "checking" });
      const channel = (await deps.download.settings.load().catch(() => undefined))?.ytDlpChannel;
      const chosen = channel ?? "stable";
      let checks: ToolCheck[];
      try {
        checks = await deps.checkTools({ channel: chosen });
      } catch (error) {
        // Fall back to what is installed, so the screen is never empty.
        const reports = await deps.inspectTools().catch(() => []);
        const reason = error instanceof Error ? error.message : String(error);
        checks = CHECKED.map((tool) => {
          const report = reports.find((r) => r.tool === tool && r.found);
          return {
            tool,
            ...(report?.version && { installed: report.version }),
            upToDate: false,
            error: reason,
          };
        });
      }
      if (alive.current) setView({ kind: "list", checks, channel: chosen, ...(note && { note }) });
    },
    [deps],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const install = async (tools: Tool[], channel: YtDlpChannel) => {
    setView({ kind: "installing" });
    let note: Problem | undefined;
    try {
      for (const tool of tools) {
        await deps.installTool(
          tool,
          (progress) => {
            if (alive.current) setView({ kind: "installing", progress });
          },
          tool === "ffmpeg" ? { live: true } : { channel },
        );
      }
      if (tools.includes("yt-dlp")) {
        const message = await shadowWarning(() => deps.inspectTools());
        if (message) note = { kind: "shadowed", message };
      }
    } catch (error) {
      note = { kind: "failed", message: describeInstallFailure(error) };
    }
    if (alive.current) await load(note);
  };

  const list = view.kind === "list" ? view : undefined;
  const ytDlp = list?.checks.find((c) => c.tool === "yt-dlp");
  const ffmpeg = list?.checks.find((c) => c.tool === "ffmpeg");
  const items: MenuItem<UpdateChoice>[] = [
    ...(hasUpdate(ytDlp)
      ? [{ value: "yt-dlp" as const, icon: ICONS.download, label: "Update yt-dlp" }]
      : []),
    ...(hasUpdate(ffmpeg)
      ? [{ value: "ffmpeg" as const, icon: ICONS.download, label: "Update ffmpeg" }]
      : []),
    ...(hasUpdate(ytDlp) && hasUpdate(ffmpeg)
      ? [{ value: "all" as const, icon: ICONS.download, label: "Update all" }]
      : []),
    ...(list?.checks.some((c) => c.error !== undefined)
      ? [{ value: "again" as const, icon: ICONS.retry, label: "Try again" }]
      : []),
    { value: "back", icon: ICONS.back, label: "Back" },
  ];

  const onSelect = (choice: UpdateChoice) => {
    if (!list) return;
    if (choice === "back") onBack();
    else if (choice === "again") void load();
    else if (choice === "all") void install(["yt-dlp", "ffmpeg"], list.channel);
    else void install([choice], list.channel);
  };

  return (
    <Frame
      crumbs={["Home", "About", "Tool updates"]}
      icon={ICONS.download}
      tone={list?.note?.kind === "failed" ? "error" : list?.note ? "warn" : "accent"}
      title="Tool updates"
      hints={
        list
          ? [
              ["↑↓", "Move"],
              ["Enter", "Select"],
              ["Esc", "Back"],
            ]
          : []
      }
    >
      {view.kind === "checking" ? (
        <Spinner label="Checking for newer yt-dlp and ffmpeg..." />
      ) : view.kind === "installing" ? (
        <Box flexDirection="column">
          <Text>{view.progress ? describeInstallProgress(view.progress) : "Starting..."}</Text>
          <ProgressBar
            percent={view.progress ? installPercent(view.progress) : undefined}
            width={30}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          {view.checks.map((check) => (
            <Text key={check.tool} wrap="truncate-end">
              {check.error !== undefined ? ICONS.warn : check.upToDate ? ICONS.ok : ICONS.download}{" "}
              {check.tool.padEnd(6)}
              <Text color={COLORS.muted}> {rowText(check, view.channel)}</Text>
            </Text>
          ))}
          {view.note ? (
            <Box marginTop={1}>
              <Text color={view.note.kind === "failed" ? COLORS.error : COLORS.warn}>
                {view.note.message}
              </Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Menu<UpdateChoice>
              key={`${view.checks.map((c) => `${c.tool}${c.installed}${c.error}`).join()}${view.note?.message}`}
              onBack={onBack}
              onSelect={onSelect}
              items={items}
            />
          </Box>
        </Box>
      )}
    </Frame>
  );
}
