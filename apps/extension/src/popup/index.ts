import type { ProbedMedia } from "@mediaforge/shared-protocol";
import type { DownloadResult, PopupState } from "../background/controller.ts";
import {
  buildPopupModel,
  type ItemModel,
  type PageSource,
  type PopupModel,
  pendingPicker,
  unreachableModel,
} from "./model.ts";

const root = globalThis as unknown as { browser?: typeof browser; chrome: typeof browser };
const api: typeof browser = root.browser ?? root.chrome;

const app = document.getElementById("app") as HTMLElement;
const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);
const ALL_SITES = { origins: ["<all_urls>"] };

let tabId = -1;
let tabUrl = "";
let picker: { media: ProbedMedia; source: PageSource } | undefined;
let notice: string | undefined;
/** Undefined until checked; only `false` shows the access banner. */
let hostAccess: boolean | undefined;
/** The overlay's pending picker is opened once, on the first state read. */
let pendingChecked = false;

/** Whether the browser granted access to all sites; Firefox lets the user withhold it. */
async function checkHostAccess(): Promise<boolean | undefined> {
  try {
    return await api.permissions.contains(ALL_SITES);
  } catch {
    return undefined;
  }
}

const send = <T>(command: unknown): Promise<T> => api.runtime.sendMessage(command) as Promise<T>;

// Every string shown here is untrusted (pages, core): text nodes only, never HTML.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string; attrs?: Record<string, string> } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs a click handler with the button disabled; failures become an error notice. */
function guarded(button: HTMLButtonElement, action: () => Promise<void>): void {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    action()
      .catch(async (error: unknown) => {
        notice = messageOf(error);
        await refresh();
      })
      .catch(() => {})
      .finally(() => {
        button.disabled = false;
      });
  });
}

function button(text: string, label: string): HTMLButtonElement {
  return el("button", { text, attrs: { "aria-label": label } });
}

function row(title: string, sub: string, button: HTMLButtonElement): HTMLElement {
  return el(
    "div",
    { className: "row" },
    el("div", {}, el("div", { text: title }), el("div", { className: "sub", text: sub })),
    button,
  );
}

function render(model: PopupModel): void {
  const nodes: Node[] = [];
  if (model.access) {
    const allow = button(model.access.button, model.access.button);
    // The request must run inside the click, so it is the first thing the handler does.
    allow.addEventListener("click", () => {
      allow.disabled = true;
      Promise.resolve(api.permissions.request(ALL_SITES))
        .then(async () => {
          hostAccess = await checkHostAccess();
        })
        .catch((error: unknown) => {
          notice = messageOf(error);
        })
        .finally(() => {
          allow.disabled = false;
          void refresh();
        });
    });
    nodes.push(
      el(
        "div",
        { className: "banner", attrs: { "data-tone": "warn", role: "status" } },
        el("span", { text: model.access.text }),
        document.createTextNode(" "),
        allow,
      ),
    );
  }
  if (model.banner) {
    const banner = el("div", {
      className: "banner",
      text: model.banner.text,
      attrs: {
        "data-tone": model.banner.tone,
        role: model.banner.tone === "error" ? "alert" : "status",
      },
    });
    if (model.banner.link) {
      banner.append(
        " ",
        el("a", {
          text: model.banner.link.label,
          attrs: { href: model.banner.link.href, target: "_blank", rel: "noreferrer noopener" },
        }),
      );
    }
    nodes.push(banner);
  }

  if (model.picker && picker) {
    const source = picker.source;
    nodes.push(el("h2", { text: model.picker.title }));
    for (const f of model.picker.formats) {
      const pick = button("Download", `Download ${f.label} ${f.detail}`.trim());
      guarded(pick, () => download(source, f.id));
      nodes.push(row(f.label, f.detail, pick));
    }
    const dismiss = button("Cancel", "Cancel quality selection");
    dismiss.addEventListener("click", () => {
      picker = undefined;
      void refresh();
    });
    nodes.push(dismiss);
  } else {
    if (model.items.length > 0 || model.placeholder) nodes.push(el("h2", { text: "On this page" }));
    if (model.placeholder) {
      nodes.push(el("div", { className: "row" }, el("div", { text: model.placeholder })));
    }
    for (const item of model.items) {
      const start = button("Download", `Download ${item.title}`);
      guarded(start, () => download(item.action));
      nodes.push(row(item.title, item.detail, start));
    }
  }

  if (model.jobs.length > 0) nodes.push(el("h2", { text: "Downloads" }));
  for (const job of model.jobs) {
    const status = job.error ?? (job.percentText || job.status);
    const item = el(
      "div",
      {},
      el("div", { className: "row" }, el("div", { text: job.title }), el("div", { text: status })),
    );
    if (job.active) {
      const pct = Number.parseInt(job.percentText, 10);
      const attrs: Record<string, string> = {
        max: "100",
        "aria-label": `${job.title} progress`,
      };
      if (Number.isFinite(pct)) attrs.value = String(pct);
      const cancel = button("Cancel", `Cancel ${job.title}`);
      guarded(cancel, async () => {
        await send({ kind: "cancel", jobId: job.id });
      });
      item.append(el("progress", { attrs }), cancel);
    }
    nodes.push(item);
  }

  if (model.toggles) {
    nodes.push(
      toggle("Download button on videos", model.toggles.overlay, (v) =>
        setting("extensionUi", v ? "overlay" : "popup"),
      ),
      toggle("Keep MediaForge running", model.toggles.keepRunning, (v) =>
        setting("keepRunning", v),
      ),
    );
  }
  app.replaceChildren(...nodes);
}

