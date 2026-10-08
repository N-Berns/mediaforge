import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { CliError } from "../../exit-codes.ts";
import type { MediaInfo } from "../../formats.ts";
import { shorten } from "../clipboard-hint.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import { failureHint } from "../hints.ts";
import { COLORS, ICONS } from "../theme.ts";

type State = { status: "loading" } | { status: "failed"; message: string; hint: string };
type Choice = "retry" | "skip" | "change";

export interface LookupScreenProps {
  url: string;
  onInfo: (info: MediaInfo) => void;
  /** Continue without details (the lookup failed or was skipped). */
  onSkip: () => void;
  onChangeLink: () => void;
}

/** Looks up the title and formats of a link before asking about quality. */
export function LookupScreen({ url, onInfo, onSkip, onChangeLink }: LookupScreenProps) {
  const deps = useDeps();
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the lookup on retry
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    deps.fetchInfo(url).then(
      (info) => live && onInfo(info),
      (error: unknown) => {
        if (!live) return;
        const message = error instanceof Error ? error.message : String(error);
        const kind = error instanceof CliError ? error.exitCode : undefined;
        setState({ status: "failed", message, hint: failureHint(kind, message) });
      },
    );
    return () => {
      live = false;
    };
  }, [deps, url, attempt]);

  useInput((_input, key) => key.escape && onChangeLink(), { isActive: state.status === "loading" });

  if (state.status === "loading") {
    return (
      <Frame
        crumbs={["Home", "Download", "Details"]}
        icon={ICONS.info}
        title="Looking up this link"
        hints={[["Esc", "Cancel"]]}
      >
        <Text color={COLORS.muted}>{shorten(url, 80)}</Text>
        <Text> </Text>
        <Spinner label="Reading title and available formats..." />
      </Frame>
    );
  }

  return (
    <Frame
      crumbs={["Home", "Download", "Details"]}
      icon={ICONS.warn}
      tone="warn"
      title="Could not read details for this link"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Change link"],
      ]}
    >
      <Text color={COLORS.error}>
        {ICONS.error} {state.message}
      </Text>
      <Box marginBottom={1}>
        <Text color={COLORS.muted}>{state.hint}</Text>
      </Box>
      <Menu<Choice>
        onBack={onChangeLink}
        onSelect={(choice) => {
          if (choice === "retry") setAttempt((n) => n + 1);
          else if (choice === "skip") onSkip();
          else onChangeLink();
        }}
        items={[
          { value: "retry", icon: ICONS.retry, label: "Try again" },
          {
            value: "skip",
            icon: ICONS.download,
            label: "Download anyway",
            hint: "without details or format choice",
          },
          { value: "change", icon: ICONS.link, label: "Use a different link" },
        ]}
      />
    </Frame>
  );
}
