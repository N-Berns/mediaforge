import { DEFAULT_PROFILE_ID } from "@mediaforge/media-profiles";
import { useEffect, useRef, useState } from "react";
import type { EngineJob } from "../engine/index.ts";
import type { Settings } from "../settings.ts";
import {
  assignAll,
  assignKind,
  type BatchItem,
  choiceFor,
  clearChoices,
  downloadable,
  formatChoice,
  type ItemChoice,
  itemDraft,
  profileChoice,
  waitingItems,
  withOverride,
} from "./batch.ts";
import { useDeps } from "./deps.ts";
import { effectiveFolder, type Plan, toPlan } from "./flow.ts";
import type { MediaKind } from "./format-choices.ts";
import { useNav } from "./nav.ts";
import { BatchDownloadScreen } from "./screens/batch/BatchDownloadScreen.tsx";
import { BatchLookupScreen } from "./screens/batch/BatchLookupScreen.tsx";
import { BatchQualityScreen } from "./screens/batch/BatchQualityScreen.tsx";
import { type BatchResultAction, BatchResultScreen } from "./screens/batch/BatchResultScreen.tsx";
import { BatchReviewScreen, type ReviewChoice } from "./screens/batch/BatchReviewScreen.tsx";
import { FolderScreen } from "./screens/FolderScreen.tsx";
import { FormatsScreen } from "./screens/FormatsScreen.tsx";
import { QualityScreen } from "./screens/QualityScreen.tsx";

/** Every stage that depends on the choices made so far carries its own copy of the items. */
type Stage =
  | { name: "lookup" }
  | { name: "quality"; items: BatchItem[] }
  | { name: "review"; items: BatchItem[]; focus?: ReviewChoice }
  | { name: "item"; items: BatchItem[]; index: number }
  | { name: "item-formats"; items: BatchItem[]; index: number; kind: MediaKind }
  | { name: "folder"; items: BatchItem[] }
  /** `run` changes on every retry so the screen starts fresh downloads. */
  | { name: "download"; plans: Plan[]; run: number }
  | { name: "result"; plans: Plan[]; jobs: EngineJob[] };

export interface BatchFlowProps {
  urls: string[];
  /** Back to the link screen (to change the links, or to download more). */
  onLinks: () => void;
  onHome: () => void;
  onQuit: () => void;
  /** Told when downloads start and stop, so Ctrl+C can cancel them instead of quitting. */
  onDownloading?: (busy: boolean) => void;
}

