import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { ToolReport } from "../../doctor.ts";
import { SUPPORTED_SITES_URL } from "../../sites.ts";
import { aboutRows, developerRows, NOTICES } from "../about.ts";
import { Card } from "../components/Card.tsx";
import { Frame } from "../components/Frame.tsx";
import { Menu } from "../components/Menu.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { useDeps } from "../deps.ts";
import { COLORS, ICONS } from "../theme.ts";

export function AboutScreen({ onBack }: { onBack: () => void }) {
  const deps = useDeps();
  const [reports, setReports] = useState<ToolReport[]>();

  useEffect(() => {
    let live = true;
    deps.inspectTools().then((r) => live && setReports(r));
    return () => {
      live = false;
    };
  }, [deps]);

  return (
    <Frame
      crumbs={["Home", "About"]}
      icon={ICONS.info}
      title="About MediaForge"
      hints={[
        ["Enter", "Back"],
        ["Esc", "Back"],
      ]}
    >
      <Card
        rows={[
          ...aboutRows({
            version: deps.version,
            target: deps.target,
            configPath: deps.configPath,
          }),
          ...developerRows(),
          ["Supported sites", SUPPORTED_SITES_URL],
        ]}
      />
      {!reports ? (
        <Spinner label="Looking for yt-dlp and ffmpeg..." />
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {reports.map((r) => (
            <Text key={r.tool} color={r.found ? undefined : COLORS.error}>
              {r.found ? ICONS.ok : ICONS.error} {r.tool}
              <Text color={COLORS.muted}>
                {r.found
                  ? `  ${r.version ?? "unknown version"}  (${r.source})  ${r.path}`
                  : "  not found"}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginBottom={1}>
        {NOTICES.map((n) => (
          <Text key={n.name} color={COLORS.muted}>
            {n.name}: {n.license}. {n.url}
          </Text>
        ))}
      </Box>
      <Menu<"back">
        onBack={onBack}
        onSelect={onBack}
        items={[{ value: "back", icon: ICONS.back, label: "Back" }]}
      />
    </Frame>
  );
}
