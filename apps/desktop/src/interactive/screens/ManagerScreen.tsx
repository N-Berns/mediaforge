import type { ExtensionToHostMessage, HostToExtensionMessage } from "@mediaforge/shared-protocol";
import {
  type DownloadJob,
  formatLimit,
  LIMIT_PRESETS,
  type LimitPreset,
  type SpeedUnit,
} from "@mediaforge/shared-types";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { CoreLostError } from "../../core/client.ts";
import { type ManagerSort, SORT_COLUMNS } from "../../settings.ts";
import { useTerminalSize } from "../components/use-terminal-size.ts";
import { useDeps } from "../deps.ts";
import {
  type Action,
  confirmText,
  resultText,
  STATUS_MS,
  split,
  targets,
  tooLargeText,
} from "../manager/actions.ts";
import { DetailPanel } from "../manager/DetailPanel.tsx";
import { FilterPanel } from "../manager/FilterPanel.tsx";
import { KeyList } from "../manager/KeyList.tsx";
import { LimitPicker, PRESET_NAMES } from "../manager/LimitPicker.tsx";
import {
  type Filters,
  filterSummary,
  hasFilters,
  matchesFilters,
  matchesSearch,
  NO_FILTERS,
  nextSort,
  scrollWindow,
  sortJobs,
  tickRange,
  visibleColumns,
} from "../manager/model.ts";
import { useCoreSession } from "../manager/session.ts";
import { BOX_COLUMNS, Table, WHEEL_ROWS } from "../manager/Table.tsx";
import { keySequence } from "../mouse/input.ts";
import { Clickable, HoverText, type MouseClick, useMouse } from "../mouse/MouseProvider.tsx";
import { useSpeedUnit } from "../speed-unit.ts";
import { COLORS } from "../theme.ts";

export interface ManagerView {
  cursorId?: string;
  ticks: string[];
  search: string;
  filters: Filters;
}

export interface ManagerScreenProps {
  onBack: () => void;
  /** Opens the link wizard; the app returns here afterwards. */
  onAdd: () => void;
  onSpeedUnit: (unit: SpeedUnit) => void;
  /** View to restore after the wizard; undefined on first open. */
  view?: ManagerView;
  onView?: (view: ManagerView) => void;
  /** Move the cursor to this job once it appears (after Add link). */
  focusId?: string;
  /** Shown in the status line on arrival, e.g. why Add link could not start a download. */
  note?: string;
  /** Called once `focusId` and `note` have been used, so the app can forget them. */
  onFocused?: () => void;
  /** Tests shorten these. */
  renderMs?: number;
  retryMs?: number;
  attentionMs?: number;
}

const EMPTY_VIEW: ManagerView = { ticks: [], search: "", filters: NO_FILTERS };
const DEFAULT_SORT: ManagerSort = { column: "lastTry", descending: true };
/** Header, column header, divider, status line and key bar. */
const FIXED_LINES = 5;
/** Rows shown when the terminal height is unknown (tests, pipes). */
const DEFAULT_LIST_ROWS = 20;
const NOT_CONNECTED = "Not connected.";
const BUSY = "Still working on the last action.";
const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
/** How long "Opened from browser" stays after the browser asked for MediaForge. */
export const ATTENTION_MS = 4000;
const NOTICE_TEXT = {
  unexpected: "Previous session ended unexpectedly.",
  restarted: "MediaForge was restarted.",
} as const;

const KEY_BAR: [string, string][] = [
  ["a", "Add"],
  ["p", "Pause"],
  ["r", "Resume"],
  ["c", "Cancel"],
  ["x", "Remove"],
  ["Del", "Delete"],
  ["/", "Search"],
  ["f", "Filter"],
  ["l", "Limit"],
];

/** As many key hints as fit, always ending with `? Keys`. */
function keyBar(width: number): [string, string][] {
  const keys: [string, string] = ["?", "Keys"];
  const parts: [string, string][] = [...KEY_BAR];
  const length = (list: [string, string][]) =>
    ` ${[...list, keys].map(([k, l]) => `${k} ${l}`).join("  ")}`.length;
  while (parts.length > 0 && length(parts) > width) parts.pop();
  return [...parts, keys];
}

type Failed = { jobId: string; message: string; code?: string }[];

