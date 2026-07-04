import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { ChatHistorySidebar } from "@/components/chat/ChatHistorySidebar";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@/components/chat/MentionComposer";
import { SharedHistoryManagerModal } from "@/components/chat/SharedHistoryManagerModal";
import { ChevronDown, PanelRightClose, PanelRightOpen, Terminal } from "@/components/icons";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "@/components/project-tools/git-review";
import { RightDockPanel } from "@/components/project-tools/RightDockPanel";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocaleContext, t as translate } from "@/i18n";
import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import { buildModelOptions, sortHistoryItems } from "@/lib/chat/chatPageHelpers";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import {
  filterConversationSummariesForScope,
  historyConversationMatchesFilter,
} from "@/lib/chat/historyListScope";
import { createActivityStore } from "@/lib/chat/stream/activityStore";
import {
  type ChatCommandOutcome,
  ChatCommandPipeline,
  type PendingChatCommand,
} from "@/lib/chat/stream/chatCommandPipeline";
import {
  type ChatCommandUpdate,
  type ConversationActivityEvent,
  type ConversationStreamEvent,
  type ConversationSubscribeResult,
  readEventRunId,
} from "@/lib/chat/stream/streamTypes";
import {
  createTranscriptStoreRegistry,
  useConversationChat,
} from "@/lib/chat/stream/useConversationChat";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@/lib/chat/uploadedFiles";
import {
  buildOptimisticConversationTitle,
  type ChatEntry,
  resolveConversationBrowserTitle,
} from "@/lib/chatUi";
import type { GatewayChatCommandInput } from "@/lib/gatewaySocket";
import type {
  AgentStatus,
  ChatEvent,
  ChatQueueItemSummary,
  ChatQueueSnapshot,
  ConversationSummary,
  GatewayHistoryEvent,
  HistoryDetail,
  HistoryShareStatus,
  HistoryWorkdirSummary,
} from "@/lib/gatewayTypes";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import { memoryDeleteProject } from "@/lib/memory/api";
import { toModelValue } from "@/lib/providers/llm";
import {
  type ChatRuntimeControls,
  DEFAULT_WORKSPACE_PROJECT_ID,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getNextTheme,
  getRightDockFileTreeState,
  getRightDockProjectState,
  getSshProjectHostIds,
  isAgentDevMode,
  isRightDockSingletonTabOpen,
  normalizeChatRuntimeControlsForProvider,
  openRightDockSingletonTab,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  removeRightDockProjectState,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  updateChatRuntimeControlsForProvider,
  updateCustomSettings,
  updateRightDockFileTreeState,
  updateRightDockProjectState,
  updateRightDockWidth,
  updateSshProjectHostIds,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { mergeAlwaysEnabledSkillNames } from "@/lib/skills";
import { terminalSessionBelongsToProject } from "@/lib/terminal/sessionStore";
import type { TerminalSession } from "@/lib/terminal/types";
import { createGatewayWorkspaceActivityClient } from "@/lib/workspace-activity/gatewayWorkspaceActivityClient";
import { ChatComposerBar, type ChatQueueTurnPreview } from "@/pages/chat/ChatComposerBar";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { queuedChatTurnHasContent } from "@/pages/chat/queue/chatTurnQueue";
import { useChatSkills } from "@/pages/chat/useChatSkills";
import { McpHubPage } from "@/pages/mcp-hub/McpHubPage";
import { SettingsPage } from "@/pages/SettingsPage";
import type { SectionId } from "@/pages/settings/types";
import { SkillsHubPage } from "@/pages/skills-hub/SkillsHubPage";

const LOCAL_DRAFT_PREFIX = "__local_draft__:";
function createLocalDraftConversationId() {
  return `${LOCAL_DRAFT_PREFIX}${crypto.randomUUID()}`;
}
function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith(LOCAL_DRAFT_PREFIX);
}

import { HistoryShareModal } from "@/components/chat/HistoryShareModal";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { useGatewayScrollAffordance } from "@/components/useGatewayScrollAffordance";
import { parseHistoryShareToken } from "@/lib/historyShare";
import {
  applyGatewayHistoryEvent,
  reconcileConversationSummaries,
  upsertConversationSummary,
} from "@/lib/historySync";
import {
  applyWorkspaceProjectConversationActivityMap,
  buildWorkspaceProjectActivityUpdatedAts,
  findWorkspaceProject,
  mergeWorkspaceProjectActivityUpdatedAts,
  mergeWorkspaceProjectsWithHistory,
  workspaceProjectActivityUpdatedAtsEqual,
} from "@/lib/workspaceProjects";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsSyncLoading } from "@/pages/SettingsSyncLoading";
import { SharedHistoryPage } from "@/pages/SharedHistoryPage";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import { buildTextFromComposerDraft, importPastedTextsAsFiles } from "./chatDraft";
import {
  asErrorMessage,
  buildGatewaySelectedModel,
  buildGatewaySystemSettings,
  isAbortError,
  isChatEventTitleFinal,
  readChatEventTitle,
  readTunnelManagerToolChange,
  waitForMinimumHistoryListLoading,
} from "./chatEventUtils";
import {
  CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS,
  CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_PREPARING_STATUS,
  DEFAULT_BROWSER_TITLE,
  HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
  HISTORY_LIST_PAGE_SIZE,
  HISTORY_SWITCH_OVERLAY_MIN_MS,
  HISTORY_TITLE_POSITION_LOCK_MS,
  MAX_UPLOAD_FILES,
  MCP_HUB_BROWSER_TITLE,
  NEW_CONVERSATION_BROWSER_TITLE,
  PROJECT_HISTORY_DELETE_PAGE_SIZE,
  PROTECTED_DRAFT_CONVERSATION,
  SHARED_HISTORY_BROWSER_TITLE,
  SHARED_HISTORY_LIST_PAGE_SIZE,
  SKILLS_HUB_BROWSER_TITLE,
} from "./constants";
import { FileDropOverlay } from "./FileDropOverlay";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import {
  createWorkspaceProjectFromPath,
  formatTranslation,
  getDefaultWorkspaceProjectPath,
  hasLocalDraftConversation,
  isMobileSidebarLayout,
  pickConversationSummary,
  resolveConversationTitle,
  resolveVisibleConversationId,
  shouldOpenSidebarByDefault,
  toChatHistorySummary,
} from "./historyUtils";
import { useGatewayClients } from "./hooks/useGatewayClients";
import { useGatewaySession } from "./hooks/useGatewaySession";
import { useGatewaySettingsSync } from "./hooks/useGatewaySettingsSync";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { useProjectToolsRuntime } from "./hooks/useProjectToolsRuntime";
import type {
  ModelProviderSource,
  OverlayState,
  ReloadHistoryOptions,
  SendChatFn,
  SendChatOptions,
} from "./types";
import { UserMenu } from "./UserMenu";
import { WorkspaceOverlayHost } from "./WorkspaceOverlayHost";

// history.list `running_conversations` items → activity store hydration shape.
function normalizeActivityHydrationItems(items: readonly unknown[] | undefined) {
  const normalized: Array<{
    conversationId: string;
    runId: string;
    state?: string;
    workdir?: string | null;
    updatedAt?: number;
  }> = [];
  for (const value of items ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const source = value as Record<string, unknown>;
    const conversationId =
      typeof source.conversation_id === "string" ? source.conversation_id.trim() : "";
    const runId = typeof source.run_id === "string" ? source.run_id.trim() : "";
    if (!conversationId || !runId) {
      continue;
    }
    normalized.push({
      conversationId,
      runId,
      state: typeof source.state === "string" ? source.state : undefined,
      workdir: typeof source.cwd === "string" ? source.cwd : null,
      updatedAt:
        typeof source.updated_at === "number" && Number.isFinite(source.updated_at)
          ? source.updated_at
          : undefined,
    });
  }
  return normalized;
}

