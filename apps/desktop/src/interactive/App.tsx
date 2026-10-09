import { useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { isRequired } from "../doctor.ts";
import type { EngineJob } from "../engine/index.ts";
import type { Settings } from "../settings.ts";
import { BatchFlow } from "./BatchFlow.tsx";
import { type AppDeps, DepsContext } from "./deps.ts";
import {
  type Draft,
  draftSubfolder,
  effectiveFolder,
  nextStep,
  type Plan,
  toPlan,
} from "./flow.ts";
import type { MediaKind } from "./format-choices.ts";
import { useNav } from "./nav.ts";
import { NoticeContext, useNoticeState } from "./notice.tsx";
import { AboutScreen } from "./screens/AboutScreen.tsx";
import { DownloadScreen } from "./screens/DownloadScreen.tsx";
import { FolderScreen } from "./screens/FolderScreen.tsx";
import { FormatsScreen } from "./screens/FormatsScreen.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { LinkScreen } from "./screens/LinkScreen.tsx";
import { LookupScreen } from "./screens/LookupScreen.tsx";
import { QualityScreen } from "./screens/QualityScreen.tsx";
import { type ResultAction, ResultScreen } from "./screens/ResultScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { SetupScreen } from "./screens/SetupScreen.tsx";
import { UpdateScreen } from "./screens/UpdateScreen.tsx";

type Screen =
  | { name: "home" }
  | { name: "link" }
  | { name: "lookup"; url: string }
  | { name: "quality"; draft: Draft; settings: Settings }
  | { name: "formats"; kind: MediaKind; draft: Draft; settings: Settings }
  | { name: "folder"; draft: Draft; settings: Settings }
  /** `run` changes on every retry so the screen starts a fresh download. */
  | { name: "download"; plan: Plan; draft: Draft; run: number }
  | { name: "result"; plan: Plan; draft: Draft; job: EngineJob }
  | { name: "update"; plan: Plan; draft: Draft }
  | { name: "batch"; urls: string[] }
  | { name: "settings" }
  | { name: "setup"; prompt?: boolean; autoDownload?: boolean }
  | { name: "about" };

/** How long to wait for the tool check before opening the link screen anyway. */
const TOOL_CHECK_GRACE_MS = 150;
const SETUP_PROMPT: Screen = { name: "setup", prompt: true };
const wait = (ms: number) => new Promise<undefined>((resolve) => setTimeout(resolve, ms));

export function App({ deps }: { deps: AppDeps }) {
  const { exit } = useApp();
  const nav = useNav<Screen>({ name: "home" });
  const notices = useNoticeState();
  const screen = nav.current;
  /** Counts downloads started, so each (including retries) gets a fresh screen instance. */
  const runCounter = useRef(0);
  const [batchBusy, setBatchBusy] = useState(false);
  /** True while Home checks the tools, so a second pick does not stack another screen. */
  const checkingTools = useRef(false);
  /** Deno is offered once per session; saying no must not block every later download. */
  const offeredOptional = useRef(false);
  const screenName = useRef(screen.name);
  screenName.current = screen.name;

  // Tell the user about a newer release. A failed check (offline) is not worth a message.
  useEffect(() => {
    deps
      .checkUpdate()
      .then((info) => {
        if (info.newer) {
          notices.notify("ok", `MediaForge ${info.latest} is available. Open About to update.`);
        }
      })
      .catch(() => {});
  }, [deps, notices.notify]);

  // Start the slow tool check now, so it is usually done by the time "Download media" is picked.
  useEffect(() => {
    deps.inspectTools().catch(() => {});
  }, [deps]);

  /**
   * Open the link step. A missing tool sends the user to the setup prompt first. The check can
   * take seconds (yt-dlp is slow to start), so when it is not quick the link screen opens at once
   * and the redirect happens later, only if the user is still on it. A failed check is ignored.
   */
  const openDownload = async () => {
    if (checkingTools.current) return;
    checkingTools.current = true;
    try {
      const missing = deps.inspectTools().then(
        (reports) => {
          const required = reports.some((r) => !r.found && isRequired(r.tool));
          const optional = reports.some((r) => !r.found && !isRequired(r.tool));
          if (!required && optional && !offeredOptional.current) {
            offeredOptional.current = true;
            return true;
          }
          return required;
        },
        () => false,
      );
      const quick = await Promise.race([missing, wait(TOOL_CHECK_GRACE_MS)]);
      if (quick === true) {
        nav.push(SETUP_PROMPT);
        return;
      }
      nav.push({ name: "link" });
      if (quick === undefined) {
        void missing.then((isMissing) => {
          if (isMissing && screenName.current === "link") nav.replace(SETUP_PROMPT);
        });
      }
    } finally {
      checkingTools.current = false;
    }
  };

  // Ctrl+C quits everywhere except while downloading, where it cancels the download instead.
  useInput((input, key) => {
    const downloading = screen.name === "download" || (screen.name === "batch" && batchBusy);
    if (key.ctrl && input === "c" && !downloading) exit();
  });

  /**
   * Work out what is still needed for this draft, using the latest saved settings, and go there.
   * `replace` is for waiting screens (the lookup) that should not stay in the history.
   */
  const advance = async (draft: Draft, how: "push" | "replace" = "push") => {
    const settings = await deps.download.settings.load();
    const folderDefault = effectiveFolder(deps.download.env, settings, deps.defaultOutputDir);
    const next = nextStep(draft, settings, folderDefault);
    const go = how === "push" ? nav.push : nav.replace;
    if (next.step === "download") {
      go({
        name: "download",
        plan: toPlan(next.draft, settings.sortByType),
        draft: next.draft,
        run: ++runCounter.current,
      });
    } else if (next.step === "quality") go({ name: "quality", draft: next.draft, settings });
    else go({ name: "folder", draft: next.draft, settings });
  };

  const askQuality = async (draft: Draft) => {
    const settings = await deps.download.settings.load();
    nav.reset(
      { name: "home" },
      { name: "link" },
      {
        name: "quality",
        draft: { ...draft, profileId: undefined, formatSelector: undefined, kind: undefined },
        settings,
      },
    );
  };

  const onResult = async (action: ResultAction, state: Extract<Screen, { name: "result" }>) => {
    if (action === "open" && state.job.outputPath) await deps.openFolder(state.job.outputPath);
    else if (action === "retry") {
      nav.replace({
        name: "download",
        plan: state.plan,
        draft: state.draft,
        run: ++runCounter.current,
      });
    } else if (action === "update") {
      nav.push({ name: "update", plan: state.plan, draft: state.draft });
    } else if (action === "quality") await askQuality(state.draft);
    else if (action === "again") nav.reset({ name: "home" }, { name: "link" });
    else if (action === "home") nav.reset({ name: "home" });
    else if (action === "quit") exit();
  };

  const body = (() => {
    switch (screen.name) {
      case "home":
        return (
          <HomeScreen
            onPick={(choice) => {
              if (choice === "quit") exit();
              else if (choice === "download") void openDownload();
              else if (choice === "settings") nav.push({ name: "settings" });
              else if (choice === "setup") nav.push({ name: "setup" });
              else nav.push({ name: "about" });
            }}
          />
        );
      case "link":
        return (
          <LinkScreen
            onBack={nav.back}
            onSubmit={(urls) =>
              urls.length === 1
                ? nav.push({ name: "lookup", url: urls[0] as string })
                : nav.push({ name: "batch", urls })
            }
          />
        );
      case "lookup":
        return (
          <LookupScreen
            key={screen.url}
            url={screen.url}
            onInfo={(info) => void advance({ url: screen.url, info }, "replace")}
            onSkip={() => void advance({ url: screen.url }, "replace")}
            onChangeLink={nav.back}
          />
        );
      case "quality":
        return (
          <QualityScreen
            draft={screen.draft}
            settings={screen.settings}
            onBack={nav.back}
            onPick={(choice) =>
              "kind" in choice
                ? nav.push({
                    name: "formats",
                    kind: choice.kind,
                    draft: screen.draft,
                    settings: screen.settings,
                  })
                : void advance({
                    ...screen.draft,
                    profileId: choice.profileId,
                    formatSelector: undefined,
                    kind: undefined,
                  })
            }
          />
        );
      case "formats":
        return (
          <FormatsScreen
            info={screen.draft.info ?? {}}
            kind={screen.kind}
            onBack={nav.back}
            onPick={(pick) =>
              void advance({
                ...screen.draft,
                profileId: pick.profileId,
                formatSelector: pick.selector,
                kind: screen.kind,
              })
            }
          />
        );
      case "folder":
        return (
          <FolderScreen
            defaultDir={effectiveFolder(deps.download.env, screen.settings, deps.defaultOutputDir)}
            subfolder={draftSubfolder(screen.draft, screen.settings.sortByType)}
            onBack={nav.back}
            onPick={(dir) => void advance({ ...screen.draft, outputDir: dir })}
          />
        );
      case "download":
        return (
          <DownloadScreen
            key={screen.run}
            plan={screen.plan}
            onDone={(job) => {
              // The result page reports success and failure itself, so its notice shows only once
              // the user leaves it. A cancelled download has no page: say so on the one before.
              if (job.status === "cancelled") notices.notify("warn", "Download cancelled");
              else if (job.status === "completed") notices.notify("ok", "Download complete");
              else notices.notify("error", "Download failed");
              if (job.status === "cancelled") nav.back();
              else nav.replace({ name: "result", plan: screen.plan, draft: screen.draft, job });
            }}
          />
        );
      case "result":
        return (
          <ResultScreen job={screen.job} onAction={(action) => void onResult(action, screen)} />
        );
      case "update":
        return (
          <UpdateScreen
            onBack={nav.back}
            onDone={() =>
              nav.replace({
                name: "download",
                plan: screen.plan,
                draft: screen.draft,
                run: ++runCounter.current,
              })
            }
          />
        );
      case "batch":
        return (
          <BatchFlow
            key={screen.urls.join(" ")}
            urls={screen.urls}
            onLinks={nav.back}
            onHome={() => nav.reset({ name: "home" })}
            onQuit={exit}
            onDownloading={setBatchBusy}
          />
        );
      case "settings":
        return <SettingsScreen onBack={nav.back} />;
      case "setup":
        return (
          <SetupScreen
            onBack={nav.back}
            onReady={screen.prompt ? () => nav.replace({ name: "link" }) : undefined}
            autoDownload={screen.autoDownload}
          />
        );
      case "about":
        return (
          <AboutScreen
            onBack={nav.back}
            onSetup={() => nav.reset({ name: "home" }, { name: "setup", autoDownload: true })}
          />
        );
    }
  })();

  return (
    <DepsContext.Provider value={deps}>
      <NoticeContext.Provider value={notices}>{body}</NoticeContext.Provider>
    </DepsContext.Provider>
  );
}
