import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  columns: number;
  /** Undefined when output is not a real terminal (tests, pipes). */
  rows: number | undefined;
}

/** Terminal size that updates when the window is resized. */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => {
    const { columns, rows } = stdout as { columns?: number; rows?: number };
    return { columns: columns || 80, rows };
  };
  const [size, setSize] = useState(read);

  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  });

  return size;
}