type Mode =
  | { name: "list" }
  | { name: "search" }
  /** `run` acts on the ids captured when the prompt opened, whatever the list does meanwhile. */
  | { name: "confirm"; text: string; run: () => Promise<void> }
  | { name: "limit"; ids: string[]; skipped: number; current?: LimitPreset }
  | { name: "filter" }
  | { name: "detail"; id: string }
  | { name: "keys" };

const errorText = (error: unknown) =>
  error instanceof CoreLostError
    ? NOT_CONNECTED
    : error instanceof Error
      ? error.message
      : String(error);

export function ManagerScreen({
  onBack,
  onSpeedUnit,
  onAdd,
  view: initialView,
  onView,
  focusId,
  note,
  onFocused,
  renderMs,
  retryMs,
  attentionMs = ATTENTION_MS,
}: ManagerScreenProps) {
  const deps = useDeps();
  const contextUnit = useSpeedUnit();
  const { columns: width, rows: height } = useTerminalSize();
  const [attention, setAttention] = useState(false);
  const attentionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onAttention = useCallback(() => {
    deps.flash();
    setAttention(true);
    clearTimeout(attentionTimer.current);
    attentionTimer.current = setTimeout(() => setAttention(false), attentionMs);
  }, [deps, attentionMs]);
  useEffect(() => () => clearTimeout(attentionTimer.current), []);
  const session = useCoreSession(deps.managerCore, {
    onAttention,
    ...(renderMs !== undefined && { renderMs }),
    ...(retryMs !== undefined && { retryMs }),
  });
  const [view, setViewState] = useState<ManagerView>(initialView ?? EMPTY_VIEW);
  const [mode, setMode] = useState<Mode>({ name: "list" });
  const [sort, setSort] = useState<ManagerSort>(DEFAULT_SORT);
  const [status, setStatus] = useState<string>();
  const lastIndex = useRef(0);
  const top = useRef(0);
  const focused = useRef(false);
  /** One request at a time: keys that send something are ignored until the reply. */
  const busy = useRef(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unit = session.settings?.speedUnit ?? contextUnit;
  const ready = session.state === "ready";

  const setView = useCallback(
    (update: (v: ManagerView) => ManagerView) =>
      setViewState((v) => {
        const next = update(v);
        onView?.(next);
        return next;
      }),
    [onView],
  );

  const say = useCallback((text: string) => {
    clearTimeout(statusTimer.current);
    setStatus(text);
    statusTimer.current = setTimeout(() => setStatus(undefined), STATUS_MS);
  }, []);
  useEffect(() => () => clearTimeout(statusTimer.current), []);
  useEffect(() => {
    if (note) say(note);
    // Without a row to wait for, the note was all there was to use.
    if (note && !focusId) onFocused?.();
  }, [note, focusId, say, onFocused]);

  useEffect(() => {
    let live = true;
    deps.download.settings
      .load()
      .then((s) => live && setSort(s.managerSort))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [deps]);

  // A prompt or picker open when the core goes away would act on nothing: close it.
  useEffect(() => {
    if (ready) return;
    setMode((m) => {
      if (m.name !== "confirm" && m.name !== "limit") return m;
      say(NOT_CONNECTED);
      return { name: "list" };
    });
  }, [ready, say]);

  const now = Date.now();
  const all = [...session.jobs.values()];
  /** The rows as they are now, for prompts answered after the list moved on. */
  const latest = useRef(all);
  latest.current = all;
  const shown = sortJobs(
    all.filter((job) => matchesSearch(job, view.search) && matchesFilters(job, view.filters, now)),
    sort,
  );
  const found = shown.findIndex((job) => job.id === view.cursorId);
  const cursor =
    shown.length === 0 ? -1 : found >= 0 ? found : Math.min(lastIndex.current, shown.length - 1);
  if (cursor >= 0) lastIndex.current = cursor;
  const cursorJob = cursor >= 0 ? shown[cursor] : undefined;
  const ticks = new Set(view.ticks);
  const visibleIds = shown.map((job) => job.id);

  // After Add link, put the cursor on the new row as soon as it shows up, unless the search or
  // the filter hides it: a cursor on an invisible row helps nobody.
  const focusVisible = focusId !== undefined && shown.some((job) => job.id === focusId);
  useEffect(() => {
    if (!focusId || focused.current || !session.jobs.has(focusId)) return;
    focused.current = true;
    if (focusVisible) setView((v) => ({ ...v, cursorId: focusId }));
    onFocused?.();
  }, [focusId, focusVisible, session.jobs, setView, onFocused]);

  const notice = session.notice;
  const noticeText = notice
    ? `${NOTICE_TEXT[notice.reason]} ${notice.pausedCount} download${notice.pausedCount === 1 ? " was" : "s were"} paused. ─ R resume all · z dismiss`
    : undefined;
  // Each on its own line, so none hides another (R and z always act on a notice in view).
  const banners = [
    ...(session.state === "reconnecting" ? ["Reconnecting to MediaForge…"] : []),
    ...(session.state === "connecting" ? ["Connecting to MediaForge…"] : []),
    ...(attention ? ["Opened from browser"] : []),
    ...(noticeText ? [noticeText] : []),
  ];
  const listRows = height
    ? Math.max(3, height - 1 - FIXED_LINES - banners.length)
    : DEFAULT_LIST_ROWS;
  top.current = scrollWindow(Math.max(0, cursor), shown.length, listRows, top.current);
  const windowRows = shown.slice(top.current, top.current + listRows);

  const moveTo = (index: number) => {
    const target = shown[Math.max(0, Math.min(shown.length - 1, index))];
    if (target) setView((v) => ({ ...v, cursorId: target.id }));
  };

  /**
   * Moves from the cursor the view holds by then, not the one this render drew: several
   * notches in one read of the terminal arrive before the next render, and each one counts.
   */
  const wheelBy = (step: -1 | 1) => {
    if (shown.length === 0) return;
    setView((v) => {
      const at = shown.findIndex((job) => job.id === v.cursorId);
      const from = at >= 0 ? at : Math.max(0, cursor);
      const target = shown[Math.max(0, Math.min(shown.length - 1, from + step * WHEEL_ROWS))];
      return target ? { ...v, cursorId: target.id } : v;
    });
  };

  const mouse = useMouse();
  /** Clicks reach the list only while nothing is drawn over it. */
  const listMode = mode.name === "list" || mode.name === "search";

  const clickRow = (job: DownloadJob, click: MouseClick) => {
    if (click.ctrl) {
      setView((v) => ({
        ...v,
        ticks: tickRange(v.ticks, visibleIds, cursorJob?.id, job.id),
        cursorId: job.id,
      }));
      return;
    }
    const onBox = BOX_COLUMNS.includes(click.localX);
    setView((v) => ({
      ...v,
      cursorId: job.id,
      ...(onBox && {
        ticks: v.ticks.includes(job.id)
          ? v.ticks.filter((id) => id !== job.id)
          : [...v.ticks, job.id],
      }),
    }));
    if (click.double && !onBox) setMode({ name: "detail", id: job.id });
  };

  /**
   * Run one action at a time. Keys that change something wait for it (and say so); moving,
   * ticking, searching and the panels stay free.
   */
  const lock = (work: () => Promise<void>) => {
    if (busy.current) {
      say(BUSY);
      return;
    }
    busy.current = true;
    work()
      .catch((error) => say(errorText(error)))
      .finally(() => {
        busy.current = false;
      });
  };

  /** An action that needs the core: refused at once while it is away. */
  const send = (work: () => Promise<void>) => {
    if (!busy.current && !ready) {
      say(NOT_CONNECTED);
      return;
    }
    lock(work);
  };

  // Saved through the lock, so it never races the core's own write of the settings file.
  const saveSort = (next: ManagerSort) =>
    lock(async () => {
      setSort(next);
      const saved = await deps.download.settings.load();
      await deps.download.settings.save({ ...saved, managerSort: next });
    });

  const batch = async (type: ExtensionToHostMessage["type"], payload: unknown): Promise<Failed> => {
    const reply: HostToExtensionMessage = await session.request(type, payload);
    return reply.type === "jobs.result" ? reply.payload.failed : [];
  };

  /** The affected rows that fit `action`, with the count of those skipped. */
  const affected = (action: Action) => split(action, targets(shown, ticks, cursorJob?.id));

  const simple = (action: "pause" | "resume", type: "download.pause" | "download.resume") => {
    const { ids, skipped } = affected(action);
    if (ids.length === 0) return say(resultText(action, 0, skipped, []));
    send(async () => {
      const failed = await batch(type, { jobIds: ids });
      say(resultText(action, ids.length - failed.length, skipped, failed));
    });
  };

  const confirm = (text: string | undefined, run: () => Promise<void>) => {
    if (busy.current) say(BUSY);
    else if (text === undefined) send(run);
    else if (!ready) say(NOT_CONNECTED);
    else setMode({ name: "confirm", text, run });
  };

  const cancel = () => {
    const jobs = targets(shown, ticks, cursorJob?.id);
    const { ids, skipped } = split("cancel", jobs);
    if (ids.length === 0) return say(resultText("cancel", 0, skipped, []));
    const chosen = jobs.filter((job) => ids.includes(job.id));
    confirm(confirmText("cancel", chosen), async () => {
      for (const jobId of ids) session.notify("download.cancel", { jobId });
      say(resultText("cancel", ids.length, skipped, []));
    });
  };

  const remove = () => {
    const jobs = targets(shown, ticks, cursorJob?.id);
    if (jobs.length === 0) return say(resultText("remove", 0, 0, []));
    const ids = jobs.map((job) => job.id);
    confirm(confirmText("remove", jobs), async () => {
      const failed = await batch("jobs.remove", { jobIds: ids });
      say(resultText("remove", ids.length - failed.length, 0, failed));
    });
  };

  const trash = () => {
    const jobs = targets(shown, ticks, cursorJob?.id);
    if (jobs.length === 0) return say(resultText("trash", 0, 0, []));
    const ids = jobs.map((job) => job.id);
    confirm(confirmText("trash", jobs), async () => {
      const failed = await batch("jobs.trash", { jobIds: ids });
      const tooLarge = failed.filter((f) => f.code === "too-large").map((f) => f.jobId);
      const other = failed.filter((f) => f.code !== "too-large");
      say(resultText("trash", ids.length - failed.length, 0, other));
      if (tooLarge.length === 0) return;
      setMode({
        name: "confirm",
        text: tooLargeText(tooLarge.length),
        run: async () => {
          const again = await batch("jobs.trash", { jobIds: tooLarge, permanent: true });
          say(resultText("trash", tooLarge.length - again.length, 0, again));
        },
      });
    });
  };

  const clearFinished = () => {
    const done = all.filter((job) => job.status === "completed");
    if (done.length === 0) return say(resultText("clear", 0, 0, []));
    confirm(confirmText("clear", done), async () => {
      // Exactly the rows finished when y is pressed: not one that finishes on the way.
      const ids = latest.current.filter((job) => job.status === "completed").map((j) => j.id);
      if (ids.length === 0) return say(resultText("clear", 0, 0, []));
      const failed = await batch("jobs.remove", { jobIds: ids });
      say(resultText("clear", ids.length - failed.length, 0, failed));
    });
  };

  const openFolder = () => {
    if (cursorJob?.status !== "completed") return say(resultText("open", 0, 1, []));
    const jobId = cursorJob.id;
    send(async () => {
      await session.request("folder.open", { jobId });
    });
  };

  const settings = session.settings;
  const preset = settings?.limitPreset ?? "high";
  const limits = settings?.limits;
  const limitText = (p: LimitPreset) => {
    const value = limits?.[p] ?? null;
    return `${PRESET_NAMES[p]} (${value === null ? "∞" : formatLimit(value, unit)})`;
  };

  const cyclePreset = () => {
    const next = LIMIT_PRESETS[(LIMIT_PRESETS.indexOf(preset) + 1) % LIMIT_PRESETS.length];
    if (!next) return;
    send(async () => {
      await session.request("settings.set", { limitPreset: next });
      say(`Limit: ${limitText(next)}`);
    });
  };

  const toggleUnit = () => {
    const next: SpeedUnit = unit === "bytes" ? "bits" : "bytes";
    send(async () => {
      await session.request("settings.set", { speedUnit: next });
      onSpeedUnit(next);
    });
  };

  const pickLimit = () => {
    const { ids, skipped } = affected("limit");
    if (ids.length === 0) return say(resultText("limit", 0, skipped, []));
    if (!ready) return say(NOT_CONNECTED);
    setMode({
      name: "limit",
      ids,
      skipped,
      ...(cursorJob?.limitOverride && { current: cursorJob.limitOverride }),
    });
  };

  const answer = (yes: boolean) => {
    if (mode.name !== "confirm") return;
    setMode({ name: "list" });
    if (yes) send(mode.run);
  };

  const detailJob = mode.name === "detail" ? session.jobs.get(mode.id) : undefined;
  // The row in the detail panel went away (removed elsewhere), or the picker has no values to
  // show: back to the list, or every key would stay with a panel that is not drawn.
  const orphaned = (mode.name === "detail" && !detailJob) || (mode.name === "limit" && !limits);
  useEffect(() => {
    if (orphaned) setMode({ name: "list" });
  }, [orphaned]);

  const copy = (field: "url" | "path") => {
    if (!detailJob) return;
    const text = field === "url" ? detailJob.request.candidate.url : detailJob.outputPath;
    if (!text) return say("No file yet.");
    void deps
      .writeClipboard(text)
      .then((ok) =>
        say(
          ok
            ? field === "url"
              ? "Copied the link."
              : "Copied the path."
            : "Could not copy to the clipboard.",
        ),
      );
  };

  useInput((input, key) => {
    // An orphaned panel is not drawn: its keys belong to the list again.
    if (!orphaned && mode.name !== "list" && mode.name !== "confirm" && mode.name !== "search") {
      return;
    }
    if (mode.name === "confirm") {
      answer(input === "y" || input === "Y");
      return;
    }
    if (mode.name === "search") {
      if (key.escape) {
        setView((v) => ({ ...v, search: "" }));
        setMode({ name: "list" });
      } else if (key.return) setMode({ name: "list" });
      else if (key.backspace || key.delete) {
        setView((v) => ({ ...v, search: v.search.slice(0, -1) }));
      } else if (input && !key.ctrl && !key.meta) {
        setView((v) => ({ ...v, search: v.search + input }));
      }
      return;
    }
    if (key.upArrow) moveTo(cursor - 1);
    else if (key.downArrow) moveTo(cursor + 1);
    else if (key.pageUp) moveTo(cursor - listRows);
    else if (key.pageDown) moveTo(cursor + listRows);
    else if (key.home) moveTo(0);
    else if (key.end) moveTo(shown.length - 1);
    else if (key.delete) trash();
    else if (key.ctrl && input === "a") {
      setView((v) => {
        const next = new Set(v.ticks);
        const allTicked = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
        for (const id of visibleIds) {
          if (allTicked) next.delete(id);
          else next.add(id);
        }
        return { ...v, ticks: [...next] };
      });
    } else if (key.ctrl) return;
    else if (input === " " && cursorJob) {
      setView((v) => ({
        ...v,
        ticks: v.ticks.includes(cursorJob.id)
          ? v.ticks.filter((id) => id !== cursorJob.id)
          : [...v.ticks, cursorJob.id],
      }));
    } else if (/^[1-6]$/.test(input)) {
      saveSort(nextSort(sort, SORT_COLUMNS[Number(input) - 1] as ManagerSort["column"]));
    } else if (input === "/") setMode({ name: "search" });
    else if (input === "a") {
      if (busy.current) say(BUSY);
      else onAdd();
    } else if (input === "p") simple("pause", "download.pause");
    else if (input === "r") simple("resume", "download.resume");
    else if (input === "c") cancel();
    else if (input === "x") remove();
    else if (input === "C") clearFinished();
    else if (input === "o") openFolder();
    else if (input === "l") cyclePreset();
    else if (input === "L") pickLimit();
    else if (input === "b") toggleUnit();
    else if (input === "f") setMode({ name: "filter" });
    else if (input === "?") setMode({ name: "keys" });
    else if (key.return && cursorJob) setMode({ name: "detail", id: cursorJob.id });
    else if (input === "R" && notice) {
      const jobIds = notice.jobIds;
      send(async () => {
        const failed = await batch("download.resume", { jobIds });
        say(resultText("resume", jobIds.length - failed.length, 0, failed));
      });
    } else if (input === "z" && notice) {
      send(async () => {
        await session.request("notice.dismiss", {});
      });
    } else if (key.escape) {
      if (view.search || hasFilters(view.filters)) {
        setView((v) => ({ ...v, search: "", filters: NO_FILTERS }));
      } else onBack();
    }
  });

  const active = all.filter((job) =>
    ["queued", "downloading", "processing"].includes(job.status),
  ).length;
  const narrowed = view.search !== "" || hasFilters(view.filters);
  const summary = [
    `Limit: ${limitText(preset)}`,
    narrowed ? `${shown.length} of ${items(all.length)}` : items(all.length),
    `${active} active`,
    ...(view.search ? [`search: "${view.search}"`] : []),
    ...(hasFilters(view.filters) ? [`filter: ${filterSummary(view.filters)}`] : []),
  ].join(" · ");

  const body =
    mode.name === "filter" ? (
      <FilterPanel
        filters={view.filters}
        onChange={(filters) => setView((v) => ({ ...v, filters }))}
        onClose={() => setMode({ name: "list" })}
      />
    ) : mode.name === "keys" ? (
      <KeyList onClose={() => setMode({ name: "list" })} />
    ) : detailJob ? (
      <DetailPanel
        job={detailJob}
        unit={unit}
        limits={limits}
        // The space the column header and the rows had.
        height={listRows + 1}
        width={width}
        onClose={() => setMode({ name: "list" })}
        onCopy={copy}
      />
    ) : mode.name === "limit" && limits ? (
      <LimitPicker
        limits={limits}
        unit={unit}
        count={mode.ids.length}
        {...(mode.current && { current: mode.current })}
        onCancel={() => setMode({ name: "list" })}
        onPick={(choice) => {
          const { ids, skipped } = mode;
          setMode({ name: "list" });
          send(async () => {
            const failed = await batch("download.setLimit", { jobIds: ids, preset: choice });
            say(resultText("limit", ids.length - failed.length, skipped, failed));
          });
        }}
      />
    ) : (
      <>
        <Table
          rows={windowRows}
          columns={visibleColumns(width)}
          width={width}
          cursor={cursor - top.current}
          ticks={ticks}
          sort={sort}
          unit={unit}
          now={now}
          active={listMode}
          onRowClick={clickRow}
          onHeaderClick={(column) => saveSort(nextSort(sort, column))}
        />
        {shown.length === 0 && all.length > 0 ? (
          <Text color={COLORS.muted}> No downloads match. Esc clears the filter.</Text>
        ) : null}
      </>
    );

  const footer =
    mode.name === "confirm" ? (
      <Box width={width}>
        <Text> </Text>
        <Clickable modal onClick={() => answer(true)}>
          <HoverText bold color={COLORS.warn}>
            y
          </HoverText>
        </Clickable>
        <Text color={COLORS.warn}>/</Text>
        <Clickable modal onClick={() => answer(false)}>
          <HoverText color={COLORS.warn}>N</HoverText>
        </Clickable>
        <Box flexShrink={1}>
          {/* Wraps rather than cuts: the whole question must be readable. */}
          <Text color={COLORS.warn} wrap="wrap">
            {mode.text.replace(/^y\/N/, "")}
          </Text>
        </Box>
      </Box>
    ) : mode.name === "search" ? (
      <Text wrap="truncate-end">
        <Text color={COLORS.accent}>{" / "}</Text>
        {view.search}
        <Text inverse> </Text>
        <Text color={COLORS.muted}>{"   Enter keep · Esc clear"}</Text>
      </Text>
    ) : (
      <Box width={width} overflow="hidden">
        <Text> </Text>
        {keyBar(width).map(([key, label], i) => (
          <Clickable
            key={key}
            flexShrink={0}
            active={mode.name === "list"}
            onClick={() => {
              const sequence = keySequence(key);
              if (sequence) mouse.inject(sequence);
            }}
          >
            <HoverText color={COLORS.muted}>{`${i > 0 ? "  " : ""}${key} ${label}`}</HoverText>
          </Clickable>
        ))}
      </Box>
    );

  return (
    <Clickable flexDirection="column" width={width} active={listMode} onWheel={wheelBy}>
      <Box width={width} justifyContent="space-between">
        <Text bold color={COLORS.accent} wrap="truncate-end">
          {" MediaForge · Downloads"}
        </Text>
        <Text wrap="truncate-end">{summary}</Text>
      </Box>
      {banners.map((text) => (
        <Text key={text} color={COLORS.warn} wrap="truncate-end">
          {` ${text}`}
        </Text>
      ))}
      {body}
      <Text color={COLORS.muted} wrap="truncate-end">
        {"─".repeat(Math.max(0, width))}
      </Text>
      <Text wrap="truncate-end">{status ? ` ${status}` : " "}</Text>
      {footer}
    </Clickable>
  );
}
