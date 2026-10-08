import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { sitesTip } from "../../sites.ts";
import { clipboardHint, shorten } from "../clipboard-hint.ts";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { TextField } from "../components/TextField.tsx";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { useDeps } from "../deps.ts";
import { findLinks, parseLinks, siteOf } from "../links.ts";
import { COLORS, ICONS } from "../theme.ts";

type Clip = { state: "checking" } | { state: "none" } | { state: "links"; links: string[] };
type Choice = "clipboard" | "type" | "back";

/** Blocks submitting until there is at least one link; text that is not a link is skipped. */
export function validateLinks(value: string): string | undefined {
  if (parseLinks(value).links.length > 0) return undefined;
  return value
    ? "No link found. Links start with http:// or https://."
    : "Paste or type at least one link.";
}

export interface LinkScreenProps {
  /** One link or several; the order is the order they were given in. */
  onSubmit: (urls: string[]) => void;
  onBack: () => void;
}

/** How many found links to list under the box before summarising the rest. */
const MAX_LISTED = 6;

/** The live list under the box: every link found (with its site), and what will be skipped. */
function FoundLinks({ text }: { text: string }) {
  const { columns } = useTerminalSize();
  const { links, rejected } = parseLinks(text);
  if (links.length === 0 && rejected.length === 0) {
    return (
      <Text color={COLORS.muted}>
        {ICONS.info} Tip: paste several links at once (one per line or separated by spaces) to
        download them together. They can be from different sites.
      </Text>
    );
  }
  const urlWidth = Math.max(20, Math.min(columns, 100) - 30);
  const sites = links.map(siteOf);
  const siteWidth = Math.max(...sites.map((s) => s.length), 0);
  return (
    <Box flexDirection="column">
      <Text color={COLORS.ok}>
        {ICONS.ok} {links.length === 1 ? "1 link found" : `${links.length} links found`}
        {links.length > 1 ? <Text color={COLORS.muted}> — they will download together</Text> : null}
      </Text>
      {links.slice(0, MAX_LISTED).map((url, i) => (
        <Text key={url}>
          <Text color={COLORS.muted}>{`  ${String(i + 1).padStart(2)}  `}</Text>
          <Text color={COLORS.accent}>{(sites[i] ?? "").padEnd(siteWidth)}</Text>
          <Text color={COLORS.muted}>{`  ${shorten(url, urlWidth)}`}</Text>
        </Text>
      ))}
      {links.length > MAX_LISTED ? (
        <Text color={COLORS.muted}>{`      and ${links.length - MAX_LISTED} more`}</Text>
      ) : null}
      {rejected.length > 0 ? (
        <Text color={COLORS.warn}>
          {ICONS.warn} Skipped (not a link): {shorten(rejected.join(", "), urlWidth)}
        </Text>
      ) : null}
    </Box>
  );
}

export function LinkScreen({ onSubmit, onBack }: LinkScreenProps) {
  const deps = useDeps();
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [clip, setClip] = useState<Clip>({ state: "checking" });

  useEffect(() => {
    if (typing) return;
    let live = true;
    let lastValue: string | null | undefined | false = false;

    const poll = () => {
      deps.readClipboard().then(
        (value) => {
          if (!live || value === lastValue) return;
          lastValue = value;
          const links = findLinks(value);
          setClip(links.length ? { state: "links", links } : { state: "none" });
        },
        () => {
          if (!live || lastValue === null) return;
          lastValue = null;
          setClip({ state: "none" });
        },
      );
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [deps, typing]);

  if (typing) {
    return (
      <Frame
        crumbs={["Home", "Download", "Links"]}
        icon={ICONS.type}
        title="Type or paste one or more links"
        hints={[
          ["Enter", "Continue"],
          ["Ctrl+V", "Paste"],
          ["Ctrl+U", "Clear"],
          ["Esc", "Back"],
        ]}
      >
        <TextField
          multiLine
          placeholder="https://…   (more links: separate with spaces or new lines)"
          validate={validateLinks}
          readClipboard={deps.readClipboard}
          onChange={setText}
          onSubmit={(value) => onSubmit(parseLinks(value).links)}
          onCancel={() => {
            setText("");
            setTyping(false);
          }}
        />
        <Box marginTop={1}>
          <FoundLinks text={text} />
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>
            {ICONS.info} {sitesTip}
          </Text>
        </Box>
      </Frame>
    );
  }

  const clipLinks = clip.state === "links" ? clip.links : [];
  return (
    <Frame
      crumbs={["Home", "Download"]}
      icon={ICONS.link}
      title="What do you want to download?"
      hints={[
        ["↑↓", "Move"],
        ["Enter", "Select"],
        ["Esc", "Back"],
      ]}
    >
      <Text color={COLORS.muted}>
        Copy one link, or several at once, in your browser, then choose the first option.
      </Text>
      <Text color={COLORS.muted}>
        {ICONS.info} {sitesTip}
      </Text>
      <Text> </Text>
      <Menu<Choice>
        key={clip.state}
        initial={clip.state === "links" ? "clipboard" : "type"}
        onBack={onBack}
        onSelect={(choice) => {
          if (choice === "clipboard" && clipLinks.length) onSubmit(clipLinks);
          else if (choice === "type") setTyping(true);
          else if (choice === "back") onBack();
        }}
        items={[
          {
            value: "clipboard",
            icon: ICONS.paste,
            label:
              clipLinks.length > 1
                ? `Use the ${clipLinks.length} links from the clipboard`
                : "Use the link from the clipboard",
            hint: clipboardHint(clip),
            disabled: clipLinks.length === 0,
          },
          {
            value: "type",
            icon: ICONS.type,
            label: "Type or paste links",
            hint: "one or more",
          },
          { value: "back", icon: ICONS.back, label: "Back" },
        ]}
      />
    </Frame>
  );
}
