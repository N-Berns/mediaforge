import { Box, type BoxProps, type DOMElement, measureElement, Text, type TextProps } from "ink";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { InputHub } from "./input.ts";

/** A left-button press on a registered box. */
export interface MouseClick {
  x: number;
  y: number;
  /** The cell within the box, from its top-left. */
  localX: number;
  localY: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The second press on the same cell within `DOUBLE_CLICK_MS`. */
  double: boolean;
}

export interface ClickHandlers {
  onClick?: (click: MouseClick) => void;
  /** -1 up, 1 down: one call per wheel notch. */
  onWheel?: (step: -1 | 1) => void;
  /** Modal boxes only: a press that hit no modal box. */
  onOutside?: () => void;
}

export const DOUBLE_CLICK_MS = 400;

interface Entry {
  ref: RefObject<DOMElement | null>;
  handlers: RefObject<ClickHandlers>;
  modal: boolean;
  order: number;
  /** Called when this box becomes, or stops being, the hovered one. */
  hover: (on: boolean) => void;
}

interface MouseApi {
  register: (entry: Omit<Entry, "order">) => () => void;
  inject: (text: string) => void;
  capture: (handler: (text: string) => void) => () => void;
}

const INERT: MouseApi = {
  register: () => () => {},
  inject: () => {},
  capture: () => () => {},
};

const MouseContext = createContext<MouseApi>(INERT);

/** Types keys for the user, or takes the keys away from the screens for a moment. */
export function useMouse(): Pick<MouseApi, "inject" | "capture"> {
  return useContext(MouseContext);
}

export function MouseProvider({
  hub,
  now = Date.now,
  children,
}: {
  hub: InputHub;
  now?: () => number;
  children: ReactNode;
}) {
  const entries = useRef(new Set<Entry>());
  const order = useRef(0);
  const last = useRef<{ x: number; y: number; at: number }>(undefined);
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const hovered = useRef<Entry>(undefined);

  /** Registered boxes under the point that have `need`, smallest first, then newest. */
  const hits = useCallback((r: { x: number; y: number }, need: keyof ClickHandlers) => {
    const all = [...entries.current];
    const modal = all.filter((e) => e.modal);
    const scope = modal.length > 0 ? modal : all;
    return scope
      .flatMap((entry) => {
        const node = entry.ref.current;
        if (!node?.yogaNode || !entry.handlers.current[need]) return [];
        const box = measureElement(node);
        const inside =
          r.x >= box.x && r.x < box.x + box.width && r.y >= box.y && r.y < box.y + box.height;
        return inside ? [{ entry, box }] : [];
      })
      .sort(
        (a, b) =>
          a.box.width * a.box.height - b.box.width * b.box.height || b.entry.order - a.entry.order,
      );
  }, []);

  /** The box a click at the pointer would reach shows as hovered; only changes re-render. */
  const rehover = useCallback(() => {
    const at = pointer.current;
    const next = at ? hits(at, "onClick")[0]?.entry : undefined;
    if (hovered.current === next) return;
    hovered.current?.hover(false);
    hovered.current = next;
    next?.hover(true);
  }, [hits]);

  useEffect(() => {
    return hub.onMouse((r) => {
      if (r.kind === "move") {
        pointer.current = { x: r.x, y: r.y };
        rehover();
        return;
      }
      if (r.kind === "wheel") {
        hits(r, "onWheel")[0]?.entry.handlers.current.onWheel?.(r.button < 0 ? -1 : 1);
        return;
      }
      if (r.kind !== "press" || r.button !== 0) return;
      const at = now();
      const previous = last.current;
      const double =
        previous !== undefined &&
        previous.x === r.x &&
        previous.y === r.y &&
        at - previous.at <= DOUBLE_CLICK_MS;
      // A double-click ends the run: a third quick press starts a new click.
      last.current = double ? undefined : { x: r.x, y: r.y, at };
      const hit = hits(r, "onClick")[0];
      if (!hit) {
        for (const entry of entries.current) {
          if (entry.modal) entry.handlers.current.onOutside?.();
        }
        return;
      }
      hit.entry.handlers.current.onClick?.({
        x: r.x,
        y: r.y,
        localX: r.x - hit.box.x,
        localY: r.y - hit.box.y,
        ctrl: r.ctrl,
        alt: r.alt,
        shift: r.shift,
        double,
      });
    });
  }, [hub, now, hits, rehover]);

  const api = useMemo<MouseApi>(
    () => ({
      register: (entry) => {
        order.current += 1;
        const full = { ...entry, order: order.current };
        entries.current.add(full);
        return () => {
          entries.current.delete(full);
          if (hovered.current === full) hovered.current = undefined;
        };
      },
      inject: (text) => hub.inject(text),
      capture: (handler) => hub.capture(handler),
    }),
    [hub],
  );

  return <MouseContext.Provider value={api}>{children}</MouseContext.Provider>;
}

/** Makes the box behind `ref` take clicks and the wheel while `active`. */
export function useClickable(
  ref: RefObject<DOMElement | null>,
  handlers: ClickHandlers,
  { active = true, modal = false }: { active?: boolean; modal?: boolean } = {},
): boolean {
  const { register } = useContext(MouseContext);
  const latest = useRef(handlers);
  latest.current = handlers;
  const [hovered, setHovered] = useState(false);
  useLayoutEffect(() => {
    if (!active) return;
    const unregister = register({ ref, handlers: latest, modal, hover: setHovered });
    return () => {
      unregister();
      setHovered(false);
    };
  }, [register, ref, active, modal]);
  return active && hovered;
}

/** True inside a `Clickable` while the pointer is over it. */
export const HoverContext = createContext(false);

export function useHovered(): boolean {
  return useContext(HoverContext);
}

/** Ink `Text`, underlined while its `Clickable` is hovered. */
export function HoverText(props: TextProps) {
  const hovered = useHovered();
  return <Text {...props} underline={props.underline || hovered} />;
}

export type ClickableProps = BoxProps &
  ClickHandlers & { active?: boolean; modal?: boolean; children?: ReactNode };

/** A `Box` that takes clicks. */
export function Clickable({
  onClick,
  onWheel,
  onOutside,
  active,
  modal,
  children,
  ...box
}: ClickableProps) {
  const ref = useRef<DOMElement>(null);
  const hovered = useClickable(ref, { onClick, onWheel, onOutside }, { active, modal });
  return (
    <Box ref={ref} {...box}>
      <HoverContext.Provider value={hovered}>{children}</HoverContext.Provider>
    </Box>
  );
}