/** Several links: look them all up, choose a type for each (or per link), then download. */
export function BatchFlow({ urls, onLinks, onHome, onQuit, onDownloading }: BatchFlowProps) {
  const deps = useDeps();
  const nav = useNav<Stage>({ name: "lookup" });
  const stage = nav.current;
  const [settings, setSettings] = useState<Settings>();
  const runs = useRef(0);

  useEffect(() => {
    let live = true;
    deps.download.settings.load().then((s) => live && setSettings(s));
    return () => {
      live = false;
    };
  }, [deps]);

  const downloading = stage.name === "download";
  useEffect(() => {
    onDownloading?.(downloading);
  }, [downloading, onDownloading]);

  if (!settings) return null;

  const folderDefault = effectiveFolder(deps.download.env, settings, deps.defaultOutputDir);

  /** Esc: one step back through the batch, or out to the link screen from its first screen. */
  const back = () => (nav.canGoBack ? nav.back() : onLinks());

  const startDownloads = (dir: string, items: BatchItem[]) => {
    const plans = downloadable(items).map((item) => {
      const plan = toPlan(itemDraft(item, choiceFor(item) as ItemChoice, dir), settings.sortByType);
      // Without details there is no title yet; the link stands in for it.
      return plan.title ? plan : { ...plan, title: item.url };
    });
    nav.push({ name: "download", plans, run: ++runs.current });
  };

  /** After the types are settled: ask for the folder, or go straight to downloading. */
  const toFolder = (items: BatchItem[]) => {
    if (settings.askFolder) nav.push({ name: "folder", items });
    else startDownloads(folderDefault, items);
  };

  switch (stage.name) {
    case "lookup":
      return (
        <BatchLookupScreen
          urls={urls}
          onBack={onLinks}
          onDone={(found) => {
            // Set not to ask about quality: every link uses the saved default.
            if (!settings.askQuality) {
              const saved = profileChoice(settings.quality ?? DEFAULT_PROFILE_ID);
              nav.replace({ name: "review", items: assignAll(found, saved) });
            } else if (waitingItems(found).length === 0) {
              // Nothing can be downloaded, so there is no type to ask about.
              nav.replace({ name: "review", items: found });
            } else nav.replace({ name: "quality", items: found });
          }}
        />
      );
    case "quality":
      return (
        <BatchQualityScreen
          key={nav.depth}
          items={stage.items}
          onBack={back}
          onPick={(kind, id) => {
            const items = assignKind(stage.items, kind, id);
            // Links this type could not cover are asked again, on a new page of history.
            if (waitingItems(items).length > 0) nav.push({ name: "quality", items });
            else nav.push({ name: "review", items });
          }}
        />
      );
    case "review":
      return (
        <BatchReviewScreen
          items={stage.items}
          {...(stage.focus !== undefined && { initial: stage.focus })}
          onSelect={(choice) => {
            if (choice === "start") toFolder(stage.items);
            else if (choice === "all") {
              nav.push({ name: "quality", items: clearChoices(stage.items) });
            } else if (choice === "back") back();
            else nav.push({ name: "item", items: stage.items, index: choice });
          }}
        />
      );
    case "item": {
      const item = stage.items[stage.index] as BatchItem;
      return (
        <QualityScreen
          draft={{ url: item.url, ...(item.info && { info: item.info }) }}
          settings={settings}
          onBack={back}
          onPick={(choice) =>
            "kind" in choice
              ? nav.push({
                  name: "item-formats",
                  items: stage.items,
                  index: stage.index,
                  kind: choice.kind,
                })
              : // Back to Review (dropping this page and the old Review) with the new pick.
                nav.unwind(2, {
                  name: "review",
                  items: withOverride(stage.items, stage.index, profileChoice(choice.profileId)),
                  focus: stage.index,
                })
          }
        />
      );
    }
    case "item-formats": {
      const item = stage.items[stage.index] as BatchItem;
      return (
        <FormatsScreen
          info={item.info ?? {}}
          kind={stage.kind}
          onBack={back}
          onPick={(pick) =>
            nav.unwind(3, {
              name: "review",
              items: withOverride(
                stage.items,
                stage.index,
                formatChoice(item.info ?? {}, stage.kind, pick),
              ),
              focus: stage.index,
            })
          }
        />
      );
    }
    case "folder":
      return (
        <FolderScreen
          defaultDir={folderDefault}
          {...(settings.sortByType && {
            note: "Each file goes into a Video, Video only or Audio folder inside the one you choose.",
          })}
          onBack={back}
          onPick={(dir) => startDownloads(dir, stage.items)}
        />
      );
    case "download":
      return (
        <BatchDownloadScreen
          key={stage.run}
          plans={stage.plans}
          concurrency={settings.concurrency}
          onDone={(jobs) =>
            // Cancelled before anything finished: nothing to report, go back a page.
            // If some links were saved, show what happened to each.
            jobs.length > 0 && jobs.every((j) => j.status === "cancelled")
              ? nav.back()
              : nav.replace({ name: "result", plans: stage.plans, jobs })
          }
        />
      );
    case "result":
      return (
        <BatchResultScreen
          plans={stage.plans}
          jobs={stage.jobs}
          onAction={(action: BatchResultAction) => {
            if (action === "retry") {
              const again = stage.plans.filter((_, i) => stage.jobs[i]?.status !== "completed");
              // On top of the result, so cancelling the retry returns to what was saved before.
              nav.push({ name: "download", plans: again, run: ++runs.current });
            } else if (action === "open") {
              const saved = stage.jobs.find((j) => j.outputPath)?.outputPath;
              if (saved) void deps.openFolder(saved);
            } else if (action === "again") onLinks();
            else if (action === "home") onHome();
            else onQuit();
          }}
        />
      );
  }
}
