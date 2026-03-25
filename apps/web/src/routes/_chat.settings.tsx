import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  LogInIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ProviderKind,
  type ServerConfig,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import {
  getProviderStartOptions,
  isProviderEnabled,
  patchProviderEnabled,
  useAppSettings,
} from "../appSettings";
import {
  getCustomModelOptionsByProvider,
  getCustomModelsForProvider,
  MAX_CUSTOM_MODEL_LENGTH,
  MODEL_PROVIDER_SETTINGS,
  patchCustomModels,
  resolveAppModelSelectionState,
} from "../modelSelection";
import { APP_VERSION } from "../branding";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarTrigger } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { ensureNativeApi, readNativeApi } from "../nativeApi";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;
const PROVIDER_STATUS_AUTO_REFRESH_DEBOUNCE_MS = 300;

type InstallBinarySettingsKey = "claudeBinaryPath" | "codexBinaryPath";
type ProviderCliSource = "override" | "path";

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPathKey: InstallBinarySettingsKey;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const INSTALL_PROVIDER_SETTINGS_BY_PROVIDER: Record<ProviderKind, InstallProviderSettings> = {
  codex: {
    provider: "codex",
    title: "Codex",
    binaryPathKey: "codexBinaryPath",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>codex</code> from your PATH.
      </>
    ),
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    binaryPathKey: "claudeBinaryPath",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: (
      <>
        Leave blank to use <code>claude</code> from your PATH.
      </>
    ),
  },
};

function providerStatusDotClass(status: ServerProviderStatus["status"]): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "warning":
      return "bg-amber-500";
    case "error":
    default:
      return "bg-destructive";
  }
}

function providerStatusSummary(status: ServerProviderStatus | undefined): string {
  if (!status) return "Unknown";
  if (status.available && status.authStatus === "authenticated") return "Ready to use";
  if (!status.available) return "Not found";
  if (status.authStatus === "unauthenticated") return "Not authenticated";
  if (status.status === "ready") return "Detected";
  if (status.status === "warning") return "Warning";
  return "Error";
}

function providerStatusListMessage(status: ServerProviderStatus | undefined): string | null {
  if (!status || status.status === "ready" || status.authStatus === "unauthenticated") {
    return null;
  }
  if (!status.available) {
    return null;
  }
  return status.message ?? null;
}

function resolveProviderCliSource(binaryPathValue: string): ProviderCliSource {
  return binaryPathValue.trim().length > 0 ? "override" : "path";
}

function providerCliSourceLabel(source: ProviderCliSource): string {
  return source === "override" ? "Override" : "PATH";
}

function providerCliDetectionDescription(
  status: ServerProviderStatus | undefined,
  source: ProviderCliSource,
): string {
  if (!status) {
    return source === "override"
      ? "Use Refresh to check whether the configured binary path override is available."
      : "Use Refresh to check whether the default CLI is available on your PATH.";
  }
  if (status.available) {
    return source === "override"
      ? "The configured binary path override was detected and will be used for new sessions."
      : "The default CLI was detected on your PATH and will be used for new sessions.";
  }
  return source === "override"
    ? "The configured binary path override could not be detected. Check the path below or clear it to fall back to your PATH."
    : "The default CLI could not be detected on your PATH.";
}

function shouldShowProviderAlert(status: ServerProviderStatus | undefined): boolean {
  if (!status) return false;
  return !status.available || status.authStatus === "unauthenticated";
}

function providerAlertTitle(status: ServerProviderStatus | undefined): string {
  if (!status || !status.available) return "Provider not found";
  if (status.authStatus === "unauthenticated") return "Not authenticated";
  return "Provider issue";
}

function providerAlertDescription(
  providerTitle: string,
  status: ServerProviderStatus | undefined,
  source: ProviderCliSource,
): string {
  if (!status || !status.available) {
    return source === "override"
      ? "The configured binary path override for this provider could not be detected. Update the path below or clear it to fall back to your PATH."
      : "The default CLI for this provider could not be detected on your PATH. Install it, update your PATH, or use the binary path override below for new sessions.";
  }
  if (status.authStatus === "unauthenticated") {
    return `Log in to ${providerTitle} to start using its models.`;
  }
  return `${providerTitle} needs attention.`;
}

