import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Frame } from "../components/Frame.tsx";
import { visibleWindow } from "../components/Menu.tsx";
import { cleanPaste, visibleSlice } from "../components/TextField.tsx";
import { useEnterLock } from "../components/use-enter-lock.ts";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { useDeps } from "../deps.ts";
import {
  completeWith,
  describeFsError,
  folderError,
  folderNameError,
  folderOf,
  pasteTip,
  pathFor,
  type Suggestions,
  startFolder,
  suggestions,
} from "../folder-browser.ts";
import { COLORS, ICONS } from "../theme.ts";

export interface PathPickerProps {
  crumbs: string[];
  /** Where the box opens. A folder that does not exist opens at its nearest parent. */
  startDir: string;
  onPick: (dir: string) => void;
  onCancel: () => void;
}

/** What typing or pasting `input` does to the text: a pasted full path replaces it. */
function insertText(platform: NodeJS.Platform, text: string, input: string): string {
  const clean = cleanPaste(input);
  if (input.length > 1) {
    // "Copy as path" in Windows puts quotes around the path.
    const unquoted = clean.replace(/^"(.*)"$/, "$1");
    if (pathFor(platform).isAbsolute(unquoted)) return unquoted;
    return text + unquoted;
  }
  return text + clean;
}

/**
 * One box for the folder path, with the matching folders listed under it: type to narrow the
 * list, Tab to step into the highlighted folder, Enter to choose the folder shown in the box.
 */
export function PathPickerScreen({ crumbs, startDir, onPick: pick, onCancel }: PathPickerProps) {
  const claim = useEnterLock();
  /** A double Enter picks the folder once. */
  const onPick = (dir: string) => {
    if (claim()) pick(dir);
  };
  const deps = useDeps();
  const { folders } = deps;
  const { columns, rows } = useTerminalSize();
  const platform = folders.platform;
  const p = pathFor(platform);

  const [text, setText] = useState<string>();
  const [result, setResult] = useState<Suggestions>();
  const [index, setIndex] = useState(0);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let live = true;
    void startFolder(folders, startDir).then((dir) => {
      if (live) setText(/[\\/]$/.test(dir) ? dir : `${dir}${p.sep}`);
    });
    return () => {
      live = false;
    };
  }, [folders, startDir, p.sep]);

  useEffect(() => {
    if (text === undefined) return;
    let live = true;
    void suggestions(folders, text).then((found) => {
      if (!live) return;
      setResult(found);
      setIndex(0);
    });
    return () => {
      live = false;
    };
  }, [folders, text]);

  const names = result?.ok ? result.names : [];

  const edit = (change: (current: string) => string) => {
    setText((current) => change(current ?? ""));
    setMessage(undefined);
  };

  /** Enter picks the folder in the box; Ctrl+N creates it first when it does not exist. */
  const choose = async (create: boolean) => {
    const typed = text ?? "";
    const problem = folderError(typed);
    if (problem) return setMessage(problem);
    if (!p.isAbsolute(typed)) return setMessage("Type a full path, starting from the root.");
    const dir = p.resolve(folderOf(platform, typed));
    if (await folders.exists(dir)) return onPick(dir);
    if (!create) return setMessage("This folder does not exist. Press Ctrl+N to create it.");
    const nameProblem = folderNameError(platform, p.basename(dir));
    if (nameProblem) return setMessage(nameProblem);
    if (!(await folders.exists(p.dirname(dir)))) {
      return setMessage("This folder does not exist, and neither does the folder above it.");
    }
    try {
      await folders.mkdir(dir);
      onPick(dir);
    } catch (error) {
      setMessage(describeFsError(error));
    }
  };

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (text === undefined) return;
    else if (key.return) void choose(false);
    else if (key.ctrl && input === "n") void choose(true);
    else if (key.tab) {
      const name = names[index];
      if (name) edit((current) => completeWith(platform, current, name));
    } else if (key.upArrow)
      setIndex((i) => (names.length ? (i - 1 + names.length) % names.length : 0));
    else if (key.downArrow) setIndex((i) => (names.length ? (i + 1) % names.length : 0));
    else if (key.backspace || key.delete) edit((current) => current.slice(0, -1));
    else if (key.ctrl && input === "u") edit(() => "");
    else if (key.ctrl && input === "v") {
      void deps.readClipboard().then((pasted) => {
        if (pasted) edit((current) => insertText(platform, current, pasted));
      });
    } else if (!key.ctrl && !key.meta && input)
      edit((current) => insertText(platform, current, input));
  });

  if (text === undefined) return null;

  const width = Math.max(10, Math.min(columns, 100) - 12);
  const shown = visibleSlice(text, text.length, width);
  const size = rows ? Math.max(3, rows - 22) : 8;
  const { start, end } = visibleWindow(index, names.length, size);

  return (
    <Frame
      crumbs={crumbs}
      icon={ICONS.folder}
      title="Choose a folder"
      hints={[
        ["Tab", "Complete"],
        ["↑↓", "Move"],
        ["Enter", "Choose"],
        ["Ctrl+N", "New"],
        ["Esc", "Cancel"],
      ]}
    >
      <Box borderStyle="single" borderColor={COLORS.accent} paddingX={1}>
        <Text color={COLORS.accent}>{ICONS.pointer} </Text>
        <Text>
          {shown.text}
          <Text inverse> </Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {message ? (
          <Text color={COLORS.warn}>
            {ICONS.warn} {message}
          </Text>
        ) : result && !result.ok ? (
          <Text color={COLORS.muted}>
            {ICONS.info} {result.message}
          </Text>
        ) : names.length === 0 ? (
          <Text color={COLORS.muted}>{ICONS.info} No folders match.</Text>
        ) : (
          <>
            {start > 0 ? <Text color={COLORS.muted}>{`  ${start} more above`}</Text> : null}
            {names.slice(start, end).map((name, offset) => {
              const selected = start + offset === index;
              return (
                <Text key={name}>
                  <Text color={COLORS.accent}>{selected ? `${ICONS.pointer} ` : "  "}</Text>
                  <Text color={selected ? COLORS.accent : undefined} bold={selected}>
                    {ICONS.folder} {name}
                  </Text>
                </Text>
              );
            })}
            {end < names.length ? (
              <Text color={COLORS.muted}>{`  ${names.length - end} more below`}</Text>
            ) : null}
          </>
        )}
      </Box>
      <Text color={COLORS.muted}>
        {ICONS.info} Tip: {pasteTip(platform)}
      </Text>
    </Frame>
  );
}
