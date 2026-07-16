import {
  EDITORS,
  type DesktopSshEnvironmentTarget,
  type EditorId,
  type EnvironmentId,
  type ExecutionEnvironmentPlatform,
  type ResolvedKeybindingsConfig,
  type ServerVSCodeTunnel,
} from "@t3tools/contracts";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo } from "react";

import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import {
  buildJetBrainsSshUrl,
  buildVSCodeSshUrl,
  buildVSCodeTunnelUrl,
  buildZedSshUrl,
  type EditorLaunchOption,
  orderEditorLaunchOptions,
  resolveEditorLaunchOptions,
} from "../../editorLaunch";
import { usePreferredEditor } from "../../editorPreferences";
import { useClientSettings } from "../../hooks/useSettings";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AntigravityIcon,
  CursorIcon,
  type Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";

type PickerOption = {
  readonly label: string;
  readonly Icon: Icon;
} & EditorLaunchOption;

const LOCAL_EDITOR_ICONS: Readonly<Partial<Record<EditorId, Icon>>> = {
  cursor: CursorIcon,
  trae: TraeIcon,
  kiro: KiroIcon,
  vscode: VisualStudioCode,
  "vscode-insiders": VisualStudioCodeInsiders,
  vscodium: VSCodium,
  zed: Zed,
  antigravity: AntigravityIcon,
  idea: IntelliJIdeaIcon,
  aqua: AquaIcon,
  clion: CLionIcon,
  datagrip: DataGripIcon,
  dataspell: DataSpellIcon,
  goland: GoLandIcon,
  phpstorm: PhpStormIcon,
  pycharm: PyCharmIcon,
  rider: RiderIcon,
  rubymine: RubyMineIcon,
  rustrover: RustRoverIcon,
  webstorm: WebStormIcon,
  "file-manager": FolderClosedIcon,
};

function presentEditorOption(option: EditorLaunchOption, platform: string): PickerOption {
  if (option.kind === "local") {
    const definition = EDITORS.find((editor) => editor.id === option.editor);
    const label =
      option.editor === "file-manager"
        ? isMacPlatform(platform)
          ? "Finder"
          : isWindowsPlatform(platform)
            ? "Explorer"
            : "Files"
        : (definition?.label ?? option.editor);
    return {
      ...option,
      label,
      Icon: LOCAL_EDITOR_ICONS[option.editor] ?? FolderClosedIcon,
    };
  }
  if (option.kind === "tunnel") {
    return {
      ...option,
      label: `VS Code Tunnel (${option.tunnel.machineName})`,
      Icon: VisualStudioCode,
    };
  }
  return {
    ...option,
    label:
      option.id === "vscode-ssh"
        ? `VS Code via SSH (${option.target.alias})`
        : option.id === "jetbrains-ssh"
          ? `JetBrains Gateway via SSH (${option.target.alias})`
          : `Zed via SSH (${option.target.alias})`,
    Icon:
      option.id === "vscode-ssh"
        ? VisualStudioCode
        : option.id === "jetbrains-ssh"
          ? IntelliJIdeaIcon
          : Zed,
  };
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  sshTarget = null,
  remotePlatform = null,
  vscodeTunnel = null,
  openInCwd,
  compact = false,
  enableShortcut = true,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  sshTarget?: DesktopSshEnvironmentTarget | null;
  remotePlatform?: ExecutionEnvironmentPlatform | null;
  vscodeTunnel?: ServerVSCodeTunnel | null;
  openInCwd: string | null;
  compact?: boolean;
  enableShortcut?: boolean;
}) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const [legacyPreferredEditor] = usePreferredEditor(availableEditors);
  const primaryEditor = useClientSettings((settings) => settings.primaryEditor);
  const remoteEditors = useClientSettings((settings) => settings.remoteEditors);
  const openTunnelInDesktop = useClientSettings(
    (settings) => settings.openVSCodeRemoteTunnelsInDesktop,
  );

  const options = useMemo(() => {
    const preferredId = primaryEditor ?? legacyPreferredEditor;
    return orderEditorLaunchOptions(
      resolveEditorLaunchOptions({
        availableLocalEditors: availableEditors,
        sshTarget,
        vscodeTunnel,
        remoteEditors,
        remotePlatform,
      }),
      preferredId,
    ).map((option) => presentEditorOption(option, navigator.platform));
  }, [
    availableEditors,
    legacyPreferredEditor,
    primaryEditor,
    remoteEditors,
    remotePlatform,
    sshTarget,
    vscodeTunnel,
  ]);
  const primaryOption = options[0] ?? null;

  const openOption = useCallback(
    (option: PickerOption | null) => {
      if (!openInCwd || !option) return;
      if (option.kind === "local") {
        return openInEditor({
          environmentId,
          input: { cwd: openInCwd, editor: option.editor },
        });
      }

      const url =
        option.kind === "tunnel"
          ? buildVSCodeTunnelUrl(option.tunnel, openInCwd, openTunnelInDesktop)
          : option.id === "vscode-ssh"
            ? buildVSCodeSshUrl(option.target, openInCwd)
            : option.id === "jetbrains-ssh"
              ? buildJetBrainsSshUrl(option.target, openInCwd)
              : buildZedSshUrl(option.target, openInCwd);
      const localApi = readLocalApi();
      if (!localApi) return;
      void localApi.shell.openExternal(url).catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open editor",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [environmentId, openInCwd, openInEditor, openTunnelInDesktop],
  );

  const shortcut = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    if (!enableShortcut) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings) || !openInCwd || !primaryOption) return;
      event.preventDefault();
      void openOption(primaryOption);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableShortcut, keybindings, openInCwd, openOption, primaryOption]);

  return (
    <Group aria-label="Open in editor">
      <Button
        aria-label={compact ? "Open file in primary editor" : undefined}
        size="xs"
        variant="outline"
        disabled={!primaryOption || !openInCwd}
        onClick={() => openOption(primaryOption)}
      >
        {primaryOption ? <primaryOption.Icon aria-hidden="true" className="size-3.5" /> : null}
        <span
          className={
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
          }
        >
          Open
        </span>
      </Button>
      <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={compact ? "Choose editor" : "Open in options"}
              size="icon-xs"
              variant="outline"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 ? <MenuItem disabled>No editors available</MenuItem> : null}
          {options.map((option, index) => (
            <MenuItem key={option.id} onClick={() => openOption(option)}>
              <option.Icon aria-hidden="true" className="text-muted-foreground" />
              {option.label}
              {index === 0 && shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