export default function GatewayApp() {
  const historyShareToken = useMemo(() => parseHistoryShareToken(), []);
  const {
    token,
    loginToken,
    authSubmitting,
    authError,
    setLoginToken,
    setAuthError,
    login: handleLoginSubmit,
    clearSession,
  } = useGatewaySession(historyShareToken);
  const { api, terminalClient, sftpClient, gitClient } = useGatewayClients(token);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [historyListLoading, setHistoryListLoading] = useState(false);
  const [historyListLoadingMore, setHistoryListLoadingMore] = useState(false);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyMutating, setHistoryMutating] = useState(false);
  const [historyItems, setHistoryItems] = useState<ConversationSummary[]>([]);
  const [historyWorkdirs, setHistoryWorkdirs] = useState<HistoryWorkdirSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [queuedChatTurns, setQueuedChatTurns] = useState<ChatQueueItemSummary[]>([]);
  const [, setChatQueueRevision] = useState(0);
  const [projectActivityUpdatedAtOverrides, setProjectActivityUpdatedAtOverrides] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(null);
  // Bumped whenever the command pipeline's pending set changes so busy state
  // re-derives.
  const [pendingCommandRevision, setPendingCommandRevision] = useState(0);
  // Bumped inside flushSync to synchronously commit a settled-tail fold.
  const [, setFoldFlushTick] = useState(0);
  const [historySwitchOverlay, setHistorySwitchOverlay] = useState<{
    conversationId: string;
    startedAt: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [overlay, setOverlay] = useState<OverlayState>("closed");
  const { settings, setSettings, settingsSyncReady, settingsSyncError, settingsSaveState } =
    useGatewaySettingsSync({ token, api });
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const isAgentMode = settings.system.executionMode !== "text";
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, historyWorkdirs),
    [historyWorkdirs, settings.system],
  );
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const activeWorkspaceProject = useMemo(
    () => findWorkspaceProject(workspaceProjects, activeWorkspaceProjectId),
    [activeWorkspaceProjectId, workspaceProjects],
  );
  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId]);
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";
  const historyListFilter = useMemo(
    () =>
      isAgentMode
        ? { cwd: activeWorkspaceProjectPath || "__liveagent_no_project__" }
        : { cwdEmpty: true },
    [activeWorkspaceProjectPath, isAgentMode],
  );
  const historyScopeKey = isAgentMode
    ? `cwd:${activeWorkspaceProjectPath || "__liveagent_no_project__"}`
    : "cwd-empty";
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [shareConversation, setShareConversation] = useState<ChatHistorySummary | null>(null);
  const [shareStatus, setShareStatus] = useState<HistoryShareStatus | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedManagerOpen, setSharedManagerOpen] = useState(false);
  const [sharedManagerStatuses, setSharedManagerStatuses] = useState<
    Record<string, HistoryShareStatus | undefined>
  >({});
  const [sharedManagerLoadingIds, setSharedManagerLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerUpdatingIds, setSharedManagerUpdatingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerErrors, setSharedManagerErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  const {
    scrollAreaRef: transcriptScrollAreaRef,
    showJumpToBottom: showTranscriptJumpToBottom,
    jumpToBottom: jumpTranscriptToBottom,
    stickToBottom: stickTranscriptToBottom,
    isAtBottom: isTranscriptAtBottom,
    syncAutoScroll: syncTranscriptAutoScroll,
    refreshScrollState: refreshTranscriptScrollState,
    preserveScrollPosition: preserveTranscriptScrollPosition,
  } = useGatewayScrollAffordance();
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  const conversationIdRef = useRef(conversationId);
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  const statusRef = useRef<AgentStatus | null>(status);
  const queuedChatTurnsRef = useRef<ChatQueueItemSummary[]>([]);
  const chatQueueConversationIdRef = useRef("");
  const chatQueueRevisionRef = useRef(0);
  const queuedChatEditSessionRef = useRef<{ itemId: string; revision: number } | null>(null);
  const selectedHistoryRef = useRef(selectedHistory);
  const historyItemsRef = useRef(historyItems);
  const historyTotalRef = useRef(historyTotal);
  const historyHasMoreRef = useRef(historyHasMore);
  const historyListFilterRef = useRef(historyListFilter);
  const historyScopeKeyRef = useRef(historyScopeKey);
  const nextHistoryPageRef = useRef(1);
  const historyListPageLoadingRef = useRef(false);
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<Promise<ChatHistorySummary[]> | null>(null);
  // Per-conversation runtime workdir (drafts have no persisted summary yet).
  const conversationWorkdirsRef = useRef<Map<string, string>>(new Map());
  const displayedConversationWorkdirRef = useRef("");
  const displayedConversationBusyRef = useRef(false);
  const optimisticTitleConversationIdsRef = useRef<Set<string>>(new Set());
  const titlePositionLockedConversationIdsRef = useRef<Set<string>>(new Set());
  const titlePositionLockTimeoutsRef = useRef<Map<string, number>>(new Map());
  const historyLoadSequenceRef = useRef(0);
  const visibleConversationRevisionRef = useRef(0);
  const previousDisplayedConversationIdRef = useRef("");
  const pendingDisplayedConversationAutoBottomRef = useRef<string | null>(null);
  const draftConversationPinnedRef = useRef(false);
  const protectedConversationRef = useRef("");
  const chatRuntimePreparePromiseRef = useRef<Promise<AgentStatus> | null>(null);
  const submitInFlightRef = useRef(false);
  // clientRequestId → draft conversation id, until the command binds.
  const draftClientRequestsRef = useRef<Map<string, string>>(new Map());
  const sendChatRef = useRef<SendChatFn | null>(null);
  const isImportingPastedTextRef = useRef(false);
  const resetProjectToolsRuntimeRef = useRef(() => undefined as void);
  const persistProjectConversationActivityRef = useRef(
    (_activity: ReadonlyMap<string, number>) => undefined as void,
  );

  // --- Chat streaming infrastructure (Phase 4) -----------------------------
  // Transcript stores (one per conversation), the global activity map, and
  // the command pipeline replace the old live-store registry, running-id
  // unions, and recovery machinery.
  // Ref indirection: the registry memo is stable across token changes while
  // the api client is not, and divergence resyncs must reach the live client.
  const apiRef = useRef(api);
  apiRef.current = api;
  const transcriptStoreRegistry = useMemo(
    () =>
      createTranscriptStoreRegistry({
        onDivergence: (divergedConversationId) =>
          apiRef.current?.resyncConversation(divergedConversationId),
      }),
    [],
  );
  const activityStore = useMemo(() => createActivityStore(), []);
  const pipelineOnBoundRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnQueuedInGuiRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnFailedRef = useRef<
    (pending: PendingChatCommand, errorCode: string | null, message: string) => void
  >(() => undefined);
  const chatCommandPipeline = useMemo(
    () =>
      new ChatCommandPipeline({
        getTranscriptStore: (targetConversationId) =>
          transcriptStoreRegistry.get(targetConversationId),
        onBound: (update, pending) => pipelineOnBoundRef.current(update, pending),
        onQueuedInGui: (update, pending) => pipelineOnQueuedInGuiRef.current(update, pending),
        onFailed: (pending, errorCode, message) =>
          pipelineOnFailedRef.current(pending, errorCode, message),
        onPendingChanged: () => setPendingCommandRevision((current) => current + 1),
      }),
    [transcriptStoreRegistry],
  );
  const {
    pendingUploadedFiles,
    pendingUploadedFilesRef,
    pendingUploadsByConversationRef,
    isUploadingFiles,
    isUploadingFilesRef,
    isFileDropActive,
    fileInputRef,
    setIsUploadingFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    clearPendingUploads,
    handleImportReadableFiles,
    handleFileDragEnter,
    handleFileDragOver: handlePendingFileDragOver,
    handleFileDragLeave,
    handleFileDrop: handlePendingFileDrop,
  } = usePendingUploads({
    token,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale: settings.locale,
    executionMode: settings.system.executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    setChatError,
  });

  const applyChatQueueSnapshot = useCallback((snapshot: ChatQueueSnapshot | null | undefined) => {
    if (!snapshot) return;
    const visibleConversationId = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    if (snapshot.conversationId !== visibleConversationId) {
      return;
    }
    const revision = Number(snapshot.revision ?? 0);
    const isSameQueueConversation = snapshot.conversationId === chatQueueConversationIdRef.current;
    if (isSameQueueConversation && revision < chatQueueRevisionRef.current) {
      return;
    }
    chatQueueConversationIdRef.current = snapshot.conversationId;
    chatQueueRevisionRef.current = revision;
    queuedChatTurnsRef.current = snapshot.items.slice();
    setChatQueueRevision(revision);
    setQueuedChatTurns(snapshot.items.slice());
  }, []);

  const recordProjectActivity = useCallback(
    (workdir?: string | null, updatedAt?: number | null) => {
      const pathKey = workspaceProjectPathKey(workdir ?? "");
      if (!pathKey) {
        return;
      }
      const nextUpdatedAt =
        typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
          ? updatedAt
          : Date.now();
      setProjectActivityUpdatedAtOverrides((current) => {
        if ((current.get(pathKey) ?? 0) >= nextUpdatedAt) {
          return current;
        }
        return mergeWorkspaceProjectActivityUpdatedAts(
          current,
          new Map([[pathKey, nextUpdatedAt]]),
        );
      });
      persistProjectConversationActivityRef.current(new Map([[pathKey, nextUpdatedAt]]));
    },
    [],
  );

  useEffect(() => {
    if (!api) return;
    return api.subscribeChatQueue((snapshot) => {
      applyChatQueueSnapshot(snapshot);
    });
  }, [api, applyChatQueueSnapshot]);

  useEffect(() => {
    const historyActivity = buildWorkspaceProjectActivityUpdatedAts(historyWorkdirs);
    if (historyActivity.size === 0) {
      return;
    }
    setProjectActivityUpdatedAtOverrides((current) => {
      const next = mergeWorkspaceProjectActivityUpdatedAts(current, historyActivity);
      return workspaceProjectActivityUpdatedAtsEqual(current, next) ? current : next;
    });
    persistProjectConversationActivityRef.current(historyActivity);
  }, [historyWorkdirs]);

  function getVisibleComposerConversationId() {
    return resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current);
  }

  function cacheVisibleComposerDraft(conversationId = getVisibleComposerConversationId()) {
    const targetConversationId = conversationId.trim();
    const composer = composerRef.current;
    if (!targetConversationId || !composer) {
      return;
    }

    const draft = composer.getDraft();
    if (draft.isEmpty || !draft.text.trim()) {
      composerDraftCacheRef.current.delete(targetConversationId);
      return;
    }

    composerDraftCacheRef.current.set(targetConversationId, draft);
  }

  function clearCachedComposerDraft(conversationId = getVisibleComposerConversationId()) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    composerDraftCacheRef.current.delete(targetConversationId);
  }

  const commitHistoryListState = useCallback(
    (conversations: ConversationSummary[], total: number, nextPage: number, hasMore?: boolean) => {
      const scopedConversations = filterConversationSummariesForScope(
        conversations,
        historyListFilterRef.current,
      );
      const nextTotal = Math.max(0, total);
      const nextHasMore = hasMore ?? scopedConversations.length < nextTotal;

      historyItemsRef.current = scopedConversations;
      historyTotalRef.current = nextTotal;
      historyHasMoreRef.current = nextHasMore;
      nextHistoryPageRef.current = Math.max(1, nextPage);
      setHistoryItems(scopedConversations);
      setHistoryTotal(nextTotal);
      setHistoryHasMore(nextHasMore);
    },
    [],
  );

  const updateHistoryItems = useCallback(
    (updater: (current: ConversationSummary[]) => ConversationSummary[]) => {
      const current = historyItemsRef.current;
      const next = filterConversationSummariesForScope(
        updater(current),
        historyListFilterRef.current,
      );
      const delta = next.length - current.length;
      commitHistoryListState(
        next,
        Math.max(next.length, historyTotalRef.current + delta),
        nextHistoryPageRef.current,
      );
    },
    [commitHistoryListState],
  );

  const unlockHistoryTitlePosition = useCallback((conversationIdValue: string) => {
    const conversationId = conversationIdValue.trim();
    if (!conversationId) {
      return;
    }
    const timeoutId = titlePositionLockTimeoutsRef.current.get(conversationId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      titlePositionLockTimeoutsRef.current.delete(conversationId);
    }
    titlePositionLockedConversationIdsRef.current.delete(conversationId);
  }, []);

  const lockHistoryTitlePosition = useCallback((conversationIdValue: string) => {
    const conversationId = conversationIdValue.trim();
    if (!conversationId) {
      return;
    }

    const existingTimeoutId = titlePositionLockTimeoutsRef.current.get(conversationId);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    titlePositionLockedConversationIdsRef.current.add(conversationId);
    const timeoutId = window.setTimeout(() => {
      titlePositionLockTimeoutsRef.current.delete(conversationId);
      titlePositionLockedConversationIdsRef.current.delete(conversationId);
    }, HISTORY_TITLE_POSITION_LOCK_MS);
    titlePositionLockTimeoutsRef.current.set(conversationId, timeoutId);
  }, []);

  const getHistoryPositionLockedConversationIds = useCallback(() => {
    const conversationIds = new Set([
      ...optimisticTitleConversationIdsRef.current,
      ...titlePositionLockedConversationIdsRef.current,
    ]);
    return conversationIds;
  }, []);

  const clearHistoryTitlePositionLocks = useCallback(() => {
    for (const timeoutId of titlePositionLockTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    titlePositionLockTimeoutsRef.current.clear();
    titlePositionLockedConversationIdsRef.current.clear();
  }, []);

  useEffect(() => clearHistoryTitlePositionLocks, [clearHistoryTitlePositionLocks]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId;
  }, [selectedHistoryId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    selectedHistoryRef.current = selectedHistory;
  }, [selectedHistory]);

  useEffect(() => {
    historyItemsRef.current = historyItems;
  }, [historyItems]);

  useEffect(() => {
    historyTotalRef.current = historyTotal;
  }, [historyTotal]);

  useEffect(() => {
    historyHasMoreRef.current = historyHasMore;
  }, [historyHasMore]);

  useEffect(() => {
    historyListFilterRef.current = historyListFilter;
    if (historyScopeKeyRef.current === historyScopeKey) {
      return;
    }
    historyScopeKeyRef.current = historyScopeKey;
    historyListPageLoadingRef.current = false;
    commitHistoryListState([], 0, 1, false);
    setHistoryError(null);
    setHistoryListLoading(true);
  }, [commitHistoryListState, historyListFilter, historyScopeKey]);

  function getDisplayedConversationId() {
    return resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
  }

  function isDisplayedConversation(targetConversationId: string) {
    const conversationIdValue = targetConversationId.trim();
    return conversationIdValue !== "" && getDisplayedConversationId() === conversationIdValue;
  }

  const applyLiveConversationTitle = useCallback(
    (
      targetConversationId: string,
      nextTitle: string,
      options?: {
        isFinal?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      const title = nextTitle.trim();
      if (!conversationIdValue || !title) {
        return;
      }

      const updatedAt = Date.now();
      lockHistoryTitlePosition(conversationIdValue);
      if (options?.isFinal) {
        optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
      }
      updateHistoryItems((current) => {
        const existing = pickConversationSummary(current, conversationIdValue);
        return upsertConversationSummary(
          current,
          {
            id: conversationIdValue,
            title,
            created_at: existing?.created_at ?? updatedAt,
            updated_at: existing?.updated_at ?? updatedAt,
            message_count: existing?.message_count ?? 1,
          },
          { preserveExistingUpdatedAt: existing !== null },
        );
      });
    },
    [lockHistoryTitlePosition, updateHistoryItems],
  );

  // Total entry count of a conversation's transcript store.
  const getConversationTranscriptEntryCount = useCallback(
    (targetConversationId: string) => {
      const store = transcriptStoreRegistry.peek(targetConversationId.trim());
      return store ? store.getSnapshot().entryCount : 0;
    },
    [transcriptStoreRegistry],
  );

  const isConversationBusy = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }
      return (
        activityStore.isRunning(conversationIdValue) ||
        chatCommandPipeline.hasPending(conversationIdValue) ||
        transcriptStoreRegistry.peek(conversationIdValue)?.getSnapshot().activeRun != null
      );
    },
    [activityStore, chatCommandPipeline, transcriptStoreRegistry],
  );

  // Keep an empty draft conversation's workdir following the active project.
  useEffect(() => {
    const nextWorkdir = activeWorkspaceProjectPath.trim();
    if (!isAgentMode || !nextWorkdir) {
      return;
    }
    const conversationIdValue = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
    if (!conversationIdValue || !isLocalDraftConversationId(conversationIdValue)) {
      return;
    }
    if (isConversationBusy(conversationIdValue)) {
      return;
    }
    if (
      getConversationTranscriptEntryCount(conversationIdValue) > 0 ||
      pendingUploadedFilesRef.current.length > 0
    ) {
      return;
    }
    conversationWorkdirsRef.current.set(conversationIdValue, nextWorkdir);
  }, [
    activeWorkspaceProjectPath,
    getConversationTranscriptEntryCount,
    isAgentMode,
    isConversationBusy,
    pendingUploadedFilesRef,
  ]);

  // Quiet history refresh for the displayed conversation: fetch → parse →
  // id-preserving merge into the transcript store (no flicker, no remount).
  // Only runs while the conversation is idle; a run started mid-fetch aborts
  // the merge so a stale snapshot can never truncate freshly folded entries.
  const refreshDisplayedConversationHistorySnapshot = useCallback(
    async (targetConversationId: string, currentApi = api, options?: { forceFull?: boolean }) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue || isLocalDraftConversationId(conversationIdValue)) {
        return;
      }

      const isStillDisplayedAndIdle = () =>
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
          conversationIdValue && !isConversationBusy(conversationIdValue);
      if (!isStillDisplayedAndIdle()) {
        return;
      }

      // If the full history is already loaded, refresh the full transcript so
      // the merge cannot truncate it back to the most recent page.
      const hasFullHistoryLoaded =
        options?.forceFull === true ||
        (selectedHistoryRef.current?.conversation_id === conversationIdValue &&
          selectedHistoryRef.current.has_more === false);

      let detail: HistoryDetail;
      let entries: ChatEntry[];
      try {
        detail = await currentApi.getHistory(
          conversationIdValue,
          hasFullHistoryLoaded ? undefined : { maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES },
        );
        entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (
          detail.has_more === true &&
          entries.length < getConversationTranscriptEntryCount(conversationIdValue)
        ) {
          // Partial window smaller than what is currently rendered: merging
          // it would truncate the top of a longer transcript. Refetch full.
          detail = await currentApi.getHistory(conversationIdValue);
          entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
        }
      } catch {
        return;
      }
      if (!isStillDisplayedAndIdle()) {
        return;
      }
      const detailConversationId = detail.conversation_id.trim();
      if (detailConversationId !== "" && detailConversationId !== conversationIdValue) {
        return;
      }

      if (selectedHistoryIdRef.current.trim() === conversationIdValue) {
        selectedHistoryRef.current = detail;
        setSelectedHistory(detail);
      }
      transcriptStoreRegistry
        .get(conversationIdValue)
        .applyHistorySnapshot(entries, { mode: "enrich" });
    },
    [api, getConversationTranscriptEntryCount, isConversationBusy, transcriptStoreRegistry],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

  // A draft conversation got its real id (authoritative `command_update
  // bound`): re-key every draft-scoped resource onto the real conversation.
  const bindDraftConversation = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      transcriptStoreRegistry.move(previousId, nextId);

      const workdir = conversationWorkdirsRef.current.get(previousId);
      if (workdir !== undefined) {
        conversationWorkdirsRef.current.delete(previousId);
        conversationWorkdirsRef.current.set(nextId, workdir);
      }

      const cachedComposerDraft = composerDraftCacheRef.current.get(previousId);
      if (cachedComposerDraft) {
        composerDraftCacheRef.current.delete(previousId);
        composerDraftCacheRef.current.set(nextId, cachedComposerDraft);
      }
      const pendingUploads = pendingUploadsByConversationRef.current.get(previousId);
      if (pendingUploads !== undefined) {
        pendingUploadsByConversationRef.current.delete(previousId);
        pendingUploadsByConversationRef.current.set(nextId, pendingUploads);
      }
      if (chatQueueConversationIdRef.current === previousId) {
        chatQueueConversationIdRef.current = nextId;
      }

      if (conversationIdRef.current === previousId) {
        conversationIdRef.current = nextId;
        setConversationId(nextId);
      }
      if (selectedHistoryIdRef.current === previousId) {
        selectedHistoryIdRef.current = nextId;
        setSelectedHistoryId(nextId);
      }
      if (protectedConversationRef.current.trim() === previousId) {
        protectedConversationRef.current = nextId;
      }

      const shouldPreserveOptimisticTitle =
        optimisticTitleConversationIdsRef.current.delete(previousId);
      if (shouldPreserveOptimisticTitle) {
        optimisticTitleConversationIdsRef.current.add(nextId);
      }
      if (titlePositionLockedConversationIdsRef.current.has(previousId)) {
        unlockHistoryTitlePosition(previousId);
        lockHistoryTitlePosition(nextId);
      }

      updateHistoryItems((current) => {
        const previousSummary = pickConversationSummary(current, previousId);
        if (!previousSummary) {
          return current;
        }

        const nextSummary = pickConversationSummary(current, nextId);
        const mergedSummary = {
          ...previousSummary,
          ...(nextSummary ?? {}),
          id: nextId,
          title: shouldPreserveOptimisticTitle
            ? previousSummary.title
            : nextSummary?.title?.trim() || previousSummary.title,
          provider_id: nextSummary?.provider_id || previousSummary.provider_id,
          model: nextSummary?.model || previousSummary.model,
          session_id: nextSummary?.session_id || previousSummary.session_id,
          cwd: nextSummary?.cwd || previousSummary.cwd,
          is_pinned: nextSummary?.is_pinned ?? previousSummary.is_pinned,
          pinned_at:
            "pinned_at" in (nextSummary ?? {}) ? nextSummary?.pinned_at : previousSummary.pinned_at,
          is_shared: nextSummary?.is_shared ?? previousSummary.is_shared,
        };
        const withoutMigratedRows = current.filter(
          (item) => item.id !== previousId && item.id !== nextId,
        );
        return upsertConversationSummary(withoutMigratedRows, mergedSummary, {
          preserveExistingTitle: shouldPreserveOptimisticTitle,
        });
      });
    },
    [
      lockHistoryTitlePosition,
      pendingUploadsByConversationRef,
      transcriptStoreRegistry,
      unlockHistoryTitlePosition,
      updateHistoryItems,
    ],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "tunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  // Tunnel list refreshes arrive through the tunnel.state push; the chat
  // event only opens the tunnel tool tab when the agent creates a tunnel.
  const handleTunnelManagerChatEvent = useCallback(
    (event: ChatEvent) => {
      const change = readTunnelManagerToolChange(event);
      if (!change) return;
      if (change.action === "create") {
        ensureTunnelToolTab(change.projectPathKey);
      }
    },
    [ensureTunnelToolTab],
  );

  const persistProjectConversationActivity = useCallback(
    (activity: ReadonlyMap<string, number>) => {
      if (activity.size === 0) {
        return;
      }
      setSettings((prev) => {
        const hiddenProjectPathKeys = new Set(
          prev.system.hiddenWorkspaceProjectPaths.map(workspaceProjectPathKey),
        );
        const workspaceProjects = applyWorkspaceProjectConversationActivityMap(
          prev.system.workspaceProjects,
          activity,
          { hiddenProjectPathKeys },
        );
        if (!workspaceProjects) {
          return prev;
        }
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );
  persistProjectConversationActivityRef.current = persistProjectConversationActivity;

  const refreshHistoryWorkdirs = useCallback(
    async (currentApi = api) => {
      if (!currentApi) {
        setHistoryWorkdirs([]);
        return;
      }
      try {
        const response = await currentApi.listHistoryWorkdirs();
        setHistoryWorkdirs(response.workdirs);
      } catch (error) {
        console.warn("Failed to load chat history workdirs", error);
      }
    },
    [api],
  );

  useEffect(() => {
    void refreshHistoryWorkdirs(api);
  }, [api, refreshHistoryWorkdirs]);

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) {
          return prev;
        }
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              missingWorkspaceProjectPaths,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject, currentApi = api) => {
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      if (!currentApi) {
        return !missingWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path));
      }
      try {
        await currentApi.listDirs(path, 1);
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [api, missingWorkspaceProjectPathKeys, setWorkspaceProjectDirectoryMissing],
  );

  const activateWorkspaceProject = useCallback(
    (project: WorkspaceProject, options?: { startConversation?: boolean }) => {
      const pathKey = project.path.trim();
      if (!pathKey) return;
      const normalizedPathKey = workspaceProjectPathKey(pathKey);
      const targetProject =
        workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        ) ?? project;
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ?? targetProject;
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    name: item.id === DEFAULT_WORKSPACE_PROJECT_ID ? item.name : nextProject.name,
                    path: nextProject.path,
                    kind:
                      item.id === DEFAULT_WORKSPACE_PROJECT_ID
                        ? "managed"
                        : nextProject.kind === "history"
                          ? item.kind
                          : nextProject.kind,
                    updatedAt: item.updatedAt,
                    lastConversationAt:
                      Math.max(item.lastConversationAt ?? 0, nextProject.lastConversationAt ?? 0) ||
                      undefined,
                  }
                : item,
            )
          : [...prev.system.workspaceProjects, nextProject];
        const nextSystem = resolveWorkspaceProjects(
          {
            ...prev.system,
            workspaceProjects,
            activeWorkspaceProjectId: existing?.id ?? nextProject.id,
            hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
          },
          getDefaultWorkspaceProjectPath(prev.system),
        );
        return {
          ...prev,
          system: nextSystem,
        };
      });
      if (options?.startConversation) {
        setActiveView("chat");
        startNewConversation({ workdir: targetProject.path });
      }
    },
    [setSettings, workspaceProjects],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      if (isMobileSidebarLayout()) {
        setSidebarOpen(false);
      }
      activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) {
        return;
      }

      if (isMobileSidebarLayout()) {
        setSidebarOpen(false);
      }
      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSettings],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleWorkdirPickerSelect = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(normalizedPath, "managed"));
      void refreshHistoryWorkdirs(api);
    },
    [activateWorkspaceProject, api, refreshHistoryWorkdirs],
  );

  const commitWorkspaceProjectRename = useCallback(
    (project: WorkspaceProject, nextNameInput: string) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const nextName = nextNameInput.trim();
      if (!nextName || nextName === project.name) return;
      setSettings((prev) => {
        const pathKey = workspaceProjectPathKey(project.path);
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        const updatedProject: WorkspaceProject = {
          ...(existing ?? project),
          id: existing?.id ?? project.id,
          name: nextName,
          kind: (existing ?? project).kind === "history" ? "folder" : (existing ?? project).kind,
          updatedAt: Date.now(),
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleStartRenamingWorkspaceProject = useCallback((project: WorkspaceProject) => {
    if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
    setProjectRenamingId(project.id);
    setProjectRenameDraft(project.name);
  }, []);

  const handleCommitWorkspaceProjectRename = useCallback(() => {
    if (!projectRenamingId) {
      return;
    }
    const project = workspaceProjects.find((item) => item.id === projectRenamingId);
    if (project) {
      commitWorkspaceProjectRename(project, projectRenameDraft);
    }
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, [commitWorkspaceProjectRename, projectRenameDraft, projectRenamingId, workspaceProjects]);

  const handleCancelWorkspaceProjectRename = useCallback(() => {
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, []);

  const handleSetWorkspaceProjectPinned = useCallback(
    (project: WorkspaceProject, isPinned: boolean) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;

      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        if (!existing && !isPinned) {
          return prev;
        }

        const now = Date.now();
        const source = existing ?? project;
        const updatedProject: WorkspaceProject = {
          ...source,
          id: existing?.id ?? source.id,
          kind: source.id === DEFAULT_WORKSPACE_PROJECT_ID ? "managed" : source.kind,
          updatedAt: now,
          isPinned,
          pinnedAt: isPinned ? now : null,
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleSidebarProjectsCollapsedChange = useCallback(
    (projectsCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            projectsCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            recentCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    const unsubscribe = api.subscribeStatus((nextStatus, error) => {
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setStatusError(error);
    });
    return () => {
      unsubscribe();
    };
  }, [api]);

  const refreshChatQueueSnapshot = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }
      void currentApi
        .chatQueueGet(conversationIdValue)
        .then((response) => applyChatQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyChatQueueSnapshot],
  );

  // Command pipeline hooks (assigned per render so they see fresh closures).
  pipelineOnBoundRef.current = (update, pending) => {
    const draftId = draftClientRequestsRef.current.get(pending.clientRequestId)?.trim() ?? "";
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const realId = update.conversationId?.trim() ?? "";
    if (draftId && realId && draftId !== realId) {
      bindDraftConversation(draftId, realId);
    }
  };
  pipelineOnQueuedInGuiRef.current = (update, pending) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    refreshChatQueueSnapshot(update.conversationId?.trim() || pending.conversationId);
    if (pending.isEditResend) {
      // The seeded `rebased` already truncated committed optimistically, but
      // the command was parked — server-side history is unchanged; a full
      // quiet refresh restores the truncated suffix.
      void refreshDisplayedConversationHistorySnapshot(
        update.conversationId?.trim() || pending.conversationId,
        api,
        { forceFull: true },
      );
    }
  };
  pipelineOnFailedRef.current = (pending, _errorCode, message) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const conversationIdValue = pending.conversationId.trim();
    if (pending.isEditResend) {
      void refreshDisplayedConversationHistorySnapshot(conversationIdValue, api, {
        forceFull: true,
      });
    }
    if (isLocalDraftConversationId(conversationIdValue)) {
      // The draft never materialized: drop its optimistic sidebar row. The
      // transcript keeps the pipeline's error entry.
      optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
      unlockHistoryTitlePosition(conversationIdValue);
      updateHistoryItems((current) => current.filter((item) => item.id !== conversationIdValue));
    }
    if (isDisplayedConversation(conversationIdValue)) {
      setChatError(message);
    }
  };

  // chat.activity is the single global source for running conversations
  // (sidebar dots, busy fallbacks) plus project activity bookkeeping.
  useEffect(() => {
    if (!api) {
      activityStore.clear();
      return;
    }
    const unsubscribe = api.subscribeChatActivity((event: ConversationActivityEvent) => {
      const previous = activityStore.get(event.conversationId);
      activityStore.applyActivityEvent(event);
      // Settle pending commands from the always-on hub too: the run may
      // start (or finish) while its conversation is not the displayed one,
      // and without this the 60s startup watchdog would fire spuriously.
      // The `queued` state stays armed — the gateway watchdog plus
      // command_update failed cover that phase.
      if (event.runId && (event.running ? event.state !== "queued" : true)) {
        chatCommandPipeline.handleRunSignal(
          event.conversationId,
          event.runId,
          event.clientRequestId ?? undefined,
        );
      }
      const workdir =
        event.workdir?.trim() ||
        previous?.workdir?.trim() ||
        historyItemsRef.current.find((item) => item.id === event.conversationId)?.cwd?.trim() ||
        "";
      recordProjectActivity(workdir, event.updatedAt);
      if (!event.running && previous) {
        void refreshHistoryWorkdirs(api);
      }
    });
    return unsubscribe;
  }, [activityStore, api, chatCommandPipeline, recordProjectActivity, refreshHistoryWorkdirs]);

  useEffect(() => {
    if (!api) {
      return;
    }
    return api.subscribeChatCommandUpdates((update) => {
      chatCommandPipeline.handleCommandUpdate(update);
    });
  }, [api, chatCommandPipeline]);

  // Every (re)connect re-baselines the activity store from the gateway's
  // authoritative registry: chat.activity broadcasts are single-shot, so a
  // stop that raced a dropped socket would otherwise leave the green dot
  // (and streaming cursor fallback) stuck until the next history.list.
  useEffect(() => {
    if (!api) {
      return;
    }
    let cancelled = false;
    const unsubscribe = api.subscribeConnection((connected) => {
      if (!connected || cancelled) {
        return;
      }
      void api
        .listChatActivities()
        .then((items) => {
          if (cancelled) {
            return;
          }
          activityStore.hydrate(normalizeActivityHydrationItems(items), {
            keepConversationIds: chatCommandPipeline.pendingConversationIds(),
          });
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activityStore, api, chatCommandPipeline]);

  const subscribeActivityStore = useCallback(
    (listener: () => void) => activityStore.subscribe(listener),
    [activityStore],
  );
  const activitySnapshot = useSyncExternalStore(
    subscribeActivityStore,
    activityStore.getSnapshot,
    activityStore.getSnapshot,
  );

  // App-level observation of the displayed conversation's stream: titles,
  // pipeline settlement, queue refreshes, tunnel side effects, and the one
  // scroll-compensated fold commit at run_started.
  const observeConversationStreamEvent = useCallback(
    (
      targetConversationId: string,
      event: ConversationStreamEvent,
      options?: { replay?: boolean },
    ) => {
      const isReplay = options?.replay === true;
      const eventClientRequestId =
        typeof (event as { client_request_id?: unknown }).client_request_id === "string"
          ? ((event as { client_request_id: string }).client_request_id ?? "").trim()
          : "";
      switch (event.type) {
        case "run_started": {
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          if (!isReplay && isDisplayedConversation(targetConversationId)) {
            // The transcript store folded the settled tail into committed
            // when it applied this event. Commit that fold to the DOM in one
            // synchronous, scroll-compensated pass — otherwise the
            // virtualizer paints a frame with estimated row heights and the
            // transcript visibly jumps right as the next run starts.
            const shouldKeepBottom = isTranscriptAtBottom();
            preserveTranscriptScrollPosition(
              () => {
                flushSync(() => {
                  setFoldFlushTick((current) => current + 1);
                });
              },
              { stickToBottom: shouldKeepBottom },
            );
            if (shouldKeepBottom) {
              stickTranscriptToBottom();
            } else {
              refreshTranscriptScrollState();
            }
          }
          return;
        }
        case "run_finished": {
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          // Settle the sidebar dot by run identity: the stream's terminal is
          // authoritative even when the chat.activity broadcast was missed.
          activityStore.settleRun(targetConversationId, readEventRunId(event));
          const finishedTitle =
            typeof (event as { title?: unknown }).title === "string"
              ? ((event as { title: string }).title ?? "").trim()
              : "";
          if (finishedTitle) {
            applyLiveConversationTitle(targetConversationId, finishedTitle, { isFinal: true });
          }
          return;
        }
        case "run_queued": {
          chatCommandPipeline.handleRunSignal(
            targetConversationId,
            readEventRunId(event),
            eventClientRequestId || undefined,
          );
          if (!isReplay) {
            refreshChatQueueSnapshot(targetConversationId);
          }
          return;
        }
        default: {
          const chatEvent = event as ChatEvent;
          const liveTitle = readChatEventTitle(chatEvent);
          if (liveTitle && isChatEventTitleFinal(chatEvent)) {
            applyLiveConversationTitle(targetConversationId, liveTitle, { isFinal: true });
          }
          if (!isReplay) {
            handleTunnelManagerChatEvent(chatEvent);
          }
        }
      }
    },
    [
      activityStore,
      applyLiveConversationTitle,
      chatCommandPipeline,
      handleTunnelManagerChatEvent,
      isTranscriptAtBottom,
      preserveTranscriptScrollPosition,
      refreshChatQueueSnapshot,
      refreshTranscriptScrollState,
      stickTranscriptToBottom,
    ],
  );

  const handleConversationStreamSync = useCallback(
    (targetConversationId: string, result: ConversationSubscribeResult) => {
      if (result.activity) {
        chatCommandPipeline.handleRunSignal(
          targetConversationId,
          result.activity.runId,
          result.activity.clientRequestId,
        );
      } else if (!chatCommandPipeline.hasPending(targetConversationId)) {
        // The authoritative subscribe says nothing is running and no local
        // submission is in flight: a lingering dot for this conversation is
        // a missed-stop zombie — settle it by its own run identity.
        const currentActivity = activityStore.get(targetConversationId);
        if (currentActivity) {
          activityStore.settleRun(targetConversationId, currentActivity.runId);
        }
      }
      for (const event of result.events) {
        observeConversationStreamEvent(targetConversationId, event, { replay: true });
      }
    },
    [activityStore, chatCommandPipeline, observeConversationStreamEvent],
  );

  const handleConversationStreamEvent = useCallback(
    (targetConversationId: string, event: ConversationStreamEvent) => {
      observeConversationStreamEvent(targetConversationId, event);
    },
    [observeConversationStreamEvent],
  );

  const hasPendingChatCommand = useCallback(
    (targetConversationId: string) => chatCommandPipeline.hasPending(targetConversationId),
    [chatCommandPipeline],
  );

  // THE transcript source: the displayed conversation's store snapshot plus a
  // persistent stream subscription (subscribed whenever the id is real —
  // regardless of running state, which is what makes GUI queue auto-sends
  // race-free: the next run's events simply flow in).
  const displayedConversationId = resolveVisibleConversationId(selectedHistoryId, conversationId);
  const { transcript: displayedTranscript, busy: displayedConversationBusy } = useConversationChat({
    api,
    conversationId: displayedConversationId || null,
    registry: transcriptStoreRegistry,
    activityStore,
    isLocalDraft: isLocalDraftConversationId,
    onStreamEvent: handleConversationStreamEvent,
    onStreamSync: handleConversationStreamSync,
    hasPendingCommand: hasPendingChatCommand,
    pendingRevision: pendingCommandRevision,
  });
  displayedConversationBusyRef.current = displayedConversationBusy;

  // Deterministic messageRef attachment: when the displayed conversation
  // transitions busy → idle (run finished), run the quiet enrich refresh so
  // the settled tail's user bubbles gain their persisted messageRef (edit
  // affordance) without waiting for a history upsert to race the idle gate.
  // The upsert-while-idle path below stays as the backstop for the
  // persist-after-done ordering.
  const previousDisplayedBusyRef = useRef({ id: "", busy: false });
  useEffect(() => {
    const prev = previousDisplayedBusyRef.current;
    previousDisplayedBusyRef.current = {
      id: displayedConversationId,
      busy: displayedConversationBusy,
    };
    if (
      prev.id === displayedConversationId &&
      prev.busy &&
      !displayedConversationBusy &&
      displayedConversationId
    ) {
      void refreshDisplayedConversationHistorySnapshot(displayedConversationId, api);
    }
  }, [
    api,
    displayedConversationBusy,
    displayedConversationId,
    refreshDisplayedConversationHistorySnapshot,
  ]);

  useEffect(() => {
    if (!api) {
      return;
    }

    const unsubscribe = api.subscribeHistory((event: GatewayHistoryEvent) => {
      const targetConversationId = event.conversation_id.trim();
      if (!targetConversationId) {
        return;
      }

      if (event.kind === "upsert") {
        recordProjectActivity(event.conversation.cwd, event.conversation.updated_at);
      }

      const matchesCurrentHistoryScope =
        event.kind !== "upsert" ||
        historyConversationMatchesFilter(event.conversation, historyListFilterRef.current);
      updateHistoryItems((current) => {
        if (event.kind === "upsert" && !matchesCurrentHistoryScope) {
          return current.filter((item) => item.id !== targetConversationId);
        }
        return applyGatewayHistoryEvent(current, event, {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
        });
      });
      void refreshHistoryWorkdirs(api);
      setHistoryError(null);

      if (event.kind === "delete") {
        optimisticTitleConversationIdsRef.current.delete(targetConversationId);
        unlockHistoryTitlePosition(targetConversationId);
        transcriptStoreRegistry.remove(targetConversationId);
        conversationWorkdirsRef.current.delete(targetConversationId);
        if (
          conversationIdRef.current === targetConversationId ||
          selectedHistoryIdRef.current === targetConversationId
        ) {
          startNewConversation({
            workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
          });
        }
        return;
      }

      // Upsert of the displayed conversation while idle: quiet, id-preserving
      // refresh. Run completion never triggers a refetch — the settled tail
      // already shows the final reply.
      if (
        isDisplayedConversation(targetConversationId) &&
        !isConversationBusy(targetConversationId)
      ) {
        void refreshDisplayedConversationHistorySnapshot(targetConversationId, api);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    api,
    activeWorkspaceProjectPath,
    getHistoryPositionLockedConversationIds,
    isAgentMode,
    isConversationBusy,
    recordProjectActivity,
    refreshDisplayedConversationHistorySnapshot,
    refreshHistoryWorkdirs,
    transcriptStoreRegistry,
    unlockHistoryTitlePosition,
    updateHistoryItems,
  ]);

  async function selectHistory(
    conversationIdValue: string,
    currentApi = api,
    options?: {
      fullHistory?: boolean;
      scrollToBottom?: boolean;
    },
  ) {
    if (!currentApi) {
      return;
    }

    const loadSequence = invalidateHistoryLoad();
    const selectionRevision = markVisibleConversationRevision();
    const previousDisplayedConversationId = getDisplayedConversationId();
    const isChangingConversation = previousDisplayedConversationId !== conversationIdValue;
    if (options?.scrollToBottom) {
      pendingDisplayedConversationAutoBottomRef.current = conversationIdValue;
    }
    if (isChangingConversation && previousDisplayedConversationId) {
      // Fold the previous conversation's settled turns so a revisit starts
      // with a clean virtualized transcript.
      transcriptStoreRegistry.peek(previousDisplayedConversationId)?.foldSettledTurns();
    }

    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = conversationIdValue;
    conversationIdRef.current = conversationIdValue;
    selectedHistoryIdRef.current = conversationIdValue;
    setConversationId(conversationIdValue);
    setSelectedHistoryId(conversationIdValue);
    if (isChangingConversation) {
      setChatError(null);
      setSelectedHistory(null);
    }

    setHistoryDetailLoading(true);
    try {
      const detail = await currentApi.getHistory(
        conversationIdValue,
        options?.fullHistory ? undefined : { maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES },
      );
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      setSelectedHistory(detail);
      transcriptStoreRegistry
        .get(conversationIdValue)
        .applyHistorySnapshot(entries, { mode: "replace" });
      const detailWorkdir = detail.conversation?.cwd?.trim();
      if (detailWorkdir) {
        conversationWorkdirsRef.current.set(conversationIdValue, detailWorkdir);
      }
    } catch (error) {
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      const message = asErrorMessage(error, "history detail request failed");
      setSelectedHistory({
        conversation_id: conversationIdValue,
        messages_json: message,
        has_more: false,
      } satisfies HistoryDetail);
      setChatError(message);
    } finally {
      if (
        historyLoadSequenceRef.current === loadSequence &&
        visibleConversationRevisionRef.current === selectionRevision
      ) {
        setHistoryDetailLoading(false);
      }
    }
  }

  async function reloadHistory(currentApi = api, options?: ReloadHistoryOptions) {
    if (!currentApi) {
      return;
    }

    const silent = options?.silent === true;
    const loadingStartedAt = Date.now();
    if (!silent) {
      setHistoryListLoading(true);
      setHistoryError(null);
    }
    const requestScopeKey = historyScopeKeyRef.current;
    const requestFilter = historyListFilterRef.current;
    try {
      const response = await currentApi.listHistory(1, HISTORY_LIST_PAGE_SIZE, requestFilter);
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      // Authoritative running snapshot: hydrate the activity store (sidebar
      // dots) and project activity bookkeeping. Conversations with an
      // in-flight local command are kept — the gateway may not have
      // registered their run when the snapshot was built.
      const runningConversations = normalizeActivityHydrationItems(response.running_conversations);
      activityStore.hydrate(runningConversations, {
        keepConversationIds: chatCommandPipeline.pendingConversationIds(),
      });
      for (const runningConversation of runningConversations) {
        recordProjectActivity(runningConversation.workdir, runningConversation.updatedAt);
      }
      const retainedConversationIds = new Set<string>(
        runningConversations.map((item) => item.conversationId),
      );
      for (const item of historyItemsRef.current) {
        if (
          isLocalDraftConversationId(item.id) ||
          isConversationBusy(item.id) ||
          getConversationTranscriptEntryCount(item.id) > 0
        ) {
          retainedConversationIds.add(item.id);
        }
      }
      if (silent) {
        for (const item of historyItemsRef.current) {
          retainedConversationIds.add(item.id);
        }
      }
      const conversations = reconcileConversationSummaries(
        historyItemsRef.current,
        response.conversations,
        {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
          retainConversationIds: retainedConversationIds,
        },
      );
      const refreshedNextPage = response.conversations.length > 0 ? 2 : 1;
      const nextPage = silent
        ? Math.max(nextHistoryPageRef.current, refreshedNextPage)
        : refreshedNextPage;
      commitHistoryListState(conversations, response.total_count, nextPage);

      if (options?.skipSelectionSync) {
        return;
      }

      const currentConversationId = conversationIdRef.current;
      const currentSelectedHistoryId = selectedHistoryIdRef.current;
      const currentTranscriptEntryCount =
        getConversationTranscriptEntryCount(currentConversationId);
      const currentSelectedHistory = selectedHistoryRef.current;
      const requestedConversationId = options?.preferredConversationId?.trim() ?? "";
      const protectedConversationId = protectedConversationRef.current.trim();
      const isProtectedDraftConversation = protectedConversationId === PROTECTED_DRAFT_CONVERSATION;
      const hadCurrentConversationInHistory =
        pickConversationSummary(historyItemsRef.current, currentConversationId) !== null;

      const currentSummary = pickConversationSummary(conversations, currentConversationId);
      const protectedConversationSummary =
        protectedConversationId && !isProtectedDraftConversation
          ? pickConversationSummary(conversations, protectedConversationId)
          : null;

      if (
        currentConversationId &&
        !isLocalDraftConversationId(currentConversationId) &&
        hadCurrentConversationInHistory &&
        currentSummary === null
      ) {
        startNewConversation({
          workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
        });
        return;
      }

      if (isProtectedDraftConversation) {
        return;
      }

      if (
        protectedConversationId &&
        protectedConversationSummary === null &&
        (requestedConversationId === "" || requestedConversationId === protectedConversationId) &&
        (currentConversationId === protectedConversationId ||
          currentSelectedHistoryId === protectedConversationId)
      ) {
        return;
      }

      const requestedConversationSummary =
        requestedConversationId !== "" && !isLocalDraftConversationId(requestedConversationId)
          ? pickConversationSummary(conversations, requestedConversationId)
          : null;
      const shouldKeepCurrentConversation =
        requestedConversationId !== "" &&
        requestedConversationSummary === null &&
        currentConversationId === requestedConversationId &&
        currentTranscriptEntryCount > 0;

      if (shouldKeepCurrentConversation) {
        return;
      }

      const shouldKeepDraftConversation = hasLocalDraftConversation({
        conversationId: currentConversationId,
        selectedHistoryId: currentSelectedHistoryId,
        requestedConversationId,
        chatMessageCount: currentTranscriptEntryCount,
        pendingUploadCount: pendingUploadedFilesRef.current.length,
        draftPinned: draftConversationPinnedRef.current,
      });
      if (shouldKeepDraftConversation) {
        return;
      }

      const isCurrentConversationRunning =
        currentConversationId !== "" &&
        isConversationBusy(currentConversationId) &&
        (currentSelectedHistoryId === "" || currentSelectedHistoryId === currentConversationId) &&
        requestedConversationId === "";
      if (isCurrentConversationRunning) {
        return;
      }

      const preferredConversationId =
        requestedConversationSummary?.id ??
        protectedConversationSummary?.id ??
        (pickConversationSummary(conversations, currentSelectedHistoryId)
          ? currentSelectedHistoryId
          : pickConversationSummary(conversations, currentConversationId)
            ? currentConversationId
            : currentConversationId && currentTranscriptEntryCount > 0
              ? ""
              : (conversations[0]?.id ?? ""));

      if (!preferredConversationId) {
        if (!currentConversationId) {
          setSelectedHistoryId("");
          setSelectedHistory(null);
        }
        return;
      }

      const shouldHydrateSelection =
        options?.hydrateSelection === true ||
        currentSelectedHistory?.conversation_id !== preferredConversationId ||
        getDisplayedConversationId() !== preferredConversationId;

      if (shouldHydrateSelection) {
        await selectHistory(preferredConversationId, currentApi, {
          scrollToBottom: true,
        });
      }
    } catch (error) {
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const message = asErrorMessage(error, "history request failed");
      setHistoryError(message);
    } finally {
      if (!silent && requestScopeKey === historyScopeKeyRef.current) {
        await waitForMinimumHistoryListLoading(loadingStartedAt);
        setHistoryListLoading(false);
      }
    }
  }

  const loadMoreHistory = useCallback(async () => {
    if (!api || historyListPageLoadingRef.current || !historyHasMoreRef.current) {
      return;
    }

    historyListPageLoadingRef.current = true;
    setHistoryListLoadingMore(true);
    const requestScopeKey = historyScopeKeyRef.current;
    const requestFilter = historyListFilterRef.current;
    try {
      const pageNumber = nextHistoryPageRef.current;
      const response = await api.listHistory(pageNumber, HISTORY_LIST_PAGE_SIZE, requestFilter);
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const runningConversations = normalizeActivityHydrationItems(response.running_conversations);
      activityStore.hydrate(runningConversations, {
        keepConversationIds: chatCommandPipeline.pendingConversationIds(),
      });
      for (const runningConversation of runningConversations) {
        recordProjectActivity(runningConversation.workdir, runningConversation.updatedAt);
      }
      const retainConversationIds = new Set(historyItemsRef.current.map((item) => item.id));
      const conversations = reconcileConversationSummaries(
        historyItemsRef.current,
        response.conversations,
        {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
          retainConversationIds,
        },
      );
      const nextPage = response.conversations.length === 0 ? pageNumber : pageNumber + 1;
      commitHistoryListState(conversations, response.total_count, nextPage);
      setHistoryError(null);
    } catch (error) {
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      setHistoryError(asErrorMessage(error, "读取更多历史列表失败"));
    } finally {
      if (requestScopeKey === historyScopeKeyRef.current) {
        historyListPageLoadingRef.current = false;
        setHistoryListLoadingMore(false);
      }
    }
  }, [
    activityStore,
    api,
    chatCommandPipeline,
    commitHistoryListState,
    getHistoryPositionLockedConversationIds,
    recordProjectActivity,
  ]);

  const prepareChatRuntime = useCallback(
    async (
      reason: string,
      currentApi = api,
      timeoutMs = CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
    ): Promise<AgentStatus> => {
      if (!currentApi) {
        throw new Error("Gateway client is not ready.");
      }

      if (!chatRuntimePreparePromiseRef.current) {
        chatRuntimePreparePromiseRef.current = currentApi
          .prepareChatRuntime(reason)
          .then((nextStatus) => {
            statusRef.current = nextStatus;
            setStatus(nextStatus);
            setStatusError(null);
            return nextStatus;
          })
          .catch((error) => {
            setStatusError(asErrorMessage(error, "status request failed"));
            throw error;
          })
          .finally(() => {
            chatRuntimePreparePromiseRef.current = null;
          });
      }

      const preparePromise = chatRuntimePreparePromiseRef.current;
      if (!preparePromise) {
        throw new Error("Gateway chat runtime preparation did not start.");
      }
      if (timeoutMs <= 0) {
        return preparePromise;
      }

      let timeoutId: number | null = null;
      try {
        return await Promise.race([
          preparePromise,
          new Promise<AgentStatus>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              reject(new Error("Desktop chat runtime is recovering. Please retry shortly."));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    if (!api || !status?.online) {
      return;
    }

    const currentConversationId = conversationIdRef.current.trim();
    const currentTranscriptEntryCount = getConversationTranscriptEntryCount(currentConversationId);
    const shouldKeepNewConversation =
      currentTranscriptEntryCount === 0 &&
      selectedHistoryIdRef.current.trim() === "" &&
      (currentConversationId === "" || isLocalDraftConversationId(currentConversationId));

    void reloadHistory(api, {
      skipSelectionSync: shouldKeepNewConversation,
      hydrateSelection:
        !shouldKeepNewConversation &&
        currentTranscriptEntryCount === 0 &&
        (currentConversationId === "" || isLocalDraftConversationId(currentConversationId)),
    });
  }, [api, historyScopeKey, status?.online]);

  // Reconnect reconciliation: a run that finished while the socket was down
  // never produced an idle activity event; re-hydrate the activity registry
  // from history.list so no phantom running dot survives an outage.
  const previousOnlineRef = useRef<boolean | null>(null);
  useEffect(() => {
    const wasOnline = previousOnlineRef.current;
    const isOnline = status?.online === true;
    previousOnlineRef.current = isOnline;
    if (!api || !isOnline || wasOnline !== false) {
      return;
    }
    void reloadHistory(api, { silent: true, skipSelectionSync: true });
  }, [api, status?.online]);

  // Foreground nudge: waking the page just pings the runtime keep-warm; the
  // socket's own wakeup/reconnect plus per-conversation subscription resume
  // replaces the old page-restore recovery machinery.
  useEffect(() => {
    if (!api || historyShareToken || status?.online !== true) {
      return;
    }

    const nudgeRuntime = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void prepareChatRuntime("foreground", api, CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS).catch(
        () => undefined,
      );
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        nudgeRuntime();
      }
    };

    window.addEventListener("pageshow", nudgeRuntime);
    window.addEventListener("focus", nudgeRuntime);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("resume", nudgeRuntime);
    nudgeRuntime();

    return () => {
      window.removeEventListener("pageshow", nudgeRuntime);
      window.removeEventListener("focus", nudgeRuntime);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("resume", nudgeRuntime);
    };
  }, [api, historyShareToken, prepareChatRuntime, status?.online]);

  useEffect(() => {
    if (!api || historyShareToken || status?.online !== true) {
      return;
    }

    const keepWarm = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void prepareChatRuntime("keep-warm", api, CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS).catch(
        () => undefined,
      );
    };

    keepWarm();
    const intervalId = window.setInterval(keepWarm, CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [api, historyShareToken, prepareChatRuntime, status?.online]);

  // Lean submission flow: optimistic echo + chat.command through the pipeline.
  // Everything after run start flows through the persistent conversation
  // stream subscription — sendChat does not consume stream events at all.
  async function sendChat(
    message: string,
    options?: SendChatOptions,
  ): Promise<ChatCommandOutcome | null> {
    if (!api) {
      return null;
    }

    const uploadedFiles = options?.uploadedFiles ?? [];
    let activeConversationId = options?.conversationId?.trim() || conversationIdRef.current.trim();
    if (!activeConversationId) {
      activeConversationId = createLocalDraftConversationId();
      conversationIdRef.current = activeConversationId;
      selectedHistoryIdRef.current = activeConversationId;
      setConversationId(activeConversationId);
      setSelectedHistoryId(activeConversationId);
    }
    const startedAsDraftConversation = isLocalDraftConversationId(activeConversationId);
    if (chatCommandPipeline.hasPending(activeConversationId)) {
      // One in-flight submission per conversation; the composer routes busy
      // conversations to the GUI queue instead.
      return null;
    }
    clearCachedComposerDraft(activeConversationId);

    const clientRequestId = options?.clientRequestId?.trim() || crypto.randomUUID();
    const startedAt = Date.now();
    const persistedConversationWorkdir =
      pickConversationSummary(historyItemsRef.current, activeConversationId)?.cwd?.trim() || "";
    const runtimeConversationWorkdir =
      conversationWorkdirsRef.current.get(activeConversationId)?.trim() || "";
    const effectiveWorkdir = isAgentMode
      ? options?.workdir?.trim() ||
        persistedConversationWorkdir ||
        runtimeConversationWorkdir ||
        activeWorkspaceProjectPath ||
        settings.system.workdir.trim()
      : "";
    if (effectiveWorkdir) {
      conversationWorkdirsRef.current.set(activeConversationId, effectiveWorkdir);
    }
    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = activeConversationId;
    setChatError(null);
    if (isDisplayedConversation(activeConversationId)) {
      stickTranscriptToBottom();
    }
    if (startedAsDraftConversation) {
      draftClientRequestsRef.current.set(clientRequestId, activeConversationId);
      optimisticTitleConversationIdsRef.current.add(activeConversationId);
      updateHistoryItems((current) =>
        upsertConversationSummary(
          current,
          {
            id: activeConversationId,
            title: buildOptimisticConversationTitle(message),
            created_at: startedAt,
            updated_at: startedAt,
            message_count: 1,
            provider_id: settings.selectedModel?.customProviderId ?? "gateway",
            model: settings.selectedModel?.model ?? "gateway",
            cwd: effectiveWorkdir || undefined,
          },
          { preserveExistingTitle: true },
        ),
      );
    }

    // Keep-warm preflight: the command request itself is the reliable wake-up
    // signal for a suspended desktop WebView; the status refresh stays in the
    // background so a stale heartbeat cannot block it.
    void prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS).catch(() => undefined);

    const runtimeControls = normalizeChatRuntimeControlsForProvider(
      options?.runtimeControls ?? settings.chatRuntimeControls,
      {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      },
    );
    const commandInput: GatewayChatCommandInput = {
      type: options?.editMessageRef ? "chat.edit_resend" : "chat.submit",
      message,
      conversationId: startedAsDraftConversation ? undefined : activeConversationId,
      selectedModel: buildGatewaySelectedModel(settings.selectedModel, activeProviders),
      systemSettings: buildGatewaySystemSettings(settings, effectiveWorkdir),
      uploadedFiles,
      clientRequestId,
      runtimeControls,
      baseMessageRef: options?.editMessageRef,
      queuePolicy: options?.queuePolicy ?? "auto",
    };

    const outcome = await chatCommandPipeline.submit({
      conversationId: activeConversationId,
      clientRequestId,
      message,
      attachments: uploadedFiles,
      isEditResend: Boolean(options?.editMessageRef),
      optimistic: options?.optimisticEcho !== false,
      submit: () => api.chatCommand(commandInput),
    });

    if (outcome.kind === "accepted") {
      const acceptedConversationId = outcome.accepted.conversationId.trim();
      if (
        startedAsDraftConversation &&
        acceptedConversationId &&
        acceptedConversationId !== activeConversationId &&
        !isLocalDraftConversationId(acceptedConversationId)
      ) {
        // The accept response already carries the real conversation id; run
        // the same binding path a `command_update bound` would take.
        chatCommandPipeline.handleCommandUpdate({
          runId: outcome.accepted.runId,
          clientRequestId,
          conversationId: acceptedConversationId,
          phase: "bound",
          errorCode: null,
          message: null,
        });
      }
    } else if (outcome.kind === "failed") {
      draftClientRequestsRef.current.delete(clientRequestId);
    }
    return outcome;
  }

  // Edit-resend is memoized across settings sync; always call the latest sender
  // so model and execution-mode overrides stay aligned with the visible WebUI state.
  sendChatRef.current = sendChat;

  async function cancelChat(targetConversationId?: string) {
    const activeConversationId = targetConversationId?.trim() || getDisplayedConversationId();
    if (!api || !activeConversationId || isLocalDraftConversationId(activeConversationId)) {
      return;
    }
    // No local terminal marking: the stream's run_finished settles the UI
    // (cancelling state shows until the agent confirms or the gateway
    // watchdog forces the terminal event).
    const runId =
      transcriptStoreRegistry.peek(activeConversationId)?.getSnapshot().activeRun?.runId ??
      activityStore.get(activeConversationId)?.runId ??
      undefined;
    try {
      await api.cancelChat(activeConversationId, runId);
    } catch (error) {
      if (!isAbortError(error)) {
        setChatError(asErrorMessage(error, "cancel chat request failed"));
      }
    }
  }

  async function materializeComposerDraftForSend(
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
  ) {
    let text = (
      isAgentMode && draft.largePastes.length > 0
        ? draft.textWithoutLargePastes
        : buildTextFromComposerDraft(draft)
    ).trim();
    let uploadedFiles = files;

    if (isAgentMode && draft.largePastes.length > 0) {
      setChatError(null);
      isImportingPastedTextRef.current = true;
      setIsUploadingFiles(true);
      try {
        const imported = await importPastedTextsAsFiles({
          token,
          workdir,
          pastes: draft.largePastes,
        });
        text = buildTextFromComposerDraft(draft, imported.fileByPasteId).trim();
        uploadedFiles = mergePendingUploadedFiles(files, imported.files);
      } finally {
        isImportingPastedTextRef.current = false;
        setIsUploadingFiles(false);
      }
    }

    return { text, uploadedFiles };
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const key = conversationId.trim();
    if (!key || getDisplayedConversationId() !== key) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(key, []);
    clearCachedComposerDraft(key);
  }

  async function submitCurrentComposerToGuiQueue(queuePolicy: "append" | "interrupt") {
    const conversationIdValue = getDisplayedConversationId();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    let clearedComposer = false;
    if (!api || !conversationIdValue || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const workdirForTurn = (
      conversationWorkdirsRef.current.get(conversationIdValue) ??
      displayedConversationWorkdirRef.current ??
      activeWorkspaceProjectPath ??
      settings.system.workdir
    ).trim();
    try {
      const materialized = await materializeComposerDraftForSend(
        draft,
        uploadedFiles,
        workdirForTurn,
      );
      if (!materialized.text && materialized.uploadedFiles.length === 0) {
        return false;
      }
      clearCurrentComposerDraftForQueuedTurn(conversationIdValue);
      clearedComposer = true;
      if (chatCommandPipeline.hasPending(conversationIdValue)) {
        // A command is already in flight for this conversation: park this one
        // straight into the GUI queue. The pipeline slot (pre-first-token
        // spinner + watchdog) belongs to the first command; the queue panel
        // updates via command_update/run_queued and chat_queue events.
        await api.chatCommand({
          type: "chat.submit",
          message: materialized.text,
          conversationId: isLocalDraftConversationId(conversationIdValue)
            ? undefined
            : conversationIdValue,
          selectedModel: buildGatewaySelectedModel(settings.selectedModel, activeProviders),
          systemSettings: buildGatewaySystemSettings(settings, workdirForTurn),
          uploadedFiles: materialized.uploadedFiles,
          clientRequestId: crypto.randomUUID(),
          runtimeControls: chatRuntimeControlsForCurrentProvider,
          queuePolicy,
        });
        refreshChatQueueSnapshot(conversationIdValue);
        return true;
      }
      // Same pipeline path as a normal send, minus the optimistic transcript
      // echo — the prompt is queue-destined and must not flash a bubble.
      // `command_update queued_in_gui` (or the stream's run_queued event)
      // refreshes the queue snapshot; a direct start settles through
      // run_started (whose deferred seeds then render the user message).
      const outcome = await sendChat(materialized.text, {
        conversationId: conversationIdValue,
        uploadedFiles: materialized.uploadedFiles,
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        workdir: workdirForTurn,
        queuePolicy,
        optimisticEcho: false,
      });
      if (!outcome) {
        // Benign no-op (client not ready): restore the composer without
        // surfacing an error.
        if (getDisplayedConversationId() === conversationIdValue) {
          if (!composerRef.current?.hasContent()) {
            composerRef.current?.setDraft(draft);
          }
          if (
            (pendingUploadsByConversationRef.current.get(conversationIdValue) ?? []).length === 0
          ) {
            setPendingUploadsForConversation(conversationIdValue, uploadedFiles);
          }
        }
        return false;
      }
      if (outcome.kind === "failed") {
        throw new Error(outcome.message);
      }
      return true;
    } catch (error) {
      if (clearedComposer && getDisplayedConversationId() === conversationIdValue) {
        if (!composerRef.current?.hasContent()) {
          composerRef.current?.setDraft(draft);
        }
        if ((pendingUploadsByConversationRef.current.get(conversationIdValue) ?? []).length === 0) {
          setPendingUploadsForConversation(conversationIdValue, uploadedFiles);
        }
      }
      reportChatQueueActionError(conversationIdValue, error, "queued chat request failed");
      return false;
    }
  }

  async function commitQueuedChatEdit() {
    const session = queuedChatEditSessionRef.current;
    const conversationIdValue = getDisplayedConversationId();
    if (!session || !api || !conversationIdValue) return false;
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }
    try {
      const response = await api.chatQueueEditCommit({
        conversationId: conversationIdValue,
        itemId: session.itemId,
        revision: session.revision,
        draftJson: JSON.stringify(draft),
        uploadedFilesJson: JSON.stringify(uploadedFiles),
      });
      if (!response.accepted) {
        reportChatQueueActionError(
          conversationIdValue,
          response.message || "queued edit failed",
          "queued edit failed",
        );
        return false;
      }
      queuedChatEditSessionRef.current = null;
      composerRef.current?.clear();
      setPendingUploadsForConversation(conversationIdValue, []);
      clearCachedComposerDraft(conversationIdValue);
      applyChatQueueSnapshot(response.snapshot);
      return true;
    } catch (error) {
      reportChatQueueActionError(conversationIdValue, error, "queued edit failed");
      return false;
    }
  }

  function reportChatQueueActionError(conversationId: string, error: unknown, fallback: string) {
    const key = conversationId.trim();
    if (!key) return;
    if (isDisplayedConversation(key)) {
      setChatError(asErrorMessage(error, fallback));
    }
  }

  function runQueuedTurnNow(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueRunNow(conversationIdValue, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
        for (const delayMs of [250, 1000]) {
          window.setTimeout(() => {
            void api
              .chatQueueGet(conversationIdValue)
              .then((nextResponse) => applyChatQueueSnapshot(nextResponse.snapshot))
              .catch(() => undefined);
          }, delayMs);
        }
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat run failed");
      });
  }

  function moveQueuedTurnUp(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueMove(conversationIdValue, id, "up")
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat move failed");
      });
  }

  function editQueuedTurn(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void (async () => {
      if (queuedChatEditSessionRef.current) {
        const committed = await commitQueuedChatEdit();
        if (!committed) return;
      } else {
        const currentDraft = composerRef.current?.getDraft() ?? null;
        const currentUploads = pendingUploadedFiles.slice();
        if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
          const queued = await submitCurrentComposerToGuiQueue("append");
          if (!queued) return;
        }
      }

      const response = await api.chatQueueEditBegin(conversationIdValue, id);
      try {
        if (!response.accepted || !response.item) {
          if (!response.accepted) {
            reportChatQueueActionError(
              conversationIdValue,
              response.message || "queued edit failed",
              "queued edit failed",
            );
          }
          return;
        }
        const draft = JSON.parse(response.item.draftJson) as MentionComposerDraft;
        const uploadedFiles = JSON.parse(response.item.uploadedFilesJson) as PendingUploadedFile[];
        queuedChatEditSessionRef.current = {
          itemId: response.item.id,
          revision: response.snapshot?.revision ?? chatQueueRevisionRef.current,
        };
        composerRef.current?.setDraft(draft);
        setPendingUploadsForConversation(
          conversationIdValue,
          Array.isArray(uploadedFiles) ? uploadedFiles : [],
        );
        clearCachedComposerDraft(conversationIdValue);
        applyChatQueueSnapshot(response.snapshot);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      } catch (error) {
        throw new Error(asErrorMessage(error, "invalid queued edit payload"));
      }
    })().catch((error) => {
      reportChatQueueActionError(conversationIdValue, error, "queued chat edit failed");
    });
  }

  function removeQueuedTurn(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueRemove(conversationIdValue, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat remove failed");
      });
  }

  function startNewConversation(options?: { workdir?: string }) {
    const currentConversationId = conversationIdRef.current.trim();
    if (currentConversationId) {
      transcriptStoreRegistry.peek(currentConversationId)?.foldSettledTurns();
      optimisticTitleConversationIdsRef.current.delete(currentConversationId);
      clearCachedComposerDraft(currentConversationId);
    }
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    setHistorySwitchOverlay(null);
    setHistoryDetailLoading(false);
    const nextConversationId = createLocalDraftConversationId();
    draftConversationPinnedRef.current = true;
    protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    submitInFlightRef.current = false;
    composerRef.current?.clear();
    const nextWorkdir = options?.workdir?.trim() || "";
    if (nextWorkdir) {
      conversationWorkdirsRef.current.set(nextConversationId, nextWorkdir);
    }
    conversationIdRef.current = nextConversationId;
    selectedHistoryIdRef.current = nextConversationId;
    setConversationId(nextConversationId);
    setSelectedHistoryId(nextConversationId);
    setChatError(null);
    setSelectedHistory(null);
    setPendingUploadsForConversation(nextConversationId, []);
  }

  const removeWorkspaceProjectFromSettings = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const path = project.path.trim();
      const pathKey = workspaceProjectPathKey(path);
      setActiveWorkspaceProjectId((current) => {
        const currentProject = workspaceProjects.find((item) => item.id === current);
        if (
          current === project.id ||
          (pathKey && currentProject && workspaceProjectPathKey(currentProject.path) === pathKey)
        ) {
          return DEFAULT_WORKSPACE_PROJECT_ID;
        }
        return current;
      });
      setSettings((prev) => {
        const nextHidden =
          pathKey &&
          prev.system.hiddenWorkspaceProjectPaths.some(
            (item) => workspaceProjectPathKey(item) === pathKey,
          )
            ? prev.system.hiddenWorkspaceProjectPaths
            : path
              ? [...prev.system.hiddenWorkspaceProjectPaths, path]
              : prev.system.hiddenWorkspaceProjectPaths;
        const nextSettings = {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects: prev.system.workspaceProjects.filter(
                (item) => item.id !== project.id && workspaceProjectPathKey(item.path) !== pathKey,
              ),
              hiddenWorkspaceProjectPaths: nextHidden,
              missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
                (item) => workspaceProjectPathKey(item) !== pathKey,
              ),
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
        return removeRightDockProjectState(nextSettings, pathKey);
      });
      setProjectRenamingId((current) => (current === project.id ? null : current));
      setProjectRenameDraft("");
    },
    [setSettings, workspaceProjects],
  );

  const handleRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;

      void (async () => {
        const currentApi = api;
        if (!currentApi) {
          setHistoryError("Gateway 未连接，暂时不能删除项目会话。");
          return;
        }

        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        const projectHasRunningConversation = () => {
          if (!pathKey) return false;
          for (const [conversationId, activity] of activityStore.getSnapshot().activities) {
            const runtimeWorkdir =
              activity.workdir?.trim() ||
              conversationWorkdirsRef.current.get(conversationId)?.trim() ||
              "";
            const persistedWorkdir =
              historyItemsRef.current.find((item) => item.id === conversationId)?.cwd?.trim() || "";
            if (workspaceProjectPathKey(runtimeWorkdir || persistedWorkdir) === pathKey) {
              return true;
            }
          }
          return false;
        };

        if (projectHasRunningConversation()) {
          setHistoryError(runningMessage);
          return;
        }

        setHistoryError(null);
        setHistoryMutating(true);
        try {
          const conversationIds: string[] = [];
          const seenConversationIds = new Set<string>();
          if (path) {
            for (let pageNumber = 1; ; pageNumber += 1) {
              const page = await currentApi.listHistory(
                pageNumber,
                PROJECT_HISTORY_DELETE_PAGE_SIZE,
                { cwd: path },
              );
              for (const item of page.conversations) {
                const id = item.id.trim();
                if (!id || seenConversationIds.has(id)) continue;
                seenConversationIds.add(id);
                conversationIds.push(id);
              }

              if (
                page.conversations.length === 0 ||
                conversationIds.length >= page.total_count ||
                page.conversations.length < PROJECT_HISTORY_DELETE_PAGE_SIZE
              ) {
                break;
              }
            }
          }

          const runningConversationIdsInProject = conversationIds.filter((id) =>
            isConversationBusy(id),
          );
          if (runningConversationIdsInProject.length > 0 || projectHasRunningConversation()) {
            setHistoryError(runningMessage);
            return;
          }

          let terminalSessionsToClose: TerminalSession[] = [];
          const pruneProjectTerminalSessions = () => {
            terminalSessionsVersionRef.current += 1;
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          };
          if (
            terminalClient &&
            (settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal) &&
            pathKey
          ) {
            terminalSessionsToClose = await terminalClient.list(pathKey);
            const runningTerminalCount = terminalSessionsToClose.filter(
              (session) => session.running,
            ).length;
            if (runningTerminalCount > 0) {
              const confirmed = await requestConfirmDialog({
                title: translate("chat.workspaceRemoveConfirm", settings.locale).replace(
                  "{name}",
                  project.name,
                ),
                subtitle: translate("chat.workspaceRemoveDescription", settings.locale),
                description: (
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      <Terminal className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {translate("chat.exitConfirmRunningLabel", settings.locale)}
                        </span>
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                          {runningTerminalCount}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                        {translate("chat.workspaceRemoveTerminalDescription", settings.locale)}
                      </p>
                    </div>
                  </div>
                ),
                confirmLabel: translate("chat.workspaceRemoveConfirmContinue", settings.locale),
                cancelLabel: translate("chat.cancel", settings.locale),
                closeLabel: translate("chat.workspaceRemoveConfirmClose", settings.locale),
                tone: "warning",
              });
              if (!confirmed) {
                return;
              }
            }
          }

          const visibleConversationId = resolveVisibleConversationId(
            selectedHistoryIdRef.current,
            conversationIdRef.current,
          );
          const visibleRuntimeWorkdir =
            conversationWorkdirsRef.current.get(visibleConversationId)?.trim() || "";
          const visiblePersistedWorkdir =
            historyItemsRef.current
              .find((item) => item.id === visibleConversationId)
              ?.cwd?.trim() || "";
          const visibleWorkdir =
            visiblePersistedWorkdir ||
            visibleRuntimeWorkdir ||
            (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");

          for (const conversationId of conversationIds) {
            await currentApi.deleteHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            updateHistoryItems((current) =>
              current.filter((item) => !deletedConversationIds.has(item.id)),
            );
            const nextSharedItems = sharedHistoryItemsRef.current.filter(
              (item) => !deletedConversationIds.has(item.id),
            );
            sharedHistoryItemsRef.current = nextSharedItems;
            setSharedHistoryItems(nextSharedItems);

            for (const conversationId of deletedConversationIds) {
              optimisticTitleConversationIdsRef.current.delete(conversationId);
              unlockHistoryTitlePosition(conversationId);
              transcriptStoreRegistry.remove(conversationId);
              conversationWorkdirsRef.current.delete(conversationId);
              clearCachedComposerDraft(conversationId);
              pendingUploadsByConversationRef.current.delete(conversationId);
            }
          }
          if (terminalSessionsToClose.length > 0 && terminalClient) {
            await terminalClient.closeProject(pathKey);
            pruneProjectTerminalSessions();
          }
          if (pathKey && workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
            setRightDockOpen(false);
            if (terminalSessionsToClose.length === 0) {
              pruneProjectTerminalSessions();
            }
          }

          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(visibleWorkdir) === pathKey);

          if (path) {
            await memoryDeleteProject({
              workdir: path,
              actor: "tool",
              reason: "workspace project removed",
            });
          }
          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversation({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
          void refreshHistoryWorkdirs(currentApi);
        } catch (error) {
          setHistoryError(asErrorMessage(error, "删除项目失败"));
        } finally {
          setHistoryMutating(false);
        }
      })();
    },
    [
      activeWorkspaceProjectPath,
      activityStore,
      api,
      clearCachedComposerDraft,
      isAgentMode,
      isConversationBusy,
      refreshHistoryWorkdirs,
      removeWorkspaceProjectFromSettings,
      requestConfirmDialog,
      settings.remote.enableWebSshTerminal,
      settings.remote.enableWebTerminal,
      settings.locale,
      settings.system,
      startNewConversation,
      terminalClient,
      unlockHistoryTitlePosition,
      updateHistoryItems,
    ],
  );

  function handleSidebarNewConversation() {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setActiveView("chat");
    const visibleConversationId = getVisibleComposerConversationId();
    if (
      activeView !== "chat" &&
      (visibleConversationId === "" || isLocalDraftConversationId(visibleConversationId))
    ) {
      return;
    }
    startNewConversation({
      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    });
  }

  function handleSidebarSelectConversation(id: string) {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setActiveView("chat");

    const targetConversationId = id.trim();
    if (!targetConversationId) {
      return;
    }
    setHistorySwitchOverlay({
      conversationId: targetConversationId,
      startedAt: Date.now(),
    });

    const currentConversationId = conversationIdRef.current.trim();
    if (currentConversationId && currentConversationId !== targetConversationId) {
      cacheVisibleComposerDraft(currentConversationId);
    }

    pendingDisplayedConversationAutoBottomRef.current = targetConversationId;

    if (isLocalDraftConversationId(targetConversationId)) {
      // Local drafts have no server history to load; the transcript store is
      // already the source (optimistic entries and error entries included).
      invalidateHistoryLoad();
      markVisibleConversationRevision();
      if (currentConversationId && currentConversationId !== targetConversationId) {
        transcriptStoreRegistry.peek(currentConversationId)?.foldSettledTurns();
      }
      protectedConversationRef.current = targetConversationId;
      conversationIdRef.current = targetConversationId;
      selectedHistoryIdRef.current = targetConversationId;
      setConversationId(targetConversationId);
      setSelectedHistoryId(targetConversationId);
      setChatError(null);
      setHistoryDetailLoading(false);
      setSelectedHistory(null);
      return;
    }

    void selectHistory(targetConversationId, api, {
      scrollToBottom: true,
    });
  }

  function handleSidebarOpenSkillsHub() {
    setRightDockOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("skills-hub");
  }

  function handleSidebarOpenMcpHub() {
    setRightDockOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("mcp-hub");
  }

  function handleOpenShareModal(item: ChatHistorySummary) {
    setShareConversation(item);
    setShareStatus(null);
    setShareError(null);
    if (!api) {
      setShareError("Gateway 尚未连接，无法读取分享状态。");
      return;
    }

    setShareLoading(true);
    void api
      .getHistoryShare(item.id)
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, "读取分享状态失败"));
      })
      .finally(() => {
        setShareLoading(false);
      });
  }

  function handleCloseShareModal() {
    setShareConversation(null);
    setShareStatus(null);
    setShareError(null);
    setShareLoading(false);
    setShareUpdating(false);
  }

  function handleToggleHistoryShare(enabled: boolean, options?: { redactToolContent?: boolean }) {
    const item = shareConversation;
    if (!api || !item) {
      return;
    }

    setShareError(null);
    setShareUpdating(true);
    void api
      .setHistoryShare(item.id, enabled, options)
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, enabled ? "开启分享失败" : "关闭分享失败"));
      })
      .finally(() => {
        setShareUpdating(false);
      });
  }

  function handleSetShareRedactToolContent(redactToolContent: boolean) {
    const item = shareConversation;
    if (!api || !item) {
      return;
    }

    setShareError(null);
    setShareUpdating(true);
    void api
      .setHistoryShare(item.id, true, { redactToolContent })
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, "更新分享脱敏设置失败"));
      })
      .finally(() => {
        setShareUpdating(false);
      });
  }

  function updateSharedManagerIdSet(
    setter: (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
    id: string,
    enabled: boolean,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function setSharedManagerError(id: string, message: string | null) {
    setSharedManagerErrors((current) => {
      const next = { ...current };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });
  }

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortHistoryItems(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  const refreshSharedHistoryItems = useCallback(
    async (currentApi = api) => {
      if (!currentApi) {
        setSharedHistoryItemsState([]);
        return [];
      }
      if (sharedHistoryListRequestRef.current) {
        return sharedHistoryListRequestRef.current;
      }

      const request = (async () => {
        const byId = new Map<string, ChatHistorySummary>();
        let totalCount = 0;
        for (let pageNumber = 1; ; pageNumber += 1) {
          const response = await currentApi.listSharedHistory(
            pageNumber,
            SHARED_HISTORY_LIST_PAGE_SIZE,
          );
          totalCount = Math.max(0, response.total_count);
          for (const conversation of response.conversations) {
            const item = toChatHistorySummary(conversation, settings.selectedModel);
            byId.set(item.id, { ...item, isShared: true });
          }
          if (response.conversations.length === 0 || byId.size >= totalCount) {
            break;
          }
        }

        const nextItems = Array.from(byId.values());
        setSharedHistoryItemsState(nextItems);
        return sortHistoryItems(nextItems);
      })();

      sharedHistoryListRequestRef.current = request;
      try {
        return await request;
      } catch (error) {
        setHistoryError(asErrorMessage(error, "读取已分享历史列表失败"));
        return sharedHistoryItemsRef.current;
      } finally {
        if (sharedHistoryListRequestRef.current === request) {
          sharedHistoryListRequestRef.current = null;
        }
      }
    },
    [api, settings.selectedModel, setSharedHistoryItemsState],
  );

  useEffect(() => {
    if (!api) {
      setSharedHistoryItemsState([]);
      return;
    }
    void refreshSharedHistoryItems(api);
  }, [api, refreshSharedHistoryItems, setSharedHistoryItemsState]);

  function markSharedConversation(
    id: string,
    isShared: boolean,
    source?: ChatHistorySummary | null,
  ) {
    updateHistoryItems((current) =>
      current.map((conversation) =>
        conversation.id === id ? { ...conversation, is_shared: isShared } : conversation,
      ),
    );
    if (!isShared) {
      setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
      return;
    }

    const sourceSummary = historyItemsRef.current.find((item) => item.id === id);
    const conversation =
      source ??
      (sourceSummary ? toChatHistorySummary(sourceSummary, settings.selectedModel) : null) ??
      sharedHistoryItemsRef.current.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    setSharedHistoryItemsState([
      { ...conversation, isShared: true },
      ...sharedHistoryItemsRef.current.filter((item) => item.id !== id),
    ]);
  }

  function handleLoadSharedHistoryStatus(item: ChatHistorySummary) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法读取分享状态。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerLoadingIds, id, true);
    void api
      .getHistoryShare(id)
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "读取分享状态失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerLoadingIds, id, false);
      });
  }

  function handleRefreshSharedHistoryStatuses() {
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }

  function handleOpenSharedHistoryManager() {
    setSharedManagerOpen(true);
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }

  function handleDisableSharedHistory(item: ChatHistorySummary) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法关闭分享。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
    void api
      .setHistoryShare(id, false)
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
        if (shareConversation?.id === id) {
          setShareStatus(status);
        }
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "关闭分享失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
      });
  }

  function handleSetSharedHistoryRedactToolContent(
    item: ChatHistorySummary,
    redactToolContent: boolean,
  ) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法更新分享脱敏设置。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
    void api
      .setHistoryShare(id, true, { redactToolContent })
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
        if (shareConversation?.id === id) {
          setShareStatus(status);
        }
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "更新分享脱敏设置失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
      });
  }

  const handleResendFromEdit = useCallback(
    async (messageRef: HistoryMessageRef, text: string, uploadedFiles: PendingUploadedFile[]) => {
      const activeConversationId = conversationIdRef.current.trim();
      if (
        !api ||
        !activeConversationId ||
        isLocalDraftConversationId(activeConversationId) ||
        isConversationBusy(activeConversationId)
      ) {
        return;
      }
      const normalized = text.trim();
      if (!normalized && uploadedFiles.length === 0) {
        return;
      }

      setHistoryError(null);
      setChatError(null);
      composerRef.current?.clear();
      setPendingUploadsForConversation(activeConversationId, []);

      // Same pipeline path as a normal send, carrying the base message ref.
      // The stream's seeded `rebased` event truncates the committed
      // transcript at the edited message; the seeded `user_message` adopts
      // the optimistic echo by client_request_id.
      try {
        await sendChatRef.current?.(normalized, {
          conversationId: activeConversationId,
          uploadedFiles,
          editMessageRef: messageRef,
        });
      } catch (error) {
        setChatError(asErrorMessage(error, "编辑后重发失败"));
      }
    },
    [api, isConversationBusy, setPendingUploadsForConversation],
  );

  const handleLoadUploadedImagePreview = useCallback(
    async (workspaceRoot: string, absolutePath: string) => {
      if (!api) {
        return null;
      }
      const result = await api.readUploadedImagePreview(workspaceRoot, absolutePath);
      if (!result.data.trim()) {
        return null;
      }
      return result;
    },
    [api],
  );

  const handleComposerBusyChange = useCallback((_isBusy: boolean) => {}, []);

  function openSettings(section: SectionId = "system") {
    setSettingsSection(section);
    setSettingsOpen(true);
    setOverlay("entering");
    requestAnimationFrame(() => requestAnimationFrame(() => setOverlay("open")));
  }

  function closeSettings() {
    setOverlay("leaving");
  }

  function handleSettingsTransitionEnd() {
    if (overlay === "leaving") {
      setSettingsOpen(false);
      setOverlay("closed");
    }
  }

  const handleLogout = useCallback(() => {
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    clearSession();
    transcriptStoreRegistry.clear();
    activityStore.clear();
    draftClientRequestsRef.current.clear();
    conversationWorkdirsRef.current.clear();
    composerDraftCacheRef.current.clear();
    composerRef.current?.clear();
    conversationIdRef.current = "";
    selectedHistoryIdRef.current = "";
    selectedHistoryRef.current = null;
    historyItemsRef.current = [];
    historyTotalRef.current = 0;
    historyHasMoreRef.current = false;
    nextHistoryPageRef.current = 1;
    historyListPageLoadingRef.current = false;
    sharedHistoryItemsRef.current = [];
    sharedHistoryListRequestRef.current = null;
    clearPendingUploads();
    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = "";
    submitInFlightRef.current = false;
    setUserMenuOpen(false);
    setSettingsOpen(false);
    setOverlay("closed");
    setHistorySwitchOverlay(null);
    setStatus(null);
    setStatusError(null);
    setConversationId("");
    setChatError(null);
    optimisticTitleConversationIdsRef.current.clear();
    clearHistoryTitlePositionLocks();
    historyItemsRef.current = [];
    setHistoryItems([]);
    setSharedHistoryItems([]);
    setHistoryTotal(0);
    setHistoryHasMore(false);
    setHistoryError(null);
    setHistoryListLoading(false);
    setHistoryListLoadingMore(false);
    setHistoryDetailLoading(false);
    setHistoryMutating(false);
    queuedChatTurnsRef.current = [];
    chatQueueConversationIdRef.current = "";
    chatQueueRevisionRef.current = 0;
    queuedChatEditSessionRef.current = null;
    setQueuedChatTurns([]);
    setChatQueueRevision(0);
    setProjectActivityUpdatedAtOverrides(new Map());
    resetProjectToolsRuntimeRef.current();
    setSelectedHistoryId("");
    setSelectedHistory(null);
    setRenamingId(null);
    setRenameDraft("");
  }, [
    activityStore,
    clearHistoryTitlePositionLocks,
    clearPendingUploads,
    clearSession,
    invalidateHistoryLoad,
    markVisibleConversationRevision,
    transcriptStoreRegistry,
  ]);

  const userMenuLabel = (status?.agent_id || "当前用户").trim() || "当前用户";
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();

  const localeContextValue = useMemo(
    () => ({
      locale: settings.locale,
      t: (key: string) => translate(key, settings.locale),
    }),
    [settings.locale],
  );

  const activeProviders = useMemo<ModelProviderSource[]>(
    // WebUI provider config should follow the synced settings payload directly.
    // Using a separately fetched provider summary here can leave the model list stale
    // after Settings has already synced in either direction.
    () => settings.customProviders,
    [settings.customProviders],
  );

  const currentModelLabel = useMemo(() => {
    if (!settings.selectedModel) {
      return "选择模型";
    }
    const provider = activeProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    return provider
      ? `${provider.name} / ${settings.selectedModel.model}`
      : settings.selectedModel.model;
  }, [activeProviders, settings.selectedModel]);
  const currentModelContextWindow = useMemo(() => {
    if (!settings.selectedModel) {
      return undefined;
    }
    const provider = settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    if (!provider) {
      return undefined;
    }
    return findProviderModelConfig(provider, settings.selectedModel.model).contextWindow;
  }, [settings.customProviders, settings.selectedModel]);
  const currentChatProvider = useMemo(() => {
    if (!settings.selectedModel) {
      return undefined;
    }
    return settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
  }, [settings.customProviders, settings.selectedModel]);
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type, settings.chatRuntimeControls],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(prev.chatRuntimeControls, patch, {
          providerId: currentChatProvider?.type,
          requestFormat: currentChatProvider?.requestFormat,
        }),
      }));
    },
    [currentChatProvider?.requestFormat, currentChatProvider?.type, setSettings],
  );
  const isAgentDevExecutionMode = isAgentDevMode(settings.system.executionMode);

  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  const selectedValue = settings.selectedModel
    ? toModelValue(settings.selectedModel.customProviderId, settings.selectedModel.model)
    : undefined;

  const skillsEnabled = settings.skills.enabled && isAgentMode;
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? mergeAlwaysEnabledSkillNames(settings.skills.selected) : []),
    [skillsEnabled, settings.skills.selected],
  );
  const { availableSkills, skillsRootDir } = useChatSkills({
    skillsEnabled,
    selectedSkillNames,
    setSettings,
  });
  const enabledComposerSkills = useMemo(() => {
    if (!skillsEnabled || selectedSkillNames.length === 0 || availableSkills.length === 0) {
      return [];
    }
    const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
    return selectedSkillNames
      .map((name) => byName.get(name))
      .filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill));
  }, [availableSkills, selectedSkillNames, skillsEnabled]);

  const sidebarItems = useMemo<ChatHistorySummary[]>(
    () => historyItems.map((item) => toChatHistorySummary(item, settings.selectedModel)),
    [historyItems, settings.selectedModel],
  );
  const canShareHistory = Boolean(
    api &&
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() &&
      settings.remote.token.trim(),
  );
  // Sidebar running dots come from the activity store only.
  const sidebarRunningConversationIds = useMemo(() => {
    return new Set(activitySnapshot.activities.keys());
  }, [activitySnapshot]);
  const runningProjectPathKeys = useMemo(() => {
    const next = new Set<string>();
    for (const [conversationIdValue, activity] of activitySnapshot.activities) {
      const conversationId = conversationIdValue.trim();
      if (!conversationId) {
        continue;
      }

      const activityWorkdir = activity.workdir?.trim() || "";
      const runtimeWorkdir = conversationWorkdirsRef.current.get(conversationId)?.trim() || "";
      const persistedWorkdir =
        historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
      const resolvedWorkdir = activityWorkdir || runtimeWorkdir || persistedWorkdir;
      if (resolvedWorkdir) {
        next.add(workspaceProjectPathKey(resolvedWorkdir));
      }
    }
    return next;
  }, [activitySnapshot, historyItems]);

  const projectActivityUpdatedAts = useMemo(() => {
    const updatedAts = buildWorkspaceProjectActivityUpdatedAts([
      ...historyWorkdirs,
      ...Array.from(activitySnapshot.activities.entries()).map(([conversationId, activity]) => {
        const activityWorkdir = activity.workdir?.trim() || "";
        const runtimeWorkdir = conversationWorkdirsRef.current.get(conversationId)?.trim() || "";
        const persistedWorkdir =
          historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
        return {
          cwd: activityWorkdir || runtimeWorkdir || persistedWorkdir,
          updatedAt: activity.updatedAt > 0 ? activity.updatedAt : Date.now(),
        };
      }),
    ]);
    for (const [pathKey, updatedAt] of projectActivityUpdatedAtOverrides) {
      if (updatedAt > (updatedAts.get(pathKey) ?? 0)) {
        updatedAts.set(pathKey, updatedAt);
      }
    }
    return updatedAts;
  }, [activitySnapshot, historyItems, historyWorkdirs, projectActivityUpdatedAtOverrides]);
  const currentConversationPersistedCwd =
    historyItems.find((item) => item.id === displayedConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");
  displayedConversationWorkdirRef.current = displayedConversationWorkdir;
  useEffect(() => {
    if (!api || !displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      return;
    }
    if (chatQueueConversationIdRef.current !== displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = displayedConversationId;
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
    }
    let cancelled = false;
    void api
      .chatQueueGet(displayedConversationId)
      .then((response) => {
        if (!cancelled) applyChatQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, applyChatQueueSnapshot, displayedConversationId]);
  const queuedChatTurnsForDisplayedConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      })),
    [displayedConversationId, queuedChatTurns],
  );
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  // getRightDockProjectState / getRightDockFileTreeState / getSshProjectHostIds
  // build fresh objects on every call, so memoize on the owning settings slice
  // + path key: RightDockPanel is memo'd and these references are props.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on settings.customSettings.rightDock (the only slice these getters read) so unrelated settings changes keep the reference stable.
  const rightDockProjectState = useMemo(
    () => getRightDockProjectState(settings.customSettings, terminalProjectPathKey),
    [settings.customSettings.rightDock, terminalProjectPathKey],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on settings.customSettings.rightDock (the only slice these getters read) so unrelated settings changes keep the reference stable.
  const rightDockFileTreeState = useMemo(
    () => getRightDockFileTreeState(settings.customSettings, terminalProjectPathKey),
    [settings.customSettings.rightDock, terminalProjectPathKey],
  );
  const rightDockFileTreeOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "fileTree",
  );
  const rightDockTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "tunnel",
  );
  const rightDockSshTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "sshTunnel",
  );
  const associatedSshHostIds = useMemo(
    () => getSshProjectHostIds(settings.ssh, terminalProjectPathKey),
    [settings.ssh, terminalProjectPathKey],
  );
  const projectToolsDisabledMessage = !settingsSyncReady
    ? "Syncing desktop settings..."
    : !isAgentMode
      ? "Project tools require Agent project mode."
      : !terminalProjectPath
        ? "Select a project to use project tools."
        : undefined;
  const terminalDisabledMessage =
    projectToolsDisabledMessage ??
    (!settings.remote.enableWebTerminal
      ? "Enable WebUI Terminal in desktop Remote settings."
      : undefined);
  const webTerminalSessionsEnabled =
    settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal;
  const {
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorCleanupPending,
    workspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
    terminalSessions,
    terminalSessionsLoaded,
    setTerminalSessions,
    terminalSessionsVersionRef,
    terminalStatusSessionIdRef,
    projectTerminalSessions,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    handleWorkspaceEditorHide,
    handleWorkspaceEditorClosed,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    handleProjectTerminalSessionsChange,
    resetTerminalSessions,
    hideWorkspaceSshTerminalOverlay,
  } = useProjectToolsRuntime({
    terminalClient,
    settingsSyncReady,
    isAgentMode,
    webTerminalSessionsEnabled,
    statusOnline: status?.online,
    statusSessionId: status?.session_id,
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
    rightDockSshTunnelOpen,
  });
  resetProjectToolsRuntimeRef.current = resetTerminalSessions;
  const gitDisabledMessage = !settings.remote.enableWebGit
    ? "WebUI Git is disabled in desktop Remote settings."
    : undefined;
  // Agent offline no longer disables the panel: state still renders (the
  // Link badge shows offline) and mutations fail server-side with a clear
  // message.
  const tunnelEnabled = settingsSyncReady && settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settingsSyncReady
    ? translate("chat.runtime.tunnelSettingsSyncing", settings.locale)
    : !settings.remote.enableWebTunnels
      ? translate("projectTools.tunnelWebDisabled", settings.locale)
      : undefined;
  const workspaceActivityClient = useMemo(
    () => (api ? createGatewayWorkspaceActivityClient(api) : null),
    [api],
  );
  // RightDockPanel is memo'd: every callback handed to it must be stable or
  // the memo boundary is void (see the panel-side context useMemo).
  const handleRightDockWidthChange = useCallback(
    (nextWidth: number) => {
      setSettings((prev) => updateRightDockWidth(prev, nextWidth));
    },
    [setSettings],
  );
  const handleRightDockProjectStateChange = useCallback(
    (updater: (current: RightDockProjectState) => RightDockProjectState) => {
      setSettings((prev) => updateRightDockProjectState(prev, terminalProjectPathKey, updater));
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleRightDockFileTreeStateChange = useCallback(
    (patch: RightDockFileTreeStatePatch) => {
      setSettings((prev) => updateRightDockFileTreeState(prev, terminalProjectPathKey, patch));
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleSshProjectHostIdsChange = useCallback(
    (hostIds: string[]) => {
      setSettings((prev) => updateSshProjectHostIds(prev, terminalProjectPathKey, hostIds));
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleRightDockInsertFileMention = useCallback((path: string, kind: "file" | "dir") => {
    composerRef.current?.insertFileMention(path, kind);
    composerRef.current?.focus();
  }, []);
  const handleRightDockInsertCommitMention = useCallback((commit: GitCommitContextPayload) => {
    composerRef.current?.insertCommitMention(commit);
    composerRef.current?.focus();
  }, []);
  const handleRightDockInsertGitFileMention = useCallback((file: GitFileContextPayload) => {
    composerRef.current?.insertGitFileMention(file);
    composerRef.current?.focus();
  }, []);
  const handleRightDockClose = useCallback(() => {
    setRightDockOpen(false);
  }, []);
  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const cachedDraft = composerDraftCacheRef.current.get(targetConversationId);
      const composer = composerRef.current;
      if (!cachedDraft || !composer || composer.hasContent()) {
        return;
      }
      composer.setDraft(cachedDraft);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, displayedConversationId]);

  const displayedConversationSummary = useMemo(() => {
    const displayedId = displayedConversationId.trim();
    if (!displayedId || isLocalDraftConversationId(displayedId)) {
      return null;
    }
    return pickConversationSummary(historyItems, displayedId);
  }, [displayedConversationId, historyItems]);
  const activeProjectBrowserTitle = isAgentMode ? (activeWorkspaceProject?.name.trim() ?? "") : "";
  const displayedConversationTitle = useMemo(
    () =>
      resolveConversationBrowserTitle({
        conversation: displayedConversationSummary,
        conversationId: displayedConversationId,
        projectName: activeProjectBrowserTitle,
        isLocalDraftConversation: isLocalDraftConversationId(displayedConversationId),
        newConversationTitle: NEW_CONVERSATION_BROWSER_TITLE,
      }),
    [activeProjectBrowserTitle, displayedConversationId, displayedConversationSummary],
  );
  const browserTitle = useMemo(() => {
    if (historyShareToken) {
      return SHARED_HISTORY_BROWSER_TITLE;
    }
    if (!token.trim()) {
      return DEFAULT_BROWSER_TITLE;
    }
    if (activeView === "skills-hub") {
      return SKILLS_HUB_BROWSER_TITLE;
    }
    if (activeView === "mcp-hub") {
      return MCP_HUB_BROWSER_TITLE;
    }
    return displayedConversationTitle || DEFAULT_BROWSER_TITLE;
  }, [activeView, displayedConversationTitle, historyShareToken, token]);
  const historyDetailLoadingTitle = useMemo(() => {
    const selectedId = selectedHistoryId.trim();
    if (!selectedId) {
      return "";
    }
    const item = historyItems.find((candidate) => candidate.id === selectedId);
    return item ? resolveConversationTitle(item, item.id) : "";
  }, [historyItems, selectedHistoryId]);
  const transcriptFoldedRows = displayedTranscript.foldedRows;
  const transcriptLiveRows = displayedTranscript.liveRows;
  // Row count gates everything visual (empty state, error banner, loading
  // screen): entryCount can be non-zero while nothing renders (meta-only
  // entries), and hiding an error behind an invisible entry would strand it.
  const displayedTranscriptRowCount = transcriptFoldedRows.length + transcriptLiveRows.length;
  const transcriptHistoryLoading = historyDetailLoading && displayedTranscriptRowCount === 0;
  const selectedHistoryHasMore =
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistory.has_more === true;
  const loadingOlderHistory =
    historyDetailLoading &&
    selectedHistory?.conversation_id === displayedConversationId &&
    displayedTranscriptRowCount > 0;
  const handleLoadFullHistory = useCallback(() => {
    if (!api || !displayedConversationId) {
      return;
    }
    void selectHistory(displayedConversationId, api, {
      fullHistory: true,
    });
  }, [api, displayedConversationId]);
  const transcriptHasLiveRows = transcriptLiveRows.length > 0;
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.title = browserTitle;
  }, [browserTitle]);
  const transcriptBusy = displayedConversationBusy;
  // Pipeline pending (pre-first-token) shows the preparing status until the
  // stream's own tool_status takes over.
  const displayedHasPendingCommand =
    displayedConversationId !== "" && chatCommandPipeline.hasPending(displayedConversationId);
  const transcriptToolStatus =
    displayedTranscript.toolStatus ??
    (displayedHasPendingCommand ? CHAT_RUNTIME_PREPARING_STATUS : null);
  const transcriptToolStatusIsCompaction = displayedTranscript.toolStatusIsCompaction;
  const composerIsSending = transcriptBusy;
  const transcriptError = displayedTranscriptRowCount === 0 ? null : chatError;
  const composerCompactionBlocked = transcriptToolStatusIsCompaction;
  const composerInputDisabled =
    !status?.online || historyDetailLoading || composerCompactionBlocked;
  const composerPlaceholder = composerCompactionBlocked
    ? translate("chat.compactingContextWait", settings.locale)
    : historyDetailLoading
      ? "正在加载会话历史，请稍候..."
      : enabledComposerSkills.length > 0
        ? translate("chat.inputHintWithSkills", settings.locale)
        : translate("chat.inputHint", settings.locale);
  const canDropUpload =
    status?.online === true &&
    isAgentMode &&
    Boolean(displayedConversationWorkdir.trim()) &&
    !isUploadingFiles &&
    !composerInputDisabled;
  const fileDropTitle = canDropUpload
    ? translate("chat.upload.dropReady", settings.locale)
    : status?.online !== true
      ? translate("chat.upload.dropBusy", settings.locale)
      : !isAgentMode
        ? translate("chat.upload.onlyInTools", settings.locale)
        : !displayedConversationWorkdir.trim()
          ? translate("chat.upload.requireWorkdir", settings.locale)
          : translate("chat.upload.dropBusy", settings.locale);
  const fileDropDescription = canDropUpload
    ? translate("chat.upload.dropHint", settings.locale)
    : translate("chat.upload.dropDisabledHint", settings.locale);
  const fileDropLimitHint = formatTranslation(translate("chat.upload.dropLimit", settings.locale), {
    max: MAX_UPLOAD_FILES,
  });

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handlePendingFileDragOver(event, canDropUpload);
    },
    [canDropUpload, handlePendingFileDragOver],
  );

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handlePendingFileDrop(event, {
        canDropUpload,
        disabledMessage: fileDropTitle,
      });
    },
    [canDropUpload, fileDropTitle, handlePendingFileDrop],
  );

  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    const previousDisplayedConversationId = previousDisplayedConversationIdRef.current.trim();
    previousDisplayedConversationIdRef.current = nextDisplayedConversationId;
    if (
      !nextDisplayedConversationId ||
      !previousDisplayedConversationId ||
      previousDisplayedConversationId === nextDisplayedConversationId
    ) {
      return;
    }
    // Switching away folds the settled turns so revisits start clean.
    transcriptStoreRegistry.peek(previousDisplayedConversationId)?.foldSettledTurns();
    pendingDisplayedConversationAutoBottomRef.current = nextDisplayedConversationId;
  }, [displayedConversationId, transcriptStoreRegistry]);

  useLayoutEffect(() => {
    const targetConversationId = pendingDisplayedConversationAutoBottomRef.current?.trim() ?? "";
    if (
      !targetConversationId ||
      historyDetailLoading ||
      displayedConversationId.trim() !== targetConversationId ||
      displayedTranscriptRowCount === 0
    ) {
      return;
    }

    stickTranscriptToBottom();
    refreshTranscriptScrollState();
    pendingDisplayedConversationAutoBottomRef.current = null;
  }, [
    displayedConversationId,
    displayedTranscriptRowCount,
    historyDetailLoading,
    refreshTranscriptScrollState,
    stickTranscriptToBottom,
  ]);

  useEffect(() => {
    if (!historySwitchOverlay) {
      return;
    }

    const targetConversationId = historySwitchOverlay.conversationId;
    const currentDisplayedConversationId = displayedConversationId.trim();
    const currentSelectedHistoryId = selectedHistoryId.trim();
    const isTargetVisible = currentDisplayedConversationId === targetConversationId;
    const isTargetSelected = isTargetVisible || currentSelectedHistoryId === targetConversationId;

    if (historyDetailLoading && isTargetSelected) {
      return;
    }

    let firstRafId: number | null = null;
    let secondRafId: number | null = null;
    const elapsed = Date.now() - historySwitchOverlay.startedAt;
    const delayMs = Math.max(0, HISTORY_SWITCH_OVERLAY_MIN_MS - elapsed);
    const timeoutId = window.setTimeout(() => {
      firstRafId = requestAnimationFrame(() => {
        if (isTargetVisible) {
          stickTranscriptToBottom();
        }
        secondRafId = requestAnimationFrame(() => {
          if (isTargetVisible) {
            stickTranscriptToBottom();
            refreshTranscriptScrollState();
          }
          setHistorySwitchOverlay((current) =>
            current?.conversationId === targetConversationId ? null : current,
          );
        });
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
      if (firstRafId !== null) {
        cancelAnimationFrame(firstRafId);
      }
      if (secondRafId !== null) {
        cancelAnimationFrame(secondRafId);
      }
    };
  }, [
    displayedConversationId,
    historyDetailLoading,
    historySwitchOverlay,
    refreshTranscriptScrollState,
    selectedHistoryId,
    stickTranscriptToBottom,
  ]);

  useLayoutEffect(() => {
    if (transcriptBusy || transcriptHasLiveRows) {
      syncTranscriptAutoScroll();
    }
    refreshTranscriptScrollState();
  }, [
    chatError,
    refreshTranscriptScrollState,
    syncTranscriptAutoScroll,
    transcriptBusy,
    transcriptHasLiveRows,
    transcriptFoldedRows,
    transcriptLiveRows,
    transcriptToolStatus,
  ]);

  if (historyShareToken) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SharedHistoryPage token={historyShareToken} />
      </LocaleContext.Provider>
    );
  }

  if (!token) {
    return (
      <LoginPage
        token={loginToken}
        error={authError}
        isSubmitting={authSubmitting}
        onTokenChange={(nextToken) => {
          setLoginToken(nextToken);
          if (authError) {
            setAuthError(null);
          }
        }}
        onSubmit={handleLoginSubmit}
      />
    );
  }

  if (!api) {
    return null;
  }

  if (!settingsSyncReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <div className="gateway-shell">
          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            <div className="gateway-chat-frame flex items-center justify-center">
              <SettingsSyncLoading locale={settings.locale} />
            </div>
          </main>
        </div>
      </LocaleContext.Provider>
    );
  }

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <div className="gateway-shell">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="gateway-hidden-file-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            void handleImportReadableFiles(files);
            event.currentTarget.value = "";
          }}
        />

        <div className="gateway-editor-host">
          <ChatHistorySidebar
            items={sidebarItems}
            currentConversationId={displayedConversationId}
            isBusy={historyDetailLoading || historyMutating}
            runningConversationIds={sidebarRunningConversationIds}
            isLoading={historyListLoading && sidebarItems.length === 0}
            totalItems={historyTotal}
            hasMore={historyHasMore}
            isLoadingMore={historyListLoadingMore}
            errorMessage={historyError}
            renamingId={renamingId}
            renameDraft={renameDraft}
            isOpen={sidebarOpen}
            activeView={activeView}
            showProjects={isAgentMode}
            projects={workspaceProjects}
            activeProjectId={activeWorkspaceProject?.id}
            missingProjectPathKeys={missingWorkspaceProjectPathKeys}
            runningProjectPathKeys={runningProjectPathKeys}
            projectActivityUpdatedAts={projectActivityUpdatedAts}
            projectRenamingId={projectRenamingId}
            projectRenameDraft={projectRenameDraft}
            projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
            recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
            onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
            onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
            onCreateProject={handleOpenCreateWorkspaceProject}
            onSelectProject={handleSelectWorkspaceProject}
            onNewConversationForProject={handleNewConversationForProject}
            onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
            onStartRenamingProject={handleStartRenamingWorkspaceProject}
            onProjectRenameDraftChange={setProjectRenameDraft}
            onCommitProjectRename={handleCommitWorkspaceProjectRename}
            onCancelProjectRename={handleCancelWorkspaceProjectRename}
            onSetProjectPinned={handleSetWorkspaceProjectPinned}
            onRemoveProject={handleRemoveWorkspaceProject}
            onNewConversation={handleSidebarNewConversation}
            onSelectConversation={handleSidebarSelectConversation}
            onStartRenaming={(item) => {
              setRenamingId(item.id);
              setRenameDraft(item.title);
            }}
            onRenameDraftChange={setRenameDraft}
            onCommitRename={() => {
              if (!renamingId) {
                return;
              }
              const conversationIdValue = renamingId;
              const title = renameDraft.trim();
              setHistoryError(null);
              void (async () => {
                if (!title) {
                  setRenamingId(null);
                  setRenameDraft("");
                  return;
                }
                setHistoryMutating(true);
                try {
                  const summary = await api.renameHistory(conversationIdValue, title);
                  optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
                  unlockHistoryTitlePosition(conversationIdValue);
                  updateHistoryItems((current) => upsertConversationSummary(current, summary));
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "修改历史对话标题失败"));
                } finally {
                  setHistoryMutating(false);
                  setRenamingId(null);
                  setRenameDraft("");
                }
              })();
            }}
            onCancelRename={() => {
              setRenamingId(null);
              setRenameDraft("");
            }}
            onSetPinned={(id, isPinned) => {
              setHistoryError(null);
              void (async () => {
                setHistoryMutating(true);
                try {
                  const summary = await api.pinHistory(id, isPinned);
                  updateHistoryItems((current) => upsertConversationSummary(current, summary));
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "更新历史对话置顶状态失败"));
                } finally {
                  setHistoryMutating(false);
                }
              })();
            }}
            canShareConversations={canShareHistory}
            sharedConversationCount={sharedHistoryItems.length}
            onShareConversation={handleOpenShareModal}
            onOpenSharedConversations={handleOpenSharedHistoryManager}
            onDeleteConversation={(id) => {
              setHistoryError(null);
              if (sidebarRunningConversationIds.has(id)) {
                setHistoryError("后台任务仍在运行，暂时不能删除该对话。");
                return;
              }
              if (isLocalDraftConversationId(id)) {
                optimisticTitleConversationIdsRef.current.delete(id);
                unlockHistoryTitlePosition(id);
                updateHistoryItems((current) => current.filter((item) => item.id !== id));
                if (conversationIdRef.current === id || selectedHistoryIdRef.current === id) {
                  startNewConversation({
                    workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
                  });
                }
                return;
              }
              void (async () => {
                setHistoryMutating(true);
                try {
                  await api.deleteHistory(id);
                  optimisticTitleConversationIdsRef.current.delete(id);
                  unlockHistoryTitlePosition(id);
                  updateHistoryItems((current) => current.filter((item) => item.id !== id));
                  setSharedHistoryItemsState(
                    sharedHistoryItemsRef.current.filter((item) => item.id !== id),
                  );
                  if (conversationIdRef.current === id || selectedHistoryIdRef.current === id) {
                    startNewConversation({
                      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
                    });
                  }
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "删除历史对话失败"));
                } finally {
                  setHistoryMutating(false);
                }
              })();
            }}
            onLoadMore={loadMoreHistory}
            onCloseSidebar={() => setSidebarOpen(false)}
            onOpenSkillsHub={handleSidebarOpenSkillsHub}
            onOpenMcpHub={handleSidebarOpenMcpHub}
          />

          {shareConversation ? (
            <HistoryShareModal
              conversation={shareConversation}
              share={shareStatus}
              isLoading={shareLoading}
              isUpdating={shareUpdating}
              errorMessage={shareError}
              onToggle={handleToggleHistoryShare}
              onRedactToolContentChange={handleSetShareRedactToolContent}
              onClose={handleCloseShareModal}
            />
          ) : null}

          {sharedManagerOpen ? (
            <SharedHistoryManagerModal
              conversations={sharedHistoryItems}
              statuses={sharedManagerStatuses}
              loadingIds={sharedManagerLoadingIds}
              updatingIds={sharedManagerUpdatingIds}
              errors={sharedManagerErrors}
              shareOrigin={settings.remote.gatewayUrl}
              onRefresh={handleRefreshSharedHistoryStatuses}
              onLoadStatus={handleLoadSharedHistoryStatus}
              onDisableShare={handleDisableSharedHistory}
              onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
              onClose={() => setSharedManagerOpen(false)}
            />
          ) : null}

          {projectPickerOpen ? (
            <WorkdirPickerModal
              initialWorkdir={activeWorkspaceProjectPath || settings.system.workdir.trim()}
              onClose={() => setProjectPickerOpen(false)}
              onSelect={handleWorkdirPickerSelect}
            />
          ) : null}

          {confirmDialog}

          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            {activeView === "skills-hub" ? (
              <SkillsHubPage
                settings={settings}
                setSettings={setSettings}
                initialSkills={availableSkills}
                initialRootDir={skillsRootDir}
                isAgentMode={isAgentMode}
                sidebarOpen={sidebarOpen}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            ) : activeView === "mcp-hub" ? (
              <McpHubPage
                settings={settings}
                setSettings={setSettings}
                isAgentMode={isAgentMode}
                sidebarOpen={sidebarOpen}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            ) : (
              <div
                className="gateway-chat-frame"
                onDragEnter={handleFileDragEnter}
                onDragOver={handleFileDragOver}
                onDragLeave={handleFileDragLeave}
                onDrop={handleFileDrop}
              >
                <ChatHeader
                  settings={settings}
                  hasModels={modelOptions.length > 0}
                  currentModelLabel={currentModelLabel}
                  modelOptions={modelOptions}
                  selectedValue={selectedValue}
                  sidebarOpen={sidebarOpen}
                  setSettings={setSettings}
                  onOpenSettings={openSettings}
                  onToggleTheme={() =>
                    setSettings((prev) => ({
                      ...prev,
                      theme: getNextTheme(prev.theme),
                    }))
                  }
                  onOpenSidebar={() => setSidebarOpen(true)}
                  preThemeActions={
                    <span
                      className={`gateway-online-pill${status?.online ? " gateway-online-pill-active" : ""}`}
                      title={status?.online ? "Online" : "Offline"}
                      aria-label={status?.online ? "Online" : "Offline"}
                    >
                      {status?.online ? "Online" : "Offline"}
                    </span>
                  }
                  trailingActions={
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setRightDockOpen((open) => !open)}
                        disabled={Boolean(projectToolsDisabledMessage) && !rightDockOpen}
                        aria-expanded={rightDockOpen}
                        title={
                          rightDockOpen
                            ? "Collapse project tools panel"
                            : (projectToolsDisabledMessage ?? "Expand project tools panel")
                        }
                        className={`gateway-project-tools-panel-toggle relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95 ${
                          rightDockOpen ? "bg-muted text-foreground" : ""
                        }`}
                      >
                        {rightDockOpen ? (
                          <PanelRightClose className="h-4.5 w-4.5" />
                        ) : (
                          <PanelRightOpen className="h-4.5 w-4.5" />
                        )}
                        {projectTerminalSessions.length > 0 ? (
                          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold leading-none text-white">
                            {projectTerminalSessions.length}
                          </span>
                        ) : null}
                      </Button>
                      <UserMenu
                        open={userMenuOpen}
                        onOpenChange={setUserMenuOpen}
                        userMenuLabel={userMenuLabel}
                        userAvatarLabel={userAvatarLabel}
                        sessionId={status?.session_id}
                        onLogout={handleLogout}
                      />
                    </>
                  }
                />

                {statusError ? <div className="gateway-banner-error">{statusError}</div> : null}
                {settingsSyncError ? (
                  <div className="gateway-banner-error">{settingsSyncError}</div>
                ) : null}
                {chatError && displayedTranscriptRowCount === 0 ? (
                  <div className="gateway-banner-error">{chatError}</div>
                ) : null}

                <section className="gateway-transcript-stage">
                  <div className="gateway-transcript-scroll-shell">
                    <ScrollArea ref={transcriptScrollAreaRef} className="gateway-transcript-scroll">
                      <GatewayTranscript
                        conversationId={displayedConversationId}
                        foldedRows={transcriptFoldedRows}
                        liveRows={transcriptLiveRows}
                        activeTurnKey={displayedTranscript.activeTurnKey}
                        error={transcriptError}
                        toolStatus={transcriptToolStatus}
                        toolStatusIsCompaction={transcriptToolStatusIsCompaction}
                        isStreaming={transcriptBusy}
                        isLoading={transcriptHistoryLoading}
                        loadingTitle={historyDetailLoadingTitle}
                        hasModels={modelOptions.length > 0}
                        onOpenSettings={openSettings}
                        hasMoreHistory={selectedHistoryHasMore}
                        isLoadingMoreHistory={loadingOlderHistory}
                        onLoadFullHistory={
                          selectedHistoryHasMore ? handleLoadFullHistory : undefined
                        }
                        isAgentMode={isAgentMode}
                        showUsage={isAgentDevExecutionMode}
                        usageContextWindow={currentModelContextWindow}
                        workspaceRoot={displayedConversationWorkdir}
                        gitClient={gitClient}
                        onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                        onResendFromEdit={handleResendFromEdit}
                      />
                    </ScrollArea>
                    {historySwitchOverlay ? (
                      <HistorySwitchLoadingOverlay locale={settings.locale} />
                    ) : null}
                  </div>
                  {showTranscriptJumpToBottom ? (
                    <button
                      type="button"
                      className="gateway-scroll-to-bottom"
                      onClick={jumpTranscriptToBottom}
                      aria-label="滚动到底部"
                      title="滚动到底部"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  ) : null}
                  <ChatComposerBar
                    composerRef={composerRef}
                    isSending={composerIsSending}
                    isUploadingFiles={isUploadingFiles}
                    isInputDisabled={composerInputDisabled}
                    inputPlaceholder={composerPlaceholder}
                    workdir={displayedConversationWorkdir}
                    enabledSkills={enabledComposerSkills}
                    isAgentMode={isAgentMode}
                    chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                    reasoningOptions={chatRuntimeReasoningOptions}
                    gitClient={gitClient}
                    gitWriteEnabled={settings.remote.enableWebGit}
                    gitDisabledMessage={gitDisabledMessage}
                    workspaceActivityClient={workspaceActivityClient}
                    onSend={() => {
                      if (
                        submitInFlightRef.current ||
                        isUploadingFiles ||
                        isImportingPastedTextRef.current ||
                        composerInputDisabled
                      ) {
                        return;
                      }
                      if (queuedChatEditSessionRef.current) {
                        submitInFlightRef.current = true;
                        void (async () => {
                          try {
                            await commitQueuedChatEdit();
                          } finally {
                            submitInFlightRef.current = false;
                          }
                        })();
                        return;
                      }
                      if (
                        displayedConversationBusyRef.current ||
                        queuedChatTurnsForDisplayedConversation.length > 0
                      ) {
                        submitInFlightRef.current = true;
                        void (async () => {
                          try {
                            await submitCurrentComposerToGuiQueue("append");
                          } finally {
                            submitInFlightRef.current = false;
                          }
                        })();
                        return;
                      }
                      submitInFlightRef.current = true;
                      void (async () => {
                        try {
                          const draft = composerRef.current?.getDraft() ?? null;
                          let text = draft
                            ? (isAgentMode && draft.largePastes.length > 0
                                ? draft.textWithoutLargePastes
                                : buildTextFromComposerDraft(draft)
                              ).trim()
                            : "";
                          let files = pendingUploadedFiles;

                          if (isAgentMode && draft && draft.largePastes.length > 0) {
                            setChatError(null);
                            isImportingPastedTextRef.current = true;
                            setIsUploadingFiles(true);
                            try {
                              const imported = await importPastedTextsAsFiles({
                                token,
                                workdir: displayedConversationWorkdir,
                                pastes: draft.largePastes,
                              });
                              text = buildTextFromComposerDraft(
                                draft,
                                imported.fileByPasteId,
                              ).trim();
                              files = mergePendingUploadedFiles(files, imported.files);
                            } catch (error) {
                              setChatError(asErrorMessage(error, "大段粘贴内容导入失败"));
                              return;
                            } finally {
                              isImportingPastedTextRef.current = false;
                              setIsUploadingFiles(false);
                            }
                          }

                          if (!text && files.length === 0) {
                            return;
                          }
                          const uploadConversationId = getDisplayedConversationId();
                          composerRef.current?.clear();
                          setPendingUploadsForConversation(uploadConversationId, []);
                          void sendChat(text, {
                            uploadedFiles: files,
                            runtimeControls: chatRuntimeControlsForCurrentProvider,
                          }).catch(() => {
                            updatePendingUploadsForConversation(uploadConversationId, (current) =>
                              mergePendingUploadedFiles(current, files),
                            );
                          });
                        } finally {
                          submitInFlightRef.current = false;
                        }
                      })();
                    }}
                    onStop={() => {
                      void cancelChat(displayedConversationId);
                    }}
                    onPrepareChatRuntime={() => {
                      if (!api || historyShareToken) {
                        return;
                      }
                      void prepareChatRuntime(
                        "composer-focus",
                        api,
                        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
                      ).catch(() => undefined);
                    }}
                    onComposerBusyChange={handleComposerBusyChange}
                    onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                    onPickReadableFiles={() => fileInputRef.current?.click()}
                    onPasteFiles={handleImportReadableFiles}
                    pendingUploadedFiles={pendingUploadedFiles}
                    onRemovePendingUpload={(relativePath) => {
                      updatePendingUploadsForConversation(getDisplayedConversationId(), (current) =>
                        current.filter((file) => file.relativePath !== relativePath),
                      );
                    }}
                    queuedTurns={queuedChatTurnsForDisplayedConversation}
                    onRunQueuedTurnNow={runQueuedTurnNow}
                    onMoveQueuedTurnUp={moveQueuedTurnUp}
                    onEditQueuedTurn={editQueuedTurn}
                    onRemoveQueuedTurn={removeQueuedTurn}
                  />
                  {isFileDropActive ? (
                    <FileDropOverlay
                      canDropUpload={canDropUpload}
                      title={fileDropTitle}
                      description={fileDropDescription}
                      limitHint={fileDropLimitHint}
                    />
                  ) : null}
                </section>
              </div>
            )}
          </main>
          <WorkspaceOverlayHost
            locale={settings.locale}
            theme={effectiveTheme}
            workspaceEditorMounted={workspaceEditorMounted}
            workspaceEditorOpenRequest={workspaceEditorOpenRequest}
            workspaceEditorCloseRequestId={workspaceEditorCloseRequestId}
            workspaceEditorOpen={workspaceEditorOpen}
            workspaceEditorCleanupPending={workspaceEditorCleanupPending}
            onWorkspaceEditorPreviewFile={openWorkspaceFilePreview}
            onWorkspaceEditorHide={handleWorkspaceEditorHide}
            onWorkspaceEditorClose={handleWorkspaceEditorClosed}
            workspaceFilePreviewMounted={workspaceFilePreviewMounted}
            workspaceFilePreviewOpenRequest={workspaceFilePreviewOpenRequest}
            workspaceFilePreviewOpen={workspaceFilePreviewOpen}
            onWorkspaceFilePreviewOpenEditor={openWorkspaceEditorFile}
            onWorkspaceFilePreviewRequestClose={requestWorkspaceFilePreviewClose}
            onWorkspaceFilePreviewClose={handleWorkspaceFilePreviewClosed}
            workspaceSshTerminalMounted={workspaceSshTerminalMounted}
            workspaceSshTerminalOpenRequest={workspaceSshTerminalOpenRequest}
            workspaceSshTerminalOpen={workspaceSshTerminalOpen}
            terminalProjectPathKey={terminalProjectPathKey}
            terminalClient={terminalClient}
            sftpClient={sftpClient}
            terminalSessions={terminalSessions}
            onWorkspaceSshTerminalHide={hideWorkspaceSshTerminalOverlay}
          />
        </div>

        {terminalClient ? (
          <RightDockPanel
            isOpen={activeView === "chat" && rightDockOpen}
            collapseImmediately={activeView !== "chat"}
            projectPathKey={terminalProjectPathKey}
            cwd={terminalProjectPath}
            sessions={terminalSessions}
            sessionsLoaded={terminalSessionsLoaded}
            width={settings.customSettings.rightDock.width}
            theme={effectiveTheme}
            disabledMessage={projectToolsDisabledMessage}
            terminalDisabledMessage={terminalDisabledMessage}
            projectState={rightDockProjectState}
            fileTreeState={rightDockFileTreeState}
            sshHosts={settings.ssh.hosts}
            associatedSshHostIds={associatedSshHostIds}
            client={terminalClient}
            gitClient={gitClient}
            gitWriteEnabled={settings.remote.enableWebGit}
            gitDisabledMessage={gitDisabledMessage}
            tunnelClient={isAgentMode ? api : null}
            tunnelEnabled={tunnelEnabled}
            tunnelDisabledMessage={tunnelDisabledMessage}
            tunnelPublicBaseUrl={window.location.origin}
            workspaceActivityClient={workspaceActivityClient}
            onWidthChange={handleRightDockWidthChange}
            onProjectStateChange={handleRightDockProjectStateChange}
            onFileTreeStateChange={handleRightDockFileTreeStateChange}
            onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
            onOpenSshSession={handleOpenSshTerminal}
            onSessionsChange={handleProjectTerminalSessionsChange}
            onInsertFileMention={handleRightDockInsertFileMention}
            onOpenFile={handleOpenWorkspaceFile}
            onInsertCommitMention={handleRightDockInsertCommitMention}
            onInsertGitFileMention={handleRightDockInsertGitFileMention}
            onClose={handleRightDockClose}
          />
        ) : null}

        {settingsOpen ? (
          <div
            className={`gateway-settings-overlay ${
              overlay === "open" ? "gateway-settings-overlay-open" : ""
            }`}
            onTransitionEnd={handleSettingsTransitionEnd}
          >
            <SettingsPage
              settings={settings}
              setSettings={setSettings}
              saveState={settingsSaveState}
              onBack={closeSettings}
              initialSection={settingsSection}
              hiddenSections={["remote"]}
            />
          </div>
        ) : null}
      </div>
    </LocaleContext.Provider>
  );
}
