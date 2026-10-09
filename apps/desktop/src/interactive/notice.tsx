import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

export type NoticeKind = "ok" | "warn" | "error";

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

export interface NoticeApi {
  notice: Notice | undefined;
  /** Show a notice, replacing any current one. */
  notify: (kind: NoticeKind, text: string) => void;
  /** Called by a screen that shows the notice; the clock starts on the first call. */
  seen: (id: number) => void;
  /** Remove the notice now, e.g. when a new download starts. */
  clear: () => void;
}

/** How long a notice stays once a screen has shown it. */
export const NOTICE_MS = 5000;

export const NoticeContext = createContext<NoticeApi>({
  notice: undefined,
  notify: () => {},
  seen: () => {},
  clear: () => {},
});

/**
 * Holds the one notice shown above the key hints. It outlives screen changes. The clock starts when
 * a screen first shows it, so a notice raised while the user is on a screen that hides it (the
 * result page) is still there when they leave.
 */
export function useNoticeState(ms = NOTICE_MS): NoticeApi {
  const [notice, setNotice] = useState<Notice>();
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const notify = useCallback(
    (kind: NoticeKind, text: string) => {
      stop();
      setNotice({ id: ++counter.current, kind, text });
    },
    [stop],
  );

  const seen = useCallback(
    (id: number) => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setNotice((current) => (current?.id === id ? undefined : current));
      }, ms);
    },
    [ms],
  );

  const clear = useCallback(() => {
    stop();
    setNotice(undefined);
  }, [stop]);

  return useMemo(() => ({ notice, notify, seen, clear }), [notice, notify, seen, clear]);
}
