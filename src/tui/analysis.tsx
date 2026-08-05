import React from "react";
import { Box, Text } from "ink";
import { ActionPalette, type ActionPanelProps } from "./instrument.js";

/** Read-only action surface. Authorization still runs again in the core. */
export function AnalysisPanel(props: ActionPanelProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingX={1}><Text bold color="green">3. INSPECT · READ ONLY</Text></Box>
      <ActionPalette
        {...props}
        mode="analysis"
        title="Read game structure"
        receiptRows={8}
        enablePaging
      />
    </Box>
  );
}