function toggle(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => Promise<void>,
): HTMLElement {
  const input = el("input", { attrs: { type: "checkbox" } });
  input.checked = checked;
  input.addEventListener("change", () => {
    input.disabled = true;
    onChange(input.checked)
      .catch(async (error: unknown) => {
        notice = messageOf(error);
        await refresh();
      })
      .catch(() => {})
      .finally(() => {
        input.disabled = false;
      });
  });
  return el("label", { className: "toggle" }, input, el("span", { text: label }));
}

async function setting(key: string, value: string | boolean): Promise<void> {
  const reply = await send<{ ok?: boolean; message?: string } | undefined>({
    kind: "setSetting",
    key,
    value,
  });
  notice =
    reply && reply.ok === false ? (reply.message ?? "Could not change the setting.") : undefined;
  await refresh();
}

async function download(source: ItemModel["action"], variantId?: string): Promise<void> {
  const command = { kind: "download", tabId, source, ...(variantId && { variantId }) };
  const result = await send<DownloadResult>(command);
  notice = undefined;
  picker = undefined;
  if (result.status === "needs-picker") {
    if (source.type === "page") picker = { media: result.media, source };
    else notice = "Could not list quality options for this item.";
  } else if (result.status === "error") {
    notice = result.message;
  }
  await refresh();
}

/** Re-reads state and renders; renders the unreachable banner and returns false on failure. */
async function refresh(): Promise<boolean> {
  try {
    const state = await send<PopupState | undefined>({
      kind: "getState",
      tabId,
      ...(isWebUrl(tabUrl) && { pageUrl: tabUrl }),
    });
    if (!state || typeof state !== "object" || !("connection" in state))
      throw new Error("bad state");
    if (!pendingChecked) {
      pendingChecked = true;
      // An overlay click that needed a quality choice: open the same picker a popup click would.
      picker ??= pendingPicker(state);
    }
    const model = buildPopupModel(state, picker?.media, {
      ...(hostAccess !== undefined && { hostAccess }),
    });
    if (notice) model.banner = { tone: "error", text: notice };
    render(model);
    return true;
  } catch {
    render(unreachableModel());
    return false;
  }
}

async function init(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  tabUrl = tab?.url ?? "";
  api.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { kind?: string } | undefined)?.kind === "stateChanged") void refresh();
  });
  hostAccess = await checkHostAccess();
  if (tabId < 0) {
    render(
      buildPopupModel(undefined, undefined, { ...(hostAccess !== undefined && { hostAccess }) }),
    );
    return;
  }
  if (!(await refresh())) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(await refresh())) return;
  }
  if (isWebUrl(tabUrl)) {
    try {
      await send({ kind: "probe", tabId, url: tabUrl });
    } catch {
      // The next refresh reports whether the background is reachable.
    }
    await refresh();
  }
}

init().catch(() => {
  render(unreachableModel());
});
