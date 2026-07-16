import { EDITORS, type EditorLaunchPreferenceId, type RemoteEditorId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CableIcon, LaptopIcon, RadioTowerIcon, StarIcon } from "lucide-react";

import { isElectron } from "~/env";
import { canLaunchLocalEditors } from "~/editorLaunchContext";
import {
  useClientSettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const REMOTE_EDITOR_OPTIONS: ReadonlyArray<{
  readonly id: RemoteEditorId;
  readonly title: string;
  readonly description: string;
  readonly primaryOptions: ReadonlyArray<{
    readonly id: EditorLaunchPreferenceId;
    readonly label: string;
  }>;
}> = [
  {
    id: "vscode",
    title: "VS Code",
    description: "Open remote workspaces through the machine's SSH config or a VS Code tunnel.",
    primaryOptions: [
      { id: "vscode-ssh", label: "VS Code via SSH" },
      { id: "vscode-tunnel", label: "VS Code Tunnel" },
    ],
  },
  {
    id: "jetbrains",
    title: "JetBrains Gateway",
    description: "Deploy and connect to a JetBrains IDE backend over SSH.",
    primaryOptions: [{ id: "jetbrains-ssh", label: "JetBrains Gateway via SSH" }],
  },
  {
    id: "zed",
    title: "Zed",
    description: "Open the project with Zed's SSH remote development backend.",
    primaryOptions: [{ id: "zed-ssh", label: "Zed via SSH" }],
  },
];

export function EditorsSettings() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const clientSettings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const updatePrimarySettings = useUpdatePrimarySettings();
  const serverConfig = primaryEnvironment?.serverConfig ?? null;
  const serverSettings = serverConfig?.settings ?? null;

  const localEditorsVisible =
    primaryEnvironment !== null &&
    canLaunchLocalEditors({
      entry: primaryEnvironment.entry,
      isElectron,
      locationHostname: window.location.hostname,
    });
  const availableLocalEditors = localEditorsVisible ? (serverConfig?.availableEditors ?? []) : [];
  const localEditorLabels = EDITORS.filter((editor) =>
    availableLocalEditors.includes(editor.id),
  ).map((editor) => ({ id: editor.id, label: editor.label }));

  const sshEnvironmentCount = environments.filter((environment) => {
    const profile = Option.getOrNull(environment.entry.profile);
    return profile?._tag === "SshConnectionProfile";
  }).length;
  const sshConfigEnvironments = environments.filter((environment) => {
    const isLocal = canLaunchLocalEditors({
      entry: environment.entry,
      isElectron,
      locationHostname: window.location.hostname,
    });
    return !isLocal || clientSettings.showRemoteEditorsForLocalTesting;
  });
  const sshStatus = serverConfig?.sshServerStatus ?? null;

  const primaryOptions: Array<{
    readonly id: EditorLaunchPreferenceId;
    readonly label: string;
  }> = [...localEditorLabels];
  for (const remote of REMOTE_EDITOR_OPTIONS) {
    if (clientSettings.remoteEditors[remote.id]) primaryOptions.push(...remote.primaryOptions);
  }
  const primaryEditor =
    primaryOptions.find((option) => option.id === clientSettings.primaryEditor)?.id ??
    primaryOptions[0]?.id ??
    null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Primary editor" icon={<StarIcon className="size-3.5" />}>
        <SettingsRow
          title="Open button default"
          description="The selected launch method appears first and is used by the editor shortcut."
          control={
            <Select
              value={primaryEditor}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  updateClientSettings({ primaryEditor: value as EditorLaunchPreferenceId });
                }
              }}
            >
              <SelectTrigger
                className="w-full sm:w-64"
                aria-label="Primary editor"
                disabled={primaryOptions.length === 0}
              >
                <SelectValue>
                  {primaryOptions.find((option) => option.id === primaryEditor)?.label ??
                    "No editor available"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {primaryOptions.map((option) => (
                  <SelectItem hideIndicator key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Remote editors" icon={<LaptopIcon className="size-3.5" />}>
        {REMOTE_EDITOR_OPTIONS.map((editor) => (
          <SettingsRow
            key={editor.id}
            title={editor.title}
            description={editor.description}
            control={
              <Switch
                checked={clientSettings.remoteEditors[editor.id]}
                onCheckedChange={(checked) =>
                  updateClientSettings({
                    remoteEditors: {
                      ...clientSettings.remoteEditors,
                      [editor.id]: Boolean(checked),
                    },
                  })
                }
                aria-label={`Enable ${editor.title}`}
              />
            }
          />
        ))}
        {localEditorsVisible ? (
          <SettingsRow
            title="Show remote editors for local testing"
            description="Expose SSH editor launch methods for local projects so integrations can be tested against this machine."
            status={
              clientSettings.showRemoteEditorsForLocalTesting
                ? "Uses the configured SSH alias, or localhost when a local SSH server is detected."
                : "Testing option; disabled by default."
            }
            control={
              <Switch
                checked={clientSettings.showRemoteEditorsForLocalTesting}
                onCheckedChange={(checked) =>
                  updateClientSettings({
                    showRemoteEditorsForLocalTesting: Boolean(checked),
                  })
                }
                aria-label="Show remote editors for local testing"
              />
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="SSH" icon={<CableIcon className="size-3.5" />}>
        <SettingsRow
          title="Machine SSH configuration"
          description="SSH editor links reuse each T3 SSH environment's alias, user, and port, allowing the local editor to apply ~/.ssh/config authentication."
          status={
            sshEnvironmentCount > 0
              ? `${sshEnvironmentCount} T3 SSH ${sshEnvironmentCount === 1 ? "environment" : "environments"} available.`
              : "No T3 SSH environments are configured."
          }
        />
        <SettingsRow
          title="SSH server on this environment"
          description="Direct remote web connections are offered only when T3 receives an SSH protocol banner from loopback port 22."
          status={
            !sshStatus?.checked
              ? "Not checked yet."
              : sshStatus.running
                ? `SSH detected locally on port ${sshStatus.port}. External reachability is not guaranteed.`
                : `No SSH server detected on port ${sshStatus.port}.`
          }
        />
        {sshConfigEnvironments.map((environment) => {
          const isLocal = canLaunchLocalEditors({
            entry: environment.entry,
            isElectron,
            locationHostname: window.location.hostname,
          });
          const profile = Option.getOrNull(environment.entry.profile);
          const automaticAlias =
            profile?._tag === "SshConnectionProfile" ? profile.target.alias : null;
          const configuredAlias = clientSettings.editorSshAliases[environment.environmentId] ?? "";
          return (
            <SettingsRow
              key={environment.environmentId}
              title={environment.label}
              description={
                isLocal
                  ? "Optional SSH Host alias from this machine's ~/.ssh/config. Leave empty to use a detected localhost SSH server."
                  : "Optional SSH Host alias from this machine's ~/.ssh/config. Leave empty to use the T3 connection target."
              }
              status={
                configuredAlias
                  ? `Using SSH config alias ${configuredAlias}.`
                  : isLocal
                    ? sshStatus?.running
                      ? "Using localhost after local SSH server detection."
                      : "Remote editor launchers remain unavailable until an SSH alias is set or a local SSH server is detected."
                    : automaticAlias
                      ? `Using T3 SSH alias ${automaticAlias}.`
                      : "Using the direct T3 hostname when local SSH detection succeeds."
              }
              control={
                <Input
                  className="w-full sm:w-56"
                  value={configuredAlias}
                  placeholder={automaticAlias ?? (isLocal ? "localhost" : "my-ssh-host")}
                  aria-label={`SSH alias for ${environment.label}`}
                  onChange={(event) => {
                    const nextAliases = { ...clientSettings.editorSshAliases };
                    const nextAlias = event.currentTarget.value.trim();
                    if (nextAlias) nextAliases[environment.environmentId] = nextAlias;
                    else delete nextAliases[environment.environmentId];
                    updateClientSettings({ editorSshAliases: nextAliases });
                  }}
                />
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="VS Code tunnel" icon={<RadioTowerIcon className="size-3.5" />}>
        <SettingsRow
          title="Detect remote tunnels"
          description="Check this environment for a connected VS Code tunnel and add it to Open In."
          status={
            !serverSettings?.enableVSCodeRemoteTunnels
              ? "Disabled."
              : serverConfig?.vscodeTunnelStatus.connected
                ? `Connected as ${serverConfig.vscodeTunnelStatus.machineName ?? "unknown"}.`
                : serverConfig?.vscodeTunnelStatus.checked
                  ? "No connected tunnel detected."
                  : "Waiting for tunnel status."
          }
          control={
            <Switch
              checked={serverSettings?.enableVSCodeRemoteTunnels ?? false}
              disabled={!serverSettings}
              onCheckedChange={(checked) =>
                updatePrimarySettings({ enableVSCodeRemoteTunnels: Boolean(checked) })
              }
              aria-label="Detect VS Code remote tunnels"
            />
          }
        />
        <SettingsRow
          title="Open tunnel in VS Code Desktop"
          description="Use the vscode:// handler instead of opening vscode.dev."
          control={
            <Switch
              checked={clientSettings.openVSCodeRemoteTunnelsInDesktop}
              onCheckedChange={(checked) =>
                updateClientSettings({ openVSCodeRemoteTunnelsInDesktop: Boolean(checked) })
              }
              aria-label="Open VS Code tunnels in desktop"
            />
          }
        />
      </SettingsSection>

      {localEditorsVisible ? (
        <SettingsSection title="Local editors" icon={<LaptopIcon className="size-3.5" />}>
          <SettingsRow
            title="Detected on this machine"
            description="Local editors are shown only in the desktop app or a loopback browser session."
            status={
              localEditorLabels.length > 0
                ? localEditorLabels.map((editor) => editor.label).join(", ")
                : "No supported local editor commands were found."
            }
          />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
