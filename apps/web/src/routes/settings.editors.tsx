import { createFileRoute } from "@tanstack/react-router";

import { EditorsSettings } from "../components/settings/EditorsSettings";

export const Route = createFileRoute("/settings/editors")({
  component: EditorsSettings,
});
