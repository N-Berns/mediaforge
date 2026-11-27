import { MAX_DESCRIPTION, type ReportType, type SendResult } from "@mediaforge/shared-types";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { TextField } from "../components/TextField.tsx";
import { useDeps } from "../deps.ts";
import { appDiagnostics, appReport, lastFailure } from "../report.ts";
import { COLORS, ICONS } from "../theme.ts";

const CRUMBS = ["Home", "About", "Report a problem"];

type Step =
  | { kind: "type" }
  | { kind: "describe"; type: ReportType }
  | { kind: "send"; type: ReportType; description: string }
  | { kind: "sending" }
  | { kind: "result"; result: SendResult; retry: () => void };

export function validateDescription(value: string): string | undefined {
  if (value.trim() === "") return "Describe what went wrong first.";
  if (value.trim().length > MAX_DESCRIPTION) {
    return `Keep it under ${MAX_DESCRIPTION} characters.`;
  }
  return undefined;
}

/** Sends a problem report to the same form the extension uses: type, description, details. */
export function ReportScreen({ onBack }: { onBack: () => void }) {
  const deps = useDeps();
  const [step, setStep] = useState<Step>({ kind: "type" });
  const [details, setDetails] = useState<string>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const [tools, history] = await Promise.all([
        deps.inspectTools().catch(() => []),
        deps.readHistory().catch(() => undefined),
      ]);
      if (!alive.current) return;
      setDetails(
        appDiagnostics({
          version: deps.version,
          target: deps.target,
          os: deps.osName,
          tools,
          failure: history === undefined ? undefined : lastFailure(history),
        }),
      );
    })();
    return () => {
      alive.current = false;
    };
  }, [deps]);

  const send = (type: ReportType, description: string, withDetails: boolean) => {
    const run = () => {
      setStep({ kind: "sending" });
      const report = appReport({
        description,
        type,
        version: deps.version,
        os: deps.osName,
        details: withDetails ? details : undefined,
      });
      void deps.sendReport(report).then((result) => {
        if (alive.current) setStep({ kind: "result", result, retry: run });
      });
    };
    run();
  };

  switch (step.kind) {
    case "type":
      return (
        <Frame
          crumbs={CRUMBS}
          icon={ICONS.warn}
          title="What is the problem with?"
          hints={[
            ["↑↓", "Move"],
            ["Enter", "Select"],
            ["Esc", "Back"],
          ]}
        >
          <Menu<ReportType | "back">
            onBack={onBack}
            onSelect={(choice) =>
              choice === "back" ? onBack() : setStep({ kind: "describe", type: choice })
            }
            items={[
              { value: "App", icon: ICONS.app, label: "The app", hint: "this program" },
              { value: "Extension", icon: ICONS.link, label: "The browser extension" },
              { value: "back", icon: ICONS.back, label: "Back" },
            ]}
          />
        </Frame>
      );
    case "describe":
      return (
        <Frame
          crumbs={CRUMBS}
          icon={ICONS.type}
          title="What went wrong?"
          hints={[
            ["Enter", "Continue"],
            ["Ctrl+V", "Paste"],
            ["Ctrl+U", "Clear"],
            ["Esc", "Back"],
          ]}
        >
          <Box marginBottom={1}>
            <Text color={COLORS.muted}>
              Say what you did, what happened and what you expected. The page link helps too.
            </Text>
          </Box>
          <TextField
            placeholder="Describe the problem"
            validate={validateDescription}
            readClipboard={deps.readClipboard}
            onSubmit={(description) =>
              setStep({ kind: "send", type: step.type, description: description.trim() })
            }
            onCancel={() => setStep({ kind: "type" })}
          />
        </Frame>
      );
    case "send":
      return (
        <Frame
          crumbs={CRUMBS}
          icon={ICONS.info}
          title="Send the report?"
          hints={[
            ["↑↓", "Move"],
            ["Enter", "Select"],
            ["Esc", "Back"],
          ]}
        >
          <Box flexDirection="column" marginBottom={1}>
            <Text>Diagnostics to include:</Text>
            {details === undefined ? (
              <Spinner label="Collecting diagnostics..." />
            ) : (
              <Text color={COLORS.muted}>{details}</Text>
            )}
          </Box>
          <Menu<"with" | "without" | "edit">
            onBack={() => setStep({ kind: "describe", type: step.type })}
            onSelect={(choice) => {
              if (choice === "edit") setStep({ kind: "describe", type: step.type });
              else send(step.type, step.description, choice === "with");
            }}
            items={[
              {
                value: "with",
                icon: ICONS.ok,
                label: "Send with diagnostics",
                disabled: details === undefined,
              },
              { value: "without", icon: ICONS.off, label: "Send without diagnostics" },
              { value: "edit", icon: ICONS.back, label: "Edit the description" },
            ]}
          />
        </Frame>
      );
    case "sending":
      return (
        <Frame crumbs={CRUMBS} icon={ICONS.info} title="Sending the report" hints={[]}>
          <Spinner label="Sending..." />
        </Frame>
      );
    case "result": {
      const { result, retry } = step;
      return (
        <Frame
          crumbs={CRUMBS}
          icon={result.ok ? ICONS.ok : ICONS.error}
          title={result.ok ? "Report sent" : "The report was not sent"}
          hints={[
            ["Enter", "Select"],
            ["Esc", "Back"],
          ]}
        >
          <Box marginBottom={1}>
            <Text color={result.ok ? COLORS.ok : COLORS.error}>
              {result.ok ? "Thank you. The report reached the developer." : result.message}
            </Text>
          </Box>
          <Menu<"retry" | "back">
            onBack={onBack}
            onSelect={(choice) => (choice === "retry" ? retry() : onBack())}
            items={[
              ...(result.ok
                ? []
                : [{ value: "retry" as const, icon: ICONS.retry, label: "Try again" }]),
              { value: "back", icon: ICONS.back, label: "Back to About" },
            ]}
          />
        </Frame>
      );
    }
  }
}