function providerAuthDescription(status: ServerProviderStatus | undefined): string {
  if (!status || !status.available) return "CLI not detected for this provider.";
  if (status.authStatus === "authenticated") return "Authenticated and ready to use.";
  if (status.authStatus === "unauthenticated") {
    return "Provider available but not authenticated.";
  }
  return status.message ?? "Provider available, but authentication could not be verified.";
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <div className="relative overflow-hidden rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  onClick,
}: {
  title: string;
  description: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5"
      data-slot="settings-row"
    >
      <div
        className={cn(
          "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
          onClick && "cursor-pointer",
        )}
        onClick={onClick}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

function SettingsRouteView() {
  const { theme, setTheme } = useTheme();
  const { settings, defaults, updateSettings, resetSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [refreshProviderStatusesError, setRefreshProviderStatusesError] = useState<string | null>(
    null,
  );
  const [openProviderPanels, setOpenProviderPanels] = useState<Record<ProviderKind, boolean>>({
    codex: false,
    claudeAgent: false,
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [showAllCustomModelsByProvider, setShowAllCustomModelsByProvider] = useState<
    Record<ProviderKind, boolean>
  >({
    codex: false,
    claudeAgent: false,
  });

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const claudeBinaryPath = settings.claudeBinaryPath;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;
  const providerStatuses = serverConfigQuery.data?.providers ?? [];
  const providerStartOptions = useMemo(
    () =>
      getProviderStartOptions({
        claudeBinaryPath,
        codexBinaryPath,
        codexHomePath,
      }),
    [claudeBinaryPath, codexBinaryPath, codexHomePath],
  );
  const providerRefreshKey = useMemo(
    () => JSON.stringify(providerStartOptions ?? null),
    [providerStartOptions],
  );
  const lastAutoRefreshKeyRef = useRef<string | null>(null);
  const providerStatusRefreshRequestRef = useRef(0);

  const updateProviderStatuses = useCallback(
    (providers: ServerConfig["providers"]) => {
      queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (existing) =>
        existing ? { ...existing, providers } : existing,
      );
    },
    [queryClient],
  );

  const refreshProviderStatusMutation = useMutation({
    mutationFn: async (provider: ProviderKind) =>
      ensureNativeApi().server.refreshProviderStatus({
        provider,
        providerOptions: providerStartOptions,
      }),
    onMutate: () => {
      setRefreshProviderStatusesError(null);
    },
    onSuccess: (result) => updateProviderStatuses(result.providers),
    onError: (error) => {
      setRefreshProviderStatusesError(
        error instanceof Error ? error.message : "Unable to refresh provider statuses.",
      );
    },
  });

  const providerLoginMutation = useMutation({
    mutationFn: async (provider: ProviderKind) =>
      ensureNativeApi().server.providerLogin({
        provider,
        providerOptions: providerStartOptions,
      }),
    onMutate: () => {
      setRefreshProviderStatusesError(null);
    },
    onSuccess: (result) => {
      updateProviderStatuses(result.providers);
      if (!result.success) {
        setRefreshProviderStatusesError(result.message ?? "Unable to log in provider.");
      }
    },
    onError: (error) => {
      setRefreshProviderStatusesError(
        error instanceof Error ? error.message : "Unable to log in provider.",
      );
    },
  });

  const providerLogoutMutation = useMutation({
    mutationFn: async (provider: ProviderKind) =>
      ensureNativeApi().server.providerLogout({
        provider,
        providerOptions: providerStartOptions,
      }),
    onMutate: () => {
      setRefreshProviderStatusesError(null);
    },
    onSuccess: (result) => {
      updateProviderStatuses(result.providers);
      if (!result.success) {
        setRefreshProviderStatusesError(result.message ?? "Unable to log out provider.");
      }
    },
    onError: (error) => {
      setRefreshProviderStatusesError(
        error instanceof Error ? error.message : "Unable to log out provider.",
      );
    },
  });

  const textGenerationModelSelection = resolveAppModelSelectionState(settings);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    textGenProvider,
    textGenModel,
  );
  const isInstallSettingsDirty =
    settings.claudeBinaryPath !== defaults.claudeBinaryPath ||
    settings.codexBinaryPath !== defaults.codexBinaryPath ||
    settings.codexHomePath !== defaults.codexHomePath;
  const areProviderEnablementSettingsDirty = (
    Object.entries(settings.enabledProviders) as Array<[ProviderKind, boolean]>
  ).some(([provider, enabled]) => enabled !== defaults.enabledProviders[provider]);
  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(settings.timestampFormat !== defaults.timestampFormat ? ["Time format"] : []),
    ...(settings.diffWordWrap !== defaults.diffWordWrap ? ["Diff line wrapping"] : []),
    ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
      ? ["Assistant output"]
      : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? ["New thread mode"] : []),
    ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(JSON.stringify(settings.textGenerationModelSelection ?? null) !==
    JSON.stringify(defaults.textGenerationModelSelection ?? null)
      ? ["Git writing model"]
      : []),
    ...(settings.customCodexModels.length > 0 || settings.customClaudeModels.length > 0
      ? ["Custom models"]
      : []),
    ...(areProviderEnablementSettingsDirty ? ["Enabled providers"] : []),
    ...(isInstallSettingsDirty ? ["Provider installs"] : []),
  ];

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  useEffect(() => {
    if (serverConfigQuery.data == null) return;
    if (lastAutoRefreshKeyRef.current === providerRefreshKey) return;

    lastAutoRefreshKeyRef.current = providerRefreshKey;
    const requestId = providerStatusRefreshRequestRef.current + 1;
    providerStatusRefreshRequestRef.current = requestId;
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void ensureNativeApi()
        .server.refreshProviderStatuses({ providerOptions: providerStartOptions })
        .then((result) => {
          if (cancelled || providerStatusRefreshRequestRef.current !== requestId) return;
          updateProviderStatuses(result.providers);
        })
        .catch((error) => {
          if (cancelled || providerStatusRefreshRequestRef.current !== requestId) return;
          setRefreshProviderStatusesError(
            error instanceof Error ? error.message : "Unable to refresh provider statuses.",
          );
        });
    }, PROVIDER_STATUS_AUTO_REFRESH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [providerRefreshKey, providerStartOptions, serverConfigQuery.data, updateProviderStatuses]);

  async function restoreDefaults() {
    if (changedSettingLabels.length === 0) return;

    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    setCustomModelInputByProvider({
      codex: "",
      claudeAgent: "",
    });
    setCustomModelErrorByProvider({});
    setShowAllCustomModelsByProvider({
      codex: false,
      claudeAgent: false,
    });
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground">Settings</span>
              <div className="ms-auto flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={changedSettingLabels.length === 0}
                  onClick={() => void restoreDefaults()}
                >
                  <RotateCcwIcon className="size-3.5" />
                  Restore defaults
                </Button>
              </div>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={changedSettingLabels.length === 0}
                onClick={() => void restoreDefaults()}
              >
                <RotateCcwIcon className="size-3.5" />
                Restore defaults
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            <SettingsSection title="General">
              <SettingsRow
                title="Theme"
                description="Choose how T3 Code looks across the app."
                resetAction={
                  theme !== "system" ? (
                    <SettingResetButton label="theme" onClick={() => setTheme("system")} />
                  ) : null
                }
                control={
                  <Select
                    value={theme}
                    onValueChange={(value) => {
                      if (value !== "system" && value !== "light" && value !== "dark") return;
                      setTheme(value);
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                      <SelectValue>
                        {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {THEME_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title="Time format"
                description="System default follows your browser or OS clock preference."
                resetAction={
                  settings.timestampFormat !== defaults.timestampFormat ? (
                    <SettingResetButton
                      label="time format"
                      onClick={() =>
                        updateSettings({
                          timestampFormat: defaults.timestampFormat,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Select
                    value={settings.timestampFormat}
                    onValueChange={(value) => {
                      if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                        return;
                      }
                      updateSettings({
                        timestampFormat: value,
                      });
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                      <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="locale">
                        {TIMESTAMP_FORMAT_LABELS.locale}
                      </SelectItem>
                      <SelectItem hideIndicator value="12-hour">
                        {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                      </SelectItem>
                      <SelectItem hideIndicator value="24-hour">
                        {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title="Diff line wrapping"
                description="Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session."
                resetAction={
                  settings.diffWordWrap !== defaults.diffWordWrap ? (
                    <SettingResetButton
                      label="diff line wrapping"
                      onClick={() =>
                        updateSettings({
                          diffWordWrap: defaults.diffWordWrap,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.diffWordWrap}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        diffWordWrap: Boolean(checked),
                      })
                    }
                    aria-label="Wrap diff lines by default"
                  />
                }
              />

              <SettingsRow
                title="Assistant output"
                description="Show token-by-token output while a response is in progress."
                resetAction={
                  settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                    <SettingResetButton
                      label="assistant output"
                      onClick={() =>
                        updateSettings({
                          enableAssistantStreaming: defaults.enableAssistantStreaming,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.enableAssistantStreaming}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        enableAssistantStreaming: Boolean(checked),
                      })
                    }
                    aria-label="Stream assistant messages"
                  />
                }
              />

              <SettingsRow
                title="New threads"
                description="Pick the default workspace mode for newly created draft threads."
                resetAction={
                  settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
                    <SettingResetButton
                      label="new threads"
                      onClick={() =>
                        updateSettings({
                          defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Select
                    value={settings.defaultThreadEnvMode}
                    onValueChange={(value) => {
                      if (value !== "local" && value !== "worktree") return;
                      updateSettings({
                        defaultThreadEnvMode: value,
                      });
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                      <SelectValue>
                        {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="local">
                        Local
                      </SelectItem>
                      <SelectItem hideIndicator value="worktree">
                        New worktree
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title="Delete confirmation"
                description="Ask before deleting a thread and its chat history."
                resetAction={
                  settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                    <SettingResetButton
                      label="delete confirmation"
                      onClick={() =>
                        updateSettings({
                          confirmThreadDelete: defaults.confirmThreadDelete,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.confirmThreadDelete}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        confirmThreadDelete: Boolean(checked),
                      })
                    }
                    aria-label="Confirm thread deletion"
                  />
                }
              />
            </SettingsSection>

            <SettingsSection title="Models">
              <SettingsRow
                title="Git writing model"
                description="Provider and model used for auto-generated git content."
                resetAction={
                  JSON.stringify(settings.textGenerationModelSelection ?? null) !==
                  JSON.stringify(defaults.textGenerationModelSelection ?? null) ? (
                    <SettingResetButton
                      label="git writing model"
                      onClick={() => {
                        updateSettings({
                          textGenerationModelSelection: defaults.textGenerationModelSelection,
                        });
                      }}
                    />
                  ) : null
                }
                control={
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <ProviderModelPicker
                      provider={textGenProvider}
                      model={textGenModel}
                      lockedProvider={null}
                      enabledProviders={settings.enabledProviders}
                      providerStatuses={providerStatuses}
                      modelOptionsByProvider={gitModelOptionsByProvider}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onProviderModelChange={(provider, model) => {
                        updateSettings({
                          textGenerationModelSelection: resolveAppModelSelectionState({
                            ...settings,
                            textGenerationModelSelection: { provider, model },
                          }),
                        });
                      }}
                    />
                    <TraitsPicker
                      provider={textGenProvider}
                      model={textGenModel}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={textGenModelOptions}
                      allowPromptInjectedEffort={false}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onModelOptionsChange={(nextOptions) => {
                        updateSettings({
                          textGenerationModelSelection: resolveAppModelSelectionState({
                            ...settings,
                            textGenerationModelSelection: {
                              provider: textGenProvider,
                              model: textGenModel,
                              ...(nextOptions ? { options: nextOptions } : {}),
                            },
                          }),
                        });
                      }}
                    />
                  </div>
                }
              />
            </SettingsSection>

            <section className="space-y-3">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Providers
              </h2>
              <div className="space-y-3">
                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const isOpen = openProviderPanels[providerSettings.provider];
                  const installProviderSettings =
                    INSTALL_PROVIDER_SETTINGS_BY_PROVIDER[providerSettings.provider];
                  const providerStatus = providerStatuses.find(
                    (status) => status.provider === providerSettings.provider,
                  );
                  const enabled = isProviderEnabled(settings, providerSettings.provider);
                  const isDisabled = !enabled;
                  const isCliDetected = providerStatus?.available === true;
                  const binaryPathValue =
                    installProviderSettings.binaryPathKey === "claudeBinaryPath"
                      ? claudeBinaryPath
                      : codexBinaryPath;
                  const cliSource = resolveProviderCliSource(binaryPathValue);
                  const isInstallOverrideDirty =
                    providerSettings.provider === "codex"
                      ? settings.codexBinaryPath !== defaults.codexBinaryPath ||
                        settings.codexHomePath !== defaults.codexHomePath
                      : settings.claudeBinaryPath !== defaults.claudeBinaryPath;
                  const customModels = getCustomModelsForProvider(
                    settings,
                    providerSettings.provider,
                  );
                  const customModelInput = customModelInputByProvider[providerSettings.provider];
                  const customModelError =
                    customModelErrorByProvider[providerSettings.provider] ?? null;
                  const showAllCustomModels =
                    showAllCustomModelsByProvider[providerSettings.provider];
                  const visibleCustomModels = showAllCustomModels
                    ? customModels
                    : customModels.slice(0, 5);
                  const areCustomModelsDirty =
                    getCustomModelsForProvider(defaults, providerSettings.provider).join(
                      "\u0000",
                    ) !== customModels.join("\u0000");

                  const isAuthenticated = providerStatus?.authStatus === "authenticated";
                  const isAvailable = providerStatus?.available === true;
                  const isAuthActionPending =
                    (providerLoginMutation.isPending &&
                      providerLoginMutation.variables === providerSettings.provider) ||
                    (providerLogoutMutation.isPending &&
                      providerLogoutMutation.variables === providerSettings.provider);
                  const isRefreshPending =
                    refreshProviderStatusMutation.isPending &&
                    refreshProviderStatusMutation.variables === providerSettings.provider;
                  const showProviderAlert = shouldShowProviderAlert(providerStatus);
                  const providerListMessage = providerStatusListMessage(providerStatus);
                  return (
                    <Collapsible
                      key={providerSettings.provider}
                      open={isOpen}
                      onOpenChange={(open) =>
                        setOpenProviderPanels((existing) => ({
                          ...existing,
                          [providerSettings.provider]: open,
                        }))
                      }
                    >
                      <div className="relative overflow-hidden rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-4 py-4 text-left sm:px-5"
                          onClick={() =>
                            setOpenProviderPanels((existing) => ({
                              ...existing,
                              [providerSettings.provider]: !existing[providerSettings.provider],
                            }))
                          }
                        >
                          <span
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              isDisabled
                                ? "bg-warning"
                                : providerStatus
                                  ? providerStatusDotClass(providerStatus.status)
                                  : "bg-muted-foreground/40",
                            )}
                          ></span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {providerSettings.title}
                              </span>
                              {customModels.length > 0 ? (
                                <span className="text-[11px] text-muted-foreground">
                                  {customModels.length} custom model
                                  {customModels.length === 1 ? "" : "s"}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {isDisabled ? "Disabled" : providerStatusSummary(providerStatus)}
                              {providerListMessage ? <> - {providerListMessage}</> : null}
                            </p>
                          </div>
                          <ChevronDownIcon
                            className={cn(
                              "size-4 shrink-0 self-center text-muted-foreground transition-transform",
                              isOpen && "rotate-180",
                            )}
                          />
                        </button>

                        <CollapsibleContent>
                          {showProviderAlert ? (
                            <div
                              className={cn(
                                "flex items-start gap-2.5 border-t px-4 py-3 sm:px-5",
                                !isAvailable
                                  ? "border-destructive/30 bg-destructive/8 text-destructive"
                                  : "border-amber-500/30 bg-amber-500/8 text-amber-600 dark:text-amber-400",
                              )}
                            >
                              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium">
                                  {providerAlertTitle(providerStatus)}
                                </p>
                                <p className="mt-0.5 text-xs opacity-80">
                                  {providerAlertDescription(
                                    providerSettings.title,
                                    providerStatus,
                                    cliSource,
                                  )}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="border-t border-border" />
                          )}
                          <SettingsRow
                            title="Refresh"
                            description="Re-detect CLI availability, version, and auth status."
                            control={
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={isRefreshPending}
                                onClick={() =>
                                  refreshProviderStatusMutation.mutate(providerSettings.provider)
                                }
                              >
                                <RefreshCwIcon
                                  className={cn("size-3.5", isRefreshPending && "animate-spin")}
                                />
                                {isRefreshPending ? "Refreshing…" : "Refresh status"}
                              </Button>
                            }
                          />

                          <SettingsRow
                            title="Enabled"
                            description="Disable this provider to hide it from session creation and model pickers."
                            control={
                              <Switch
                                checked={enabled}
                                onCheckedChange={(checked) =>
                                  updateSettings(
                                    patchProviderEnabled(
                                      settings,
                                      providerSettings.provider,
                                      Boolean(checked),
                                    ),
                                  )
                                }
                                aria-label={`${providerSettings.title} enabled`}
                              />
                            }
                          />

                          <SettingsRow
                            title="Auth status"
                            description={providerAuthDescription(providerStatus)}
                            status={
                              isAuthenticated && providerStatus?.plan ? (
                                <>
                                  Plan:{" "}
                                  <span className="font-medium text-foreground">
                                    {providerStatus.plan}
                                  </span>
                                </>
                              ) : null
                            }
                            control={
                              <div className="flex items-center gap-2">
                                {providerStatus?.authStatus === "unauthenticated" ? (
                                  <Button
                                    size="xs"
                                    variant="default"
                                    disabled={isAuthActionPending}
                                    onClick={() =>
                                      providerLoginMutation.mutate(providerSettings.provider)
                                    }
                                  >
                                    <LogInIcon className="size-3.5" />
                                    {isAuthActionPending ? "Logging in…" : "Log in"}
                                  </Button>
                                ) : null}
                                {providerStatus?.authStatus === "authenticated" ? (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    disabled={isAuthActionPending}
                                    onClick={() =>
                                      providerLogoutMutation.mutate(providerSettings.provider)
                                    }
                                    className="text-muted-foreground hover:text-destructive"
                                  >
                                    <LogOutIcon className="size-3.5" />
                                    {isAuthActionPending ? "Logging out…" : "Log out"}
                                  </Button>
                                ) : null}
                              </div>
                            }
                          />

                          <SettingsRow
                            title="Custom models"
                            description={providerSettings.description}
                            resetAction={
                              areCustomModelsDirty ? (
                                <SettingResetButton
                                  label={`${providerSettings.title} custom models`}
                                  onClick={() => {
                                    updateSettings(
                                      patchCustomModels(providerSettings.provider, [
                                        ...getCustomModelsForProvider(
                                          defaults,
                                          providerSettings.provider,
                                        ),
                                      ]),
                                    );
                                    setCustomModelErrorByProvider((existing) => ({
                                      ...existing,
                                      [providerSettings.provider]: null,
                                    }));
                                    setShowAllCustomModelsByProvider((existing) => ({
                                      ...existing,
                                      [providerSettings.provider]: false,
                                    }));
                                  }}
                                />
                              ) : null
                            }
                          >
                            <div className="mt-3 space-y-3">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <Input
                                  id={`custom-model-slug-${providerSettings.provider}`}
                                  value={customModelInput}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setCustomModelInputByProvider((existing) => ({
                                      ...existing,
                                      [providerSettings.provider]: value,
                                    }));
                                    if (customModelError) {
                                      setCustomModelErrorByProvider((existing) => ({
                                        ...existing,
                                        [providerSettings.provider]: null,
                                      }));
                                    }
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter") return;
                                    event.preventDefault();
                                    addCustomModel(providerSettings.provider);
                                  }}
                                  placeholder={providerSettings.example}
                                  spellCheck={false}
                                />
                                <Button
                                  className="shrink-0"
                                  variant="outline"
                                  onClick={() => addCustomModel(providerSettings.provider)}
                                >
                                  <PlusIcon className="size-3.5" />
                                  Add model
                                </Button>
                              </div>

                              {customModelError ? (
                                <p className="text-xs text-destructive">{customModelError}</p>
                              ) : null}

                              {customModels.length > 0 ? (
                                <div>
                                  <div className="overflow-hidden border border-border/70">
                                    {visibleCustomModels.map((slug) => (
                                      <div
                                        key={`${providerSettings.provider}:${slug}`}
                                        className="group flex items-center gap-3 border-t border-border/60 px-4 py-2 first:border-t-0"
                                      >
                                        <code className="min-w-0 flex-1 truncate text-sm text-foreground">
                                          {slug}
                                        </code>
                                        <button
                                          type="button"
                                          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
                                          aria-label={`Remove ${slug}`}
                                          onClick={() =>
                                            removeCustomModel(providerSettings.provider, slug)
                                          }
                                        >
                                          <XIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>

                                  {customModels.length > 5 ? (
                                    <button
                                      type="button"
                                      className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                                      onClick={() =>
                                        setShowAllCustomModelsByProvider((existing) => ({
                                          ...existing,
                                          [providerSettings.provider]:
                                            !existing[providerSettings.provider],
                                        }))
                                      }
                                    >
                                      {showAllCustomModels
                                        ? "Show less"
                                        : `Show more (${customModels.length - 5})`}
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </SettingsRow>

                          <SettingsRow
                            title="CLI detected"
                            description={providerCliDetectionDescription(providerStatus, cliSource)}
                            control={
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "size-1.5 shrink-0 rounded-full",
                                    providerStatus == null
                                      ? "bg-muted-foreground/40"
                                      : isCliDetected
                                        ? "bg-emerald-500"
                                        : "bg-destructive",
                                  )}
                                />
                                <code className="text-xs font-medium text-muted-foreground">
                                  {providerStatus == null
                                    ? "Unknown"
                                    : isCliDetected
                                      ? `Yes (${providerCliSourceLabel(cliSource)})`
                                      : `No (${providerCliSourceLabel(cliSource)})`}
                                </code>
                              </div>
                            }
                          />

                          {isCliDetected && providerStatus?.version ? (
                            <SettingsRow
                              title="CLI version"
                              description="Version reported by the active provider CLI."
                              control={
                                <code className="text-xs font-medium text-muted-foreground">
                                  {providerStatus.version}
                                </code>
                              }
                            />
                          ) : null}

                          <SettingsRow
                            title="Binary path override"
                            description={installProviderSettings.binaryDescription}
                            resetAction={
                              isInstallOverrideDirty ? (
                                <SettingResetButton
                                  label={`${providerSettings.title} install override`}
                                  onClick={() =>
                                    updateSettings({
                                      claudeBinaryPath:
                                        providerSettings.provider === "claudeAgent"
                                          ? defaults.claudeBinaryPath
                                          : settings.claudeBinaryPath,
                                      codexBinaryPath:
                                        providerSettings.provider === "codex"
                                          ? defaults.codexBinaryPath
                                          : settings.codexBinaryPath,
                                      codexHomePath:
                                        providerSettings.provider === "codex"
                                          ? defaults.codexHomePath
                                          : settings.codexHomePath,
                                    })
                                  }
                                />
                              ) : null
                            }
                          >
                            <Input
                              id={`provider-install-${installProviderSettings.binaryPathKey}`}
                              className="mt-2"
                              value={binaryPathValue}
                              onChange={(event) =>
                                updateSettings(
                                  installProviderSettings.binaryPathKey === "claudeBinaryPath"
                                    ? { claudeBinaryPath: event.target.value }
                                    : { codexBinaryPath: event.target.value },
                                )
                              }
                              placeholder={installProviderSettings.binaryPlaceholder}
                              spellCheck={false}
                            />
                          </SettingsRow>

                          {installProviderSettings.homePathKey ? (
                            <SettingsRow
                              title="CODEX_HOME path"
                              description={
                                installProviderSettings.homeDescription ??
                                "Override the default CODEX_HOME directory."
                              }
                            >
                              <Input
                                id={`provider-install-${installProviderSettings.homePathKey}`}
                                className="mt-2"
                                value={codexHomePath}
                                onChange={(event) =>
                                  updateSettings({
                                    codexHomePath: event.target.value,
                                  })
                                }
                                placeholder={installProviderSettings.homePlaceholder}
                                spellCheck={false}
                              />
                            </SettingsRow>
                          ) : null}
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  );
                })}
                {refreshProviderStatusesError ? (
                  <div className="px-1">
                    <p className="text-xs text-destructive">{refreshProviderStatusesError}</p>
                  </div>
                ) : null}
              </div>
            </section>

            <SettingsSection title="Advanced">
              <SettingsRow
                title="Keybindings"
                description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
                status={
                  <>
                    <span className="block break-all font-mono text-[11px] text-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </span>
                    {openKeybindingsError ? (
                      <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
                    ) : (
                      <span className="mt-1 block">Opens in your preferred editor.</span>
                    )}
                  </>
                }
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open file"}
                  </Button>
                }
              />

              <SettingsRow
                title="Version"
                description="Current application version."
                control={
                  <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
                }
              />
            </SettingsSection>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
