import { useApp, useInput } from "ink";
import { useRef, useState } from "react";
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
  | { name: "setup"; prompt?: boolean }
  | { name: "about" };

export function App({ deps }: { deps: AppDeps }) {
  const { exit } = useApp();
  const nav = useNav<Screen>({ name: "home" });
  const screen = nav.current;
  /** Counts downloads started, so each (including retries) gets a fresh screen instance. */
  const runCounter = useRef(0);
  const [batchBusy, setBatchBusy] = useState(false);
  /** True while Home checks the tools, so a second pick does not stack another screen. */
  const checkingTools = useRef(false);

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
              else if (choice === "download") {
                // Check the tools first; if one is missing, offer to download it before the link.
                // Further picks are ignored until the check is over. If it fails, go on to the link.
                if (checkingTools.current) return;
                checkingTools.current = true;
                void deps
                  .inspectTools()
                  .then(
                    (reports): Screen =>
                      reports.every((r) => r.found)
                        ? { name: "link" }
                        : { name: "setup", prompt: true },
                    (): Screen => ({ name: "link" }),
                  )
                  .then(nav.push)
                  .finally(() => {
                    checkingTools.current = false;
                  });
              } else if (choice === "settings") nav.push({ name: "settings" });
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
            onDone={(job) =>
              // A cancelled download leaves nothing to show: go back to the page before it.
              job.status === "cancelled"
                ? nav.back()
                : nav.replace({ name: "result", plan: screen.plan, draft: screen.draft, job })
            }
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
          />
        );
      case "about":
        return <AboutScreen onBack={nav.back} />;
    }
  })();

  return <DepsContext.Provider value={deps}>{body}</DepsContext.Provider>;
}
