import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { CliError } from "../../../exit-codes.ts";
import type { BatchItem } from "../../batch.ts";
import { shorten } from "../../clipboard-hint.ts";
import { Frame } from "../../components/Frame.tsx";
import { Menu, visibleWindow } from "../../components/Menu.tsx";
import { Spinner } from "../../components/Spinner.tsx";
import { useTerminalSize } from "../../components/use-terminal-size.ts";
import { useDeps } from "../../deps.ts";
import { siteOf } from "../../links.ts";
import { COLORS, ICONS } from "../../theme.ts";

/** How many links are looked up at the same time. */
const LOOKUP_CONCURRENCY = 3;

type Entry = { state: "waiting" | "loading" } | { state: "done"; item: BatchItem };
type Choice = "continue" | "retry" | "back";

export interface BatchLookupScreenProps {
  urls: string[];
  onDone: (items: BatchItem[]) => void;
  onBack: () => void;
}

/** Looks up the title and formats of every link, a few at a time, showing how each one went. */
export function BatchLookupScreen({ urls, onDone, onBack }: BatchLookupScreenProps) {
  const deps = useDeps();
  const { columns, rows } = useTerminalSize();
  const [entries, setEntries] = useState<Entry[]>(() => urls.map(() => ({ state: "waiting" })));
  const [round, setRound] = useState(0);
  const latest = useRef(entries);
  latest.current = entries;

  useEffect(() => {
    let live = true;
    // The first round looks up every link; later rounds (Try again) only the ones that failed.
    const todo = latest.current
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => round === 0 || (entry.state === "done" && entry.item.lookupError))
      .map(({ index }) => index);
    const set = (index: number, entry: Entry) =>
      live && setEntries((all) => all.map((e, i) => (i === index ? entry : e)));

    const worker = async () => {
      for (let index = todo.shift(); index !== undefined && live; index = todo.shift()) {
        const url = urls[index] as string;
        set(index, { state: "loading" });
        try {
          set(index, { state: "done", item: { url, info: await deps.fetchInfo(url) } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const kind = error instanceof CliError ? error.exitCode : undefined;
          set(index, {
            state: "done",
            item: {
              url,
              lookupError: message,
              ...(kind !== undefined && { lookupErrorKind: kind }),
            },
          });
        }
      }
    };
    void Promise.all(Array.from({ length: LOOKUP_CONCURRENCY }, worker));
    return () => {
      live = false;
    };
  }, [deps, urls, round]);

  const finished = entries.every((e) => e.state === "done");
  const items = entries.flatMap((e) => (e.state === "done" ? [e.item] : []));
  const failed = items.filter((i) => i.lookupError).length;

  // Everything was found: no need to stop here.
  const reported = useRef(false);
  useEffect(() => {
    if (!finished || failed > 0 || reported.current) return;
    reported.current = true;
    onDone(items);
  });

  useInput((_input, key) => key.escape && onBack(), { isActive: !finished });

  const width = Math.min(columns, 100) - 8;
  const maxRows = rows ? Math.max(3, rows - 18) : 12;
  const focus = Math.max(
    0,
    entries.findIndex((e) => e.state !== "done"),
  );
  const { start, end } = visibleWindow(focus, entries.length, maxRows);
  const done = entries.filter((e) => e.state === "done").length;

  return (
    <Frame
      crumbs={["Home", "Download", "Details"]}
      icon={finished && failed ? ICONS.warn : ICONS.info}
      tone={finished && failed ? "warn" : "accent"}
      title={
        finished
          ? `Could not read details for ${failed} of ${urls.length} links`
          : `Looking up ${urls.length} links`
      }
      hints={
        finished
          ? [
              ["↑↓", "Move"],
              ["Enter", "Select"],
              ["Esc", "Back"],
            ]
          : [["Esc", "Cancel"]]
      }
    >
      {finished ? null : (
        <Spinner label={`Reading titles and formats… ${done} of ${urls.length}`} />
      )}
      <Box flexDirection="column" marginY={1}>
        {entries.slice(start, end).map((entry, offset) => {
          const index = start + offset;
          const url = urls[index] as string;
          const item = entry.state === "done" ? entry.item : undefined;
          const icon = !item
            ? entry.state === "loading"
              ? ICONS.pointer
              : ICONS.off
            : item.lookupError
              ? ICONS.error
              : ICONS.ok;
          const color = !item ? COLORS.muted : item.lookupError ? COLORS.error : COLORS.ok;
          const text = item?.info?.title ?? url;
          return (
            <Box key={url} flexDirection="column">
              <Text>
                <Text color={color}>{icon} </Text>
                <Text color={COLORS.accent}>{siteOf(url)} </Text>
                <Text>{shorten(text, Math.max(10, width - siteOf(url).length - 4))}</Text>
              </Text>
              {item?.lookupError ? (
                <Text color={COLORS.muted}>{`   ${shorten(item.lookupError, width - 3)}`}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {finished ? (
        <Menu<Choice>
          onBack={onBack}
          onSelect={(choice) => {
            if (choice === "continue") onDone(items);
            else if (choice === "retry") setRound((r) => r + 1);
            else onBack();
          }}
          items={[
            {
              value: "continue",
              icon: ICONS.download,
              label: "Continue",
              hint: "links without details can still be downloaded",
            },
            { value: "retry", icon: ICONS.retry, label: "Try the failed links again" },
            { value: "back", icon: ICONS.link, label: "Change the links" },
          ]}
        />
      ) : null}
    </Frame>
  );
}
