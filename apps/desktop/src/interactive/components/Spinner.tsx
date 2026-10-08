import { Text } from "ink";
import { useEffect, useState } from "react";
import { COLORS, SPINNER_FRAMES } from "../theme.ts";

/** A small ASCII spinner that every console font can draw. */
export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color={COLORS.accent}>{SPINNER_FRAMES[frame]}</Text> {label}
    </Text>
  );
}
