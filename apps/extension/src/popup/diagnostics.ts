import type { PopupState } from "../background/controller.ts";

export interface DiagnosticsDecision {
  url: string;
  accepted: boolean;
  reason: string;
}

export interface DiagnosticsInput {
  version: string;
  userAgent: string;
  tab: { id: number; url: string };
  state?: PopupState | undefined;
  /** `undefined` means the permission could not be checked. */
  hostAccess?: boolean | undefined;
  decisions?: DiagnosticsDecision[] | undefined;
  decisionsError?: string | undefined;
}

const MAX_TEXT = 120;

const clip = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;

/** Origin and path only: queries and fragments often carry tokens. */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin === "null") return `${parsed.protocol}${parsed.pathname}`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function connectionLine(state: PopupState): string {
  const c = state.connection;
  if (c.kind === "unavailable") return `${c.kind} (${clip(c.message)})`;
  if (c.kind === "setting-up" && c.percent !== undefined) {
    return `${c.kind} (${Math.round(c.percent)}%)`;
  }
  return c.kind;
}

function toolLine(name: string, tool: { available: boolean; version?: string | undefined }) {
  if (!tool.available) return `${name} missing`;
  return tool.version ? `${name} ${clip(tool.version)}` : `${name} ok`;
}

function hostLine(host: NonNullable<PopupState["host"]>): string {
  return [
    clip(host.hostVersion),
    toolLine("yt-dlp", host.ytDlp),
    toolLine("ffmpeg", host.ffmpeg),
  ].join(" | ");
}

function probeLine(state: PopupState): string {
  const p = state.probe;
  if (p.state === "error") return `error (${clip(p.message)})`;
  if (p.state === "unsupported") return "unsupported";
  if (p.state === "ready") {
    const { formats, subtitles } = p.media;
    // An absent list means the core predates subtitle support.
    const subs = subtitles === undefined ? "not supported by this MediaForge" : subtitles.length;
    return `ready (${formats.length} formats, subtitles: ${subs})`;
  }
  return p.state;
}

/** Plain text for a tester to paste into a message. Contains no cookies, headers or queries. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [
    `MediaForge ${input.version}`,
    `browser: ${input.userAgent}`,
    `tab ${input.tab.id} ${safeUrl(input.tab.url)}`,
    `host access: ${input.hostAccess === undefined ? "unknown" : input.hostAccess ? "granted" : "not granted"}`,
  ];

  const state = input.state;
  if (!state) {
    lines.push("state unavailable");
  } else {
    lines.push(`connection: ${connectionLine(state)}`);
    if (state.host) lines.push(`host: ${hostLine(state.host)}`);
    const s = state.settings;
    lines.push(
      s
        ? `settings: extensionUi=${s.extensionUi} keepRunning=${s.keepRunning}`
        : "settings: unknown",
    );
    lines.push(`probe: ${probeLine(state)}`);
    lines.push(`candidates: ${state.candidates.length}`);
    for (const c of state.candidates) {
      lines.push(`  ${c.streamType} | ${c.kind} | ${safeUrl(c.url)} | ${c.source}`);
    }
    lines.push(`jobs: ${state.jobs.length}`);
    for (const j of state.jobs) {
      lines.push(`  ${j.status}${j.error ? ` ${clip(j.error)}` : ""}`);
    }
  }

  if (input.decisions) {
    lines.push(`detector decisions: ${input.decisions.length}`);
    for (const d of input.decisions) {
      lines.push(`  ${d.accepted ? "accepted" : "rejected"}  ${d.reason}  ${safeUrl(d.url)}`);
    }
  } else {
    lines.push(`detector log unavailable: ${input.decisionsError ?? "unknown"}`);
  }
  return lines.join("\n");
}
