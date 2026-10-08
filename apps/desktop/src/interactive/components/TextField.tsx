import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { COLORS, ICONS } from "../theme.ts";
import { useTerminalSize } from "./use-terminal-size.ts";

export interface TextFieldProps {
  initial?: string;
  placeholder?: string;
  /** Return a message to block submitting, or undefined if the value is fine. */
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Used by Ctrl+V. Terminals that do not paste on their own still get clipboard support. */
  readClipboard?: () => Promise<string | undefined>;
  /** Called with the text after every change, e.g. to show what it contains. */
  onChange?: (value: string) => void;
  /** Insert a line break before each URL-start so multiple links appear on separate lines. */
  multiLine?: boolean;
}

/**
 * Keep pasted text on one line: line breaks and tabs become single spaces (so a pasted list of
 * links stays a list), other control characters go, and a paste loses its outer spaces.
 */
export function cleanPaste(text: string): string {
  const flat = text
    .replace(/\r\n|[\r\n\t]/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "");
  // A single key press keeps its space; anything longer is a paste and is tidied up.
  return text.length > 1 ? flat.replace(/ {2,}/g, " ").trim() : flat;
}

/** Replace any whitespace before a URL-start with \n, keeping each URL on its own line. */
export function splitUrls(text: string): string {
  return text.replace(/\s+(https?:\/\/|www\.)/g, "\n$1").replace(/^\n+/, "");
}

/**
 * Some terminals (classic Windows console) paste a multi-line list as typed lines, each ending in
 * Enter. An Enter followed this quickly by more text is part of a paste, not a submit.
 */
const PASTE_GAP_MS = 40;

/** The part of a long value to show so the cursor stays visible. */
export function visibleSlice(value: string, cursor: number, width: number) {
  const start = cursor > width - 1 ? cursor - (width - 1) : 0;
  return { text: value.slice(start, start + width), cursor: cursor - start };
}

export function TextField({
  initial = "",
  placeholder,
  validate,
  onSubmit,
  onCancel,
  readClipboard,
  onChange,
  multiLine = false,
}: TextFieldProps) {
  const { columns } = useTerminalSize();
  const [value, setValue] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [error, setError] = useState<string>();
  const pendingSubmit = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pendingSubmit.current), []);

  const change = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(nextCursor);
    setError(undefined);
    onChange?.(next);
  };

  const insert = (text: string) => {
    let clean = cleanPaste(text);
    if (!clean) return;
    // Pasting right after other text: keep the two apart, so two links do not run together.
    const sep = value[cursor - 1];
    if (text.length > 1 && cursor > 0 && sep !== " " && sep !== "\n") clean = ` ${clean}`;
    const rawValue = value.slice(0, cursor) + clean + value.slice(cursor);
    const rawCursor = cursor + clean.length;
    if (multiLine) {
      const nextValue = splitUrls(rawValue);
      // Count the \n characters inserted before the cursor to find its new position.
      const nextCursor = splitUrls(rawValue.slice(0, rawCursor)).length;
      change(nextValue, nextCursor);
    } else {
      change(rawValue, rawCursor);
    }
  };

  const submit = (text: string) => {
    const problem = validate?.(text.trim());
    if (problem) setError(problem);
    else onSubmit(text.trim());
  };

  useInput((input, key) => {
    if (pendingSubmit.current && !key.return) {
      // More text right after Enter: that Enter was a line break inside a paste.
      clearTimeout(pendingSubmit.current);
      pendingSubmit.current = undefined;
      if (!key.ctrl && !key.meta && input) {
        insert(` ${input}`);
        return;
      }
    }
    if (key.return) {
      clearTimeout(pendingSubmit.current);
      const text = value;
      pendingSubmit.current = setTimeout(() => {
        pendingSubmit.current = undefined;
        submit(text);
      }, PASTE_GAP_MS);
    } else if (key.escape) onCancel();
    else if (key.ctrl && input === "v") {
      void readClipboard?.().then((text) => text && insert(text));
    } else if (key.ctrl && input === "u") change("", 0);
    else if (key.ctrl && input === "a") setCursor(0);
    else if (key.ctrl && input === "e") setCursor(value.length);
    else if (key.leftArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.rightArrow) setCursor((c) => Math.min(value.length, c + 1));
    else if (key.backspace || key.delete) {
      if (cursor === 0) return;
      change(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
    } else if (!key.ctrl && !key.meta && input) insert(input);
  });

  if (multiLine) {
    const lines = value.split("\n");
    const lineData = lines.map((line, i) => {
      const start = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
      return {
        line,
        start,
        lineCursor: cursor >= start && cursor <= start + line.length ? cursor - start : -1,
        isLast: i === lines.length - 1,
      };
    });

    return (
      <Box flexDirection="column">
        <Box
          borderStyle="single"
          borderColor={error ? COLORS.error : COLORS.accent}
          paddingX={1}
          flexDirection="column"
        >
          {value.length === 0 && placeholder ? (
            <Box>
              <Text color={COLORS.accent}>{ICONS.pointer} </Text>
              <Text inverse> </Text>
              <Text color={COLORS.muted}>{placeholder}</Text>
            </Box>
          ) : (
            lineData.map(({ line, start, lineCursor, isLast }) => {
              const pfx = (
                <Text color={COLORS.accent}>{start === 0 ? `${ICONS.pointer} ` : "  "}</Text>
              );
              if (lineCursor === -1) {
                return (
                  <Box key={start}>
                    {pfx}
                    <Text>{line}</Text>
                  </Box>
                );
              }
              const before = line.slice(0, lineCursor);
              const at = line.slice(lineCursor, lineCursor + 1) || (isLast ? " " : "");
              const after = line.slice(lineCursor + 1);
              return (
                <Box key={start}>
                  {pfx}
                  <Text>
                    {before}
                    <Text inverse>{at}</Text>
                    {after}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
        {error ? (
          <Text color={COLORS.error}>
            {" "}
            {ICONS.error} {error}
          </Text>
        ) : null}
      </Box>
    );
  }

  const width = Math.max(10, Math.min(columns, 100) - 12);
  const shown = visibleSlice(value, cursor, width);
  const before = shown.text.slice(0, shown.cursor);
  const at = shown.text.slice(shown.cursor, shown.cursor + 1) || " ";
  const after = shown.text.slice(shown.cursor + 1);

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={error ? COLORS.error : COLORS.accent} paddingX={1}>
        <Text color={COLORS.accent}>{ICONS.pointer} </Text>
        {value.length === 0 && placeholder ? (
          <>
            <Text inverse> </Text>
            <Text color={COLORS.muted}>{placeholder}</Text>
          </>
        ) : (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        )}
      </Box>
      {error ? (
        <Text color={COLORS.error}>
          {" "}
          {ICONS.error} {error}
        </Text>
      ) : null}
    </Box>
  );
}
