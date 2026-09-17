import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as Network from 'expo-network';
import { readStoredValue, writeStoredValue, deleteStoredValue } from '@/lib/storage';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Directions,
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGenericKeyboard } from '@/hooks/use-generic-keyboard';
import { KEY_CODES, MODIFIER_FLAGS, normalizeShortcut, type ShortcutModifier } from '@/lib/keyboard-shortcuts.mjs';
import { programmedKeysStorageKey, parseGenericProgrammedKeys, type ProgrammedKeyAction } from '@/lib/programmed-keys';
import { usePhoneMicrophone } from '@/hooks/use-phone-microphone';
import ChatDrawer, { type ChatDrawerHandle } from '@/components/chat-drawer';
import { CentralIcon, type CentralIconName } from '@/components/central-icon';
import { CodexCommandGlyph } from '@/components/codex-command-glyph';
import {
  CodexMicroActionGlyph,
  CodexMicroGlyph,
  CodexVoiceGlyph,
} from '@/components/codex-micro-glyph';
import { DeckLighting, type MicLight } from '@/components/deck-lighting';
import { HardwareKey } from '@/components/hardware-key';
import { Joystick } from '@/components/joystick';
import { ReasoningDial } from '@/components/reasoning-dial';
import { DismissibleSheet, SheetHandlePill } from '@/components/sheet-dismiss-handle';
import { RaisedShell, Screw, ShellPool, getSkeuo, useSkeuo } from '@/components/skeuo';
import {
  BridgeStatus,
  QueuedMessage,
  RemoteState,
  ReasoningEffort,
  bridgeEventAuthentication,
  bridgeEventsUrl,
  bridgeRequest as realBridgeRequest,
  inferBridgeUrl,
  isBridgeAuthError,
  isBridgeConnectionError,
  mobileAppInfo,
  openBridgeEvent,
  registerBridgeEncryption,
  resetEncryptedBridgeSession,
} from '@/lib/bridge';
import {
  createDemoRemoteState,
  createDemoStatus,
  respondToDemoRequest,
} from '@/lib/demo';
import {
  type E2EEKeyMaterial,
  normalizeE2EEKeyMaterial,
} from '@/lib/e2ee-core';
import { Fonts } from '@/lib/fonts';
import { suggestedKeycapForCommand } from '@/lib/keycap-catalog';
import {
  DEFAULT_MICRO_LAYOUT,
  MICRO_ACTIONS,
  defaultActionForKeycap,
  defaultProgrammedKeys,
  findMicroAction,
  legacyActionIdForProgrammedKey,
  parseProgrammedKeys,
  programmedActionId,
} from '@/lib/micro-actions';
import type {
  MicroAction,
  MicroActionIcon,
  MicroKeycapId,
  ProgrammedKey,
  ProgrammableCommandId,
} from '@/lib/micro-actions';
import { claimPairingPayload, parsePairingUrl } from '@/lib/pairing';
import type { AgentStatusKey } from '@/lib/theme';
import { LED, LED_RECORDING, statusTone, ThemePalette, useTheme } from '@/lib/theme';

const STATUS_ICON: Partial<Record<AgentStatusKey, CentralIconName>> = {
  complete: 'successCircle',
  waiting: 'alert',
  error: 'alert',
};

type JoystickDirection = 'up' | 'right' | 'down' | 'left';
type EncoderMode = 'reasoning' | 'composer-navigation' | 'conversation-scroll';
type InfoSheet = 'about' | 'privacy' | 'support' | 'licenses';
type BridgeRequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
};
type Styles = ReturnType<typeof createStyles>;

const STORAGE_URL = 'microdex.bridge.url';
const STORAGE_TOKEN = 'microdex.bridge.token';
const STORAGE_E2EE = 'microdex.bridge.e2ee.v1';
const STORAGE_PROGRAMMED_KEYS = 'microdex.programmable.keys.v2';
const STORAGE_LEGACY_PROGRAMMED_KEYS = 'microdex.programmable.keys.v1';
const STORAGE_ENCODER_MODE = 'microdex.encoder.mode.v1';
const STORAGE_AI_CONSENT = 'microdex.ai-data-consent.v1';
const AI_CONSENT_VERSION = '2026-08-05';
const PROJECT_URL = 'https://github.com/Kappaemme-git/microdex';
const LICENSE_URL =
  'https://github.com/Kappaemme-git/microdex/blob/main/LICENSE';
const THIRD_PARTY_LICENSE_URL =
  'https://github.com/Kappaemme-git/microdex/blob/main/bridge/native-shim/THIRD_PARTY_LICENSE.txt';
const EXPO_BRIDGE_TOKEN = __DEV__
  ? process.env.EXPO_PUBLIC_MICRODEX_TOKEN?.trim() ?? ''
  : '';
const FALLBACK_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const COMPLETE_LIGHT_MS = 1_200;
const KEY_RESULT_LIGHT_MS = 900;
const LED_VOICE = '#8EA8FF';
const ACTION_PROGRESS: Record<string, string> = {
  fast: '正在更新 Fast 模式',
  reasoning: '正在更新推理强度',
  send: '正在发送到 Codex',
  select: '正在切换任务',
  approve: '正在批准请求',
  decline: '正在拒绝请求',
  fork: '正在分叉任务',
  dictation: '正在开启听写',
  voice: '正在控制 Codex 语音',
  plan: '正在切换模式',
  forward: '正在前进',
  sidebar: '正在切换侧栏',
  back: '正在返回',
};
const VISUAL_PREVIEW =
  __DEV__ &&
  Platform.OS === 'web' &&
  new URLSearchParams(globalThis.location?.search ?? '').get('preview') === '1';
const VISUAL_PREVIEW_REMOTE = createDemoRemoteState();
const VISUAL_PREVIEW_STATUS = createDemoStatus(
  VISUAL_PREVIEW_REMOTE,
  MICRO_ACTIONS.length,
);

function readableError(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * Throws when the bridge could not run the command, and otherwise returns the
 * caveat to show when the command was delivered but its result could not be
 * read back. A key stroke has no return value, so treating "unconfirmed" as a
 * failure would make every working desktop key look broken.
 *
 * `confirmed` is only sent by newer bridges; when it is absent, fall back to
 * `verified` so an older bridge keeps working.
 */
function requireVerifiedCommand(state: RemoteState) {
  const result = state.commandResult;
  if (!result?.applied || !result.verified) {
    throw new Error(
      result?.warning ||
      'Codex received the command but did not confirm that it was applied.',
    );
  }
  const confirmed = result.confirmed ?? true;
  return confirmed ? null : result.warning ?? null;
}


function GuideItem({
  styles,
  theme,
  icon,
  actionId,
  title,
  body,
}: {
  styles: Styles;
  theme: ThemePalette;
  icon?: MicroActionIcon;
  actionId?: string;
  title: string;
  body: string;
}) {
  return (
    <View style={styles.guideItem}>
      <View style={styles.guideIcon}>
        {actionId ? (
          <CodexMicroActionGlyph actionId={actionId} size={20} color={theme.text} />
        ) : (
          <MaterialCommunityIcons name={icon ?? 'circle-outline'} size={20} color={theme.text} />
        )}
      </View>
      <View style={styles.guideCopy}>
        <Text style={styles.guideTitle}>{title}</Text>
        <Text style={styles.guideBody}>{body}</Text>
      </View>
    </View>
  );
}

function MicrodexMark({ size = 24 }: { size?: number }) {
  const padding = size * 0.18;
  const gap = size * 0.075;
  const keyWidth = (size - (padding * 2) - gap) / 2;
  const keyHeight = (size - (padding * 2) - (gap * 2)) / 3;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        backgroundColor: '#0A0A0A',
        padding,
      }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
        {Array.from({ length: 6 }, (_, index) => (
          <View
            key={index}
            style={{
              width: keyWidth,
              height: keyHeight,
              borderRadius: Math.max(1, size * 0.045),
              backgroundColor: '#F7F7F3',
              opacity: index === 5 ? 0.82 : 1,
            }}
          />
        ))}
      </View>
      <View
        style={{
          position: 'absolute',
          right: size * 0.095,
          bottom: size * 0.17,
          width: size * 0.37,
          height: Math.max(1, size * 0.055),
          borderRadius: size,
          backgroundColor: '#F7F7F3',
          transform: [{ rotate: '-43deg' }],
        }}
      />
    </View>
  );
}

export default function ControllerScreen() {
  const { theme, mode, setMode } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const skeuo = useSkeuo();
  const statusMeta = useMemo(() => statusTone(theme), [theme]);
  const insets = useSafeAreaInsets();
  const [demoMode, setDemoMode] = useState(VISUAL_PREVIEW);
  const [bridgeUrl, setBridgeUrl] = useState(inferBridgeUrl());
  const [token, setToken] = useState(EXPO_BRIDGE_TOKEN);
  const [e2ee, setE2ee] = useState<E2EEKeyMaterial | null>(null);
  const [status, setStatus] = useState<BridgeStatus | null>(
    VISUAL_PREVIEW ? VISUAL_PREVIEW_STATUS : null,
  );
  const [remote, setRemote] = useState<RemoteState | null>(
    VISUAL_PREVIEW ? VISUAL_PREVIEW_REMOTE : null,
  );
  const [liveChannel, setLiveChannel] = useState<'offline' | 'connecting' | 'live'>(
    VISUAL_PREVIEW ? 'live' : 'offline',
  );
  const [pairingTarget, setPairingTarget] = useState<{ name: string; address: string } | null>(null);
  const pairingDecision = useRef<((accepted: boolean) => void) | null>(null);
  const pairingAbort = useRef<AbortController | null>(null);
  const pairingSave = useRef<Promise<unknown> | null>(null);
  const connectionSave = useRef<Promise<unknown> | null>(null);
  const connectionGeneration = useRef(0);
  const finishPairingDecision = (accepted: boolean) => {
    const resolve = pairingDecision.current;
    pairingDecision.current = null;
    setPairingTarget(null);
    resolve?.(accepted);
  };
  useEffect(() => () => { connectionGeneration.current++; pairingInFlight.current = false; pairingAbort.current?.abort(); pairingDecision.current?.(false); pairingDecision.current = null; }, []);
  const [draft, setDraft] = useState('');
  const draftSendInFlight = useRef(false);
  const [composerVisible, setComposerVisible] = useState(true);
  const composerRef = useRef<TextInput>(null);
  const mainScrollRef = useRef<ScrollView>(null);
  const chatDrawerRef = useRef<ChatDrawerHandle>(null);
  const liveStatusPulse = useRef(new Animated.Value(0.62)).current;
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [manualPairingOpen, setManualPairingOpen] = useState(false);
  const [manualPairingText, setManualPairingText] = useState('');
  const [manualPairingBusy, setManualPairingBusy] = useState(false);
  const [consentVisible, setConsentVisible] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [infoSheet, setInfoSheet] = useState<InfoSheet | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [credentialsReady, setCredentialsReady] = useState(VISUAL_PREVIEW);
  const [credentialLoadError, setCredentialLoadError] = useState(false);
  const [credentialLoadAttempt, setCredentialLoadAttempt] = useState(0);
  const [bridgeConnecting, setBridgeConnecting] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState('Ready. Connect the desktop bridge to control Codex.');
  const [noticeError, setNoticeError] = useState(false);
  const [programmedKeys, setProgrammedKeys] = useState<(ProgrammedKey | null)[]>(
    defaultProgrammedKeys,
  );
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [actionSearch, setActionSearch] = useState('');
  const [chosenActionId, setChosenActionId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [shortcutKey, setShortcutKey] = useState('Enter');
  const [shortcutModifiers, setShortcutModifiers] = useState<ShortcutModifier[]>([]);
  const [keysLoadedFor, setKeysLoadedFor] = useState<string | null>(null);
  const [keysSaving, setKeysSaving] = useState(false);
  const keySaveInFlight = useRef(false);
  const keysDevice = e2ee?.keyId ?? null;
  const keysDeviceRef = useRef(keysDevice); keysDeviceRef.current = keysDevice;
  const keysReady = Boolean(keysDevice && keysLoadedFor === keysDevice);
  const genericKeyboard = useGenericKeyboard(bridgeUrl, token, e2ee, Boolean(status) && !demoMode);
  const [encoderMode, setEncoderMode] = useState<EncoderMode>('reasoning');
  const [guideVisible, setGuideVisible] = useState(false);
  const [keyManagerVisible, setKeyManagerVisible] = useState(false);
  const phoneMicrophone = usePhoneMicrophone(bridgeUrl, token, e2ee);
  const dictationActive = phoneMicrophone.active;
  const [dictationEnding, setDictationEnding] = useState(false);
  const [dictationLinked, setDictationLinked] = useState(false);

  const keyboardNow = useRef(genericKeyboard); keyboardNow.current = genericKeyboard;
  const dictationStopping = useRef(false);
  const sendInFlight = useRef(false);
  const dictationSession = useRef<{ target: string; pending: boolean; request: Promise<boolean> | null } | null>(null);
  const togglePhoneDictation = useCallback(async () => {
    if (dictationStopping.current) return false;
    if (phoneMicrophone.active) {
      dictationStopping.current = true; setDictationEnding(true);
      const session = dictationSession.current;
      dictationSession.current = null;

      let ended = false;
      try {
        if (session?.request && await session.request) {
          if (keyboardNow.current.target?.id === session.target) {
            ended = await keyboardNow.current.press({ key: 'RightOption', modifiers: [] });
          } else {
            setNotice('Mac 前台应用已变化，语音输入开关未切换；手机已停止采音。'); setNoticeError(true);
          }
        }
      } finally { await phoneMicrophone.stop(); dictationStopping.current = false; setDictationEnding(false); setDictationLinked(false); }
      return ended;
    }
    setDictationLinked(false);
    setNoticeError(false);
    if (!genericKeyboard.target) {
      dictationSession.current = null;
      setNotice(`麦克风可独立使用；语音开关联动暂不可用：${genericKeyboard.message}`); setNoticeError(true);
      await phoneMicrophone.toggle();
      return;
    }
    dictationSession.current = { target: genericKeyboard.target.id, pending: true, request: null };
    await phoneMicrophone.toggle();
  }, [phoneMicrophone, genericKeyboard]);
  useEffect(() => {
    const session = dictationSession.current;
    if (!session?.pending || phoneMicrophone.state !== 'speaking' || !phoneMicrophone.telemetry.inputSelected) return;
    session.pending = false; // A reconnect must never toggle dictation again.
    if (genericKeyboard.target?.id === session.target) {
      session.request = genericKeyboard.press({ key: 'RightOption', modifiers: [] });
      void session.request.then(posted => {
        if (dictationSession.current !== session) return;
        setDictationLinked(posted);
        if (!posted) { setNotice('仅传音，听写启动未确认；请结束后重试'); setNoticeError(true); }
      });
    } else {
      setNotice('Mac 输入目标已变化，本次仅传音；请结束后重新开始讲话。'); setNoticeError(true);
    }
  }, [phoneMicrophone.state, phoneMicrophone.telemetry.inputSelected, genericKeyboard]);
  useEffect(() => { dictationSession.current = null; }, [bridgeUrl, token, e2ee]);

  const [completionLight, setCompletionLight] = useState(false);
  const [hardwareFeedbackColor, setHardwareFeedbackColor] = useState<string | null>(null);
  const [keyResultLights, setKeyResultLights] = useState<Record<number, string>>({});
  const encoderQueue = useRef<Promise<void>>(Promise.resolve());
  const completionLightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hardwareFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyResultTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const previousActiveState = useRef<{ id: string; status: AgentStatusKey } | null>(null);
  const reconnectAttempt = useRef(0);
  const connectionInFlight = useRef(false);
  const pairingInFlight = useRef(false);
  const remoteRef = useRef<RemoteState | null>(
    VISUAL_PREVIEW ? VISUAL_PREVIEW_REMOTE : null,
  );
  /** Pairing link already attempted, so an incoming link is claimed once only. */
  const handledPairingUrl = useRef<string | null>(null);
  /** Set when the Mac rejected the saved credential, which stops the retry loop. */
  const credentialRejected = useRef(false);
  const incomingUrl = Linking.useLinkingURL();
  const networkState = Network.useNetworkState();
  const appInfo = useMemo(() => mobileAppInfo(), []);

  useEffect(() => {
    remoteRef.current = remote;
  }, [remote]);

  const activeAgent = remote?.selected ?? {
    id: '0', name: '尚未选择任务', task: '连接 Mac 后选择 Codex 任务', status: 'idle' as const,
  };
  const activeThread = remote?.selected ?? null;
  const activeMessageQueue = remote?.messageQueue.filter(
    (message) => message.threadId === activeThread?.id,
  ) ?? [];
  const activeThreadIndex = remote?.threads.findIndex(
    (thread) => thread.id === activeThread?.id,
  ) ?? -1;
  const voiceState = remote?.voice?.state ?? 'inactive';
  const voiceActive = voiceState === 'active';
  const voiceMuted = remote?.voice?.muted ?? false;
  const supportedReasoningEfforts = activeThread?.supportedReasoningEfforts?.length
    ? activeThread.supportedReasoningEfforts
    : FALLBACK_EFFORTS;
  const effortIndex = Math.max(
    0,
    supportedReasoningEfforts.indexOf(activeThread?.reasoningEffort ?? 'medium'),
  );
  const [dialIndex, setDialIndex] = useState(effortIndex);
  const activeMeta = statusMeta[activeAgent.status];
  const chosenAction = findMicroAction(chosenActionId);
  const filteredActions = useMemo(() => {
    const query = actionSearch.trim().toLowerCase();
    if (!query) return MICRO_ACTIONS.filter(action => action.id === 'voicedeck.shortcut');
    return MICRO_ACTIONS.filter((action) => action.id === 'voicedeck.shortcut' &&
      `${action.label} ${action.description} ${action.category}`.toLowerCase().includes(query),
    );
  }, [actionSearch]);
  const guideGroups = useMemo(() => {
    const order: MicroAction['category'][] = [
      'Core', 'Task', 'Input', 'Workspace', 'Custom',
    ];
    const titles: Record<MicroAction['category'], string> = {
      Core: 'Core controls',
      Task: 'Task & chat',
      Input: 'Input & voice',
      Workspace: 'Workspace & navigation',
      Custom: 'Custom prompts',
    };
    return order
      .map((category) => ({
        category,
        title: titles[category],
        actions: MICRO_ACTIONS.filter((action) => action.category === category),
      }))
      .filter((group) => group.actions.length > 0);
  }, []);
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(liveStatusPulse, {
          toValue: 1,
          duration: 720,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(liveStatusPulse, {
          toValue: 0.62,
          duration: 720,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [liveStatusPulse]);

  const openChatSwitcher = useCallback(() => {
    chatDrawerRef.current?.open();
  }, []);

  const closeChatSwitcher = useCallback(() => {
    chatDrawerRef.current?.close();
  }, []);

  const announce = useCallback((message: string, isError = false) => {
    setNotice(message);
    setNoticeError(isError);
  }, []);

  const bridgeRequest = useCallback(async <T,>(
    candidateUrl: string,
    candidateToken: string,
    path: string,
    options: BridgeRequestOptions = {},
    candidateE2EE?: E2EEKeyMaterial | null,
  ): Promise<T> => {
    if (!demoMode) {
      return realBridgeRequest<T>(
        candidateUrl,
        candidateToken,
        path,
        options,
        candidateE2EE,
      );
    }

    const current = remoteRef.current ?? createDemoRemoteState();
    if (path === '/api/status') {
      return createDemoStatus(current, MICRO_ACTIONS.length) as T;
    }
    if (path === '/api/remote/state') return current as T;

    const result = respondToDemoRequest(current, path, options.body);
    remoteRef.current = result.remote;
    setRemote(result.remote);
    return result.response as T;
  }, [demoMode]);

  const tryOpenChatFromSwipe = useCallback(() => {
    if (!status) {
      setSettingsVisible(true);
      announce('Connect the bridge first, then swipe to open chats.', true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    openChatSwitcher();
  }, [announce, openChatSwitcher, status]);

  // Fling left opens chat — more reliable vs ScrollView than a competing Pan.
  const homeFlingLeft = useMemo(
    () =>
      Gesture.Fling()
        .direction(Directions.LEFT)
        .onEnd(() => {
          runOnJS(tryOpenChatFromSwipe)();
        }),
    [tryOpenChatFromSwipe],
  );

  // Left-edge pull (drawer convention) as a backup hit target.
  const homeEdgeOpen = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(10)
        .failOffsetY([-28, 28])
        .onEnd((event) => {
          if (event.translationX >= 40 || event.velocityX >= 500) {
            runOnJS(tryOpenChatFromSwipe)();
          }
        }),
    [tryOpenChatFromSwipe],
  );

  useEffect(() => {
    if (VISUAL_PREVIEW) return;
    let cancelled = false;
    void (async () => {
      const [
        savedUrl,
        savedToken,
        savedE2EE,
        savedKeys,
        savedLegacyKeys,
        savedEncoderMode,
        savedConsent,
      ] = await Promise.all([
        readStoredValue(STORAGE_URL),
        readStoredValue(STORAGE_TOKEN),
        readStoredValue(STORAGE_E2EE),
        readStoredValue(STORAGE_PROGRAMMED_KEYS),
        readStoredValue(STORAGE_LEGACY_PROGRAMMED_KEYS),
        readStoredValue(STORAGE_ENCODER_MODE),
        readStoredValue(STORAGE_AI_CONSENT),
      ]);
      let encryption: E2EEKeyMaterial | null = null;
      if (savedUrl && savedE2EE && !EXPO_BRIDGE_TOKEN) {
        encryption = normalizeE2EEKeyMaterial(JSON.parse(savedE2EE));
        // Migrate the old global layout only to the device saved alongside it.
        const deviceKey = programmedKeysStorageKey(encryption.keyId);
        const storedKeys = savedKeys ?? savedLegacyKeys;
        try {
          const ownerKey = 'voicedeck.legacy-keys-owner';
          const owner = await readStoredValue(ownerKey);
          if (storedKeys && (!owner || owner === encryption.keyId)) {
            if (!owner) await writeStoredValue(ownerKey, encryption.keyId);
            if (await readStoredValue(deviceKey) === null) {
              await writeStoredValue(deviceKey, JSON.stringify(parseProgrammedKeys(storedKeys)));
            }
          }
        } catch { announce('旧快捷配置迁移失败，原记录已保留', true); }
      }
      if (cancelled) return;
      if (savedUrl && !EXPO_BRIDGE_TOKEN) setBridgeUrl(savedUrl);
      setToken(EXPO_BRIDGE_TOKEN || savedToken || '');
      if (savedUrl) registerBridgeEncryption(savedUrl, encryption);
      setE2ee(encryption);
      if (
        savedEncoderMode === 'reasoning' ||
        savedEncoderMode === 'composer-navigation' ||
        savedEncoderMode === 'conversation-scroll'
      ) {
        setEncoderMode(savedEncoderMode);
      }
      const consentAccepted = savedConsent === AI_CONSENT_VERSION;
      setAiConsent(false);
      setCredentialLoadError(false);
      setCredentialsReady(true);
    })().catch(() => {
      if (cancelled) return;
      setToken(''); setE2ee(null); setStatus(null); setRemote(null);
      setCredentialLoadError(true);
    });
    return () => { cancelled = true; };
  }, [credentialLoadAttempt]);

  useEffect(() => {
    let cancelled = false;
    setEditingSlot(null); setKeyManagerVisible(false); setKeysLoadedFor(null);
    setProgrammedKeys(defaultProgrammedKeys());
    if (keysDevice) void readStoredValue(programmedKeysStorageKey(keysDevice)).then(raw => {
      if (!cancelled) { setProgrammedKeys(parseGenericProgrammedKeys(raw)); setKeysLoadedFor(keysDevice); }
    }).catch(() => { if (!cancelled) announce('快捷配置读取失败，请重新连接后重试', true); });
    return () => { cancelled = true; };
  }, [keysDevice, announce]);

  const persistProgrammedKeys = useCallback(async (nextKeys: (ProgrammedKey | null)[]) => {
    if (!keysReady || !keysDevice || keysDeviceRef.current !== keysDevice || keySaveInFlight.current) return false;
    keySaveInFlight.current = true; setKeysSaving(true);
    try {
      await writeStoredValue(programmedKeysStorageKey(keysDevice), JSON.stringify(nextKeys));
      if (keysDeviceRef.current !== keysDevice) return false;
      setProgrammedKeys(nextKeys);
      return true;
    } catch {
      if (keysDeviceRef.current === keysDevice) announce('快捷配置保存失败，原配置已保留', true);
      return false;
    } finally { keySaveInFlight.current = false; setKeysSaving(false); }
  }, [keysDevice, keysReady, announce]);

  useEffect(() => {
    if (loadingAction === 'reasoning') return;
    setDialIndex(effortIndex);
  }, [effortIndex, loadingAction]);

  // Status lights are notifications, not permanent decoration. Thinking,
  // waiting and error remain visible while they need attention; completion
  // flashes once when the active task actually transitions to complete.
  useEffect(() => {
    const current = activeThread
      ? { id: activeThread.id, status: activeAgent.status }
      : null;
    const previous = previousActiveState.current;

    if (
      current &&
      previous?.id === current.id &&
      previous.status !== current.status &&
      current.status === 'complete'
    ) {
      if (completionLightTimer.current) clearTimeout(completionLightTimer.current);
      setCompletionLight(true);
      completionLightTimer.current = setTimeout(() => {
        completionLightTimer.current = null;
        setCompletionLight(false);
      }, COMPLETE_LIGHT_MS);
    } else if (current?.status !== 'complete') {
      if (completionLightTimer.current) clearTimeout(completionLightTimer.current);
      completionLightTimer.current = null;
      setCompletionLight(false);
    }

    previousActiveState.current = current;
  }, [activeAgent.status, activeThread]);

  useEffect(() => () => {
    if (completionLightTimer.current) clearTimeout(completionLightTimer.current);
    if (hardwareFeedbackTimer.current) clearTimeout(hardwareFeedbackTimer.current);
    for (const timer of keyResultTimers.current.values()) clearTimeout(timer);
    keyResultTimers.current.clear();
  }, []);

  const flashHardwareFeedback = useCallback((color: string) => {
    if (hardwareFeedbackTimer.current) clearTimeout(hardwareFeedbackTimer.current);
    setHardwareFeedbackColor(color);
    hardwareFeedbackTimer.current = setTimeout(() => {
      hardwareFeedbackTimer.current = null;
      setHardwareFeedbackColor(null);
    }, KEY_RESULT_LIGHT_MS);
  }, []);

  const flashProgrammedKey = useCallback((slotIndex: number, color: string) => {
    const existing = keyResultTimers.current.get(slotIndex);
    if (existing) clearTimeout(existing);
    setKeyResultLights((current) => ({ ...current, [slotIndex]: color }));
    const timer = setTimeout(() => {
      keyResultTimers.current.delete(slotIndex);
      setKeyResultLights((current) => {
        const next = { ...current };
        delete next[slotIndex];
        return next;
      });
    }, KEY_RESULT_LIGHT_MS);
    keyResultTimers.current.set(slotIndex, timer);
  }, []);

  const revealRemoteComposer = useCallback(() => {
    requestAnimationFrame(() => {
      mainScrollRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  const openRemoteComposer = useCallback(() => {
    setComposerVisible(true);
    requestAnimationFrame(() => {
      revealRemoteComposer();
      composerRef.current?.focus();
    });
  }, [revealRemoteComposer]);

  useEffect(() => {
    if (!activeMessageQueue.length) return;
    if (composerRef.current?.isFocused()) {
      revealRemoteComposer();
    }
  }, [activeMessageQueue.length, revealRemoteComposer]);

  const handleActionError = useCallback((error: unknown) => {
    if (isBridgeConnectionError(error)) {
      setStatus(null);
      setRemote(null);
    }
    announce(readableError(error), true);
  }, [announce]);

  const refreshRemote = useCallback(async () => {
    if (!status) return false;
    try {
      const next = await bridgeRequest<RemoteState>(bridgeUrl, token, '/api/remote/state');
      setRemote(next);
      return true;
    } catch (error) {
      handleActionError(error);
      return false;
    }
  }, [bridgeRequest, bridgeUrl, handleActionError, status, token]);



  const connectToBridge = useCallback(async (
    candidateUrl: string,
    candidateToken: string,
    interactive = false,
    candidateE2EE: E2EEKeyMaterial | null = e2ee,
  ) => {
    if (!candidateUrl.trim() || !candidateToken.trim()) {
      if (interactive) announce('Enter the bridge address and access code.', true);
      return false;
    }
    if (connectionInFlight.current) return false;
    connectionInFlight.current = true;
    const generation = ++connectionGeneration.current;
    setBridgeConnecting(true);
    if (interactive) setLoadingAction('connect');
    try {
      registerBridgeEncryption(candidateUrl, candidateE2EE);
      const nextStatus = await bridgeRequest<BridgeStatus>(
        candidateUrl,
        candidateToken,
        '/api/status',
        {},
        candidateE2EE,
      );
      if (generation !== connectionGeneration.current) return false;
      const saving = Promise.all([
        writeStoredValue(STORAGE_URL, candidateUrl.trim()),
        writeStoredValue(STORAGE_TOKEN, candidateToken.trim()),
        candidateE2EE
          ? writeStoredValue(STORAGE_E2EE, JSON.stringify(candidateE2EE))
          : deleteStoredValue(STORAGE_E2EE),
      ]);
      connectionSave.current = saving;
      try { await saving; }
      finally { if (connectionSave.current === saving) connectionSave.current = null; }
      if (generation !== connectionGeneration.current) return false;
      setBridgeUrl(candidateUrl.trim());
      setToken(candidateToken.trim());
      setE2ee(candidateE2EE);
      setStatus(nextStatus);
      if (nextStatus.remote?.online) setRemote(nextStatus.remote as RemoteState);
      setSettingsVisible(false);
      setScannerVisible(false);
      reconnectAttempt.current = 0;
      credentialRejected.current = false;
      announce(
        candidateUrl.trim().startsWith('https://')
          ? 'Secure remote bridge connected. Microdex now works on Wi-Fi or mobile data.'
          : 'Local bridge connected. The keys now control Codex.',
      );
      if (interactive) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      return true;
    } catch (error) {
      if (generation !== connectionGeneration.current) return false;
      setStatus(null);
      setRemote(null);
      // A rejected credential is final. Say so once and drop the stale token, so
      // the reconnect loop stops and the pairing screen becomes reachable
      // instead of the app retrying an access code the Mac will never accept.
      if (isBridgeAuthError(error)) {
        credentialRejected.current = true;
        announce(readableError(error), true);
        registerBridgeEncryption(candidateUrl, null);
        setToken('');
        setE2ee(null);
        try { await Promise.all([deleteStoredValue(STORAGE_TOKEN), deleteStoredValue(STORAGE_E2EE)]); }
        catch { announce('授权已失效，本次连接已停止；保存的配对数据未能清除，请在设置中重试移除此 Mac。', true); }
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return false;
      }
      if (interactive) {
        announce(readableError(error), true);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      return false;
    } finally {
      if (generation === connectionGeneration.current) {
        connectionInFlight.current = false;
        setBridgeConnecting(false);
        if (interactive) setLoadingAction(null);
      }
    }
  }, [announce, bridgeRequest, demoMode, e2ee]);

  const claimPairingCode = useCallback(async (value: string) => {
    if (pairingInFlight.current) return false;
    pairingInFlight.current = true;
    const controller = new AbortController();
    pairingAbort.current = controller;
    try {
      const payload = parsePairingUrl(value);
      // Stop the camera after the first valid read. If the Mac is unreachable,
      // keeping the scanner mounted immediately reads the same QR again.
      Keyboard.dismiss();
      setScannerVisible(false);
      setSettingsVisible(false);
      if (Platform.OS === 'ios') await new Promise(resolve => setTimeout(resolve, 320));
      if (!pairingInFlight.current || controller.signal.aborted) return false;
      const accepted = await new Promise<boolean>(resolve => {
        pairingDecision.current = resolve;
        setPairingTarget({ name: payload.deviceName || '名称未知（旧版邀请）', address: payload.bridgeUrl });
      });
      if (!accepted || controller.signal.aborted) return false;
      credentialRejected.current = false;
      announce('正在请求配对，请在目标 Mac 上确认。');
      const credentials = await claimPairingPayload(payload, controller.signal);
      if (controller.signal.aborted) return false;
      const saving = Promise.all([
        writeStoredValue(STORAGE_URL, credentials.bridgeUrl),
        writeStoredValue(STORAGE_TOKEN, credentials.token),
        credentials.e2ee
          ? writeStoredValue(STORAGE_E2EE, JSON.stringify(credentials.e2ee))
          : deleteStoredValue(STORAGE_E2EE),
      ]);
      pairingSave.current = saving;
      try { await saving; }
      finally { if (pairingSave.current === saving) pairingSave.current = null; }
      if (controller.signal.aborted) return false;
      setBridgeUrl(credentials.bridgeUrl);
      setToken(credentials.token);
      setE2ee(credentials.e2ee ?? null);
      return await connectToBridge(
        credentials.bridgeUrl,
        credentials.token,
        true,
        credentials.e2ee ?? null,
      );
    } catch (error) {
      if (controller.signal.aborted) return false;
      announce(readableError(error), true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return false;
    } finally {
      if (pairingAbort.current === controller) { pairingAbort.current = null; pairingInFlight.current = false; }
    }
  }, [announce, connectToBridge]);

  const presentPairingScanner = useCallback(async () => {
    if (Platform.OS === 'web') {
      announce('请在 iPhone 安装版中扫描 Mac 客户端的二维码。', true);
      return;
    }
    let permission = cameraPermission;
    if (!permission?.granted) permission = await requestCameraPermission();
    if (!permission.granted) {
      announce('扫描配对二维码需要相机权限，请在系统设置中允许。', true);
      return;
    }
    // iOS cannot reliably present the camera modal while the Settings modal
    // is still being dismissed. Close it first, then present the scanner.
    setSettingsVisible(false);
    setTimeout(() => setScannerVisible(true), Platform.OS === 'ios' ? 320 : 0);
  }, [announce, cameraPermission, requestCameraPermission]);

  const openPairingScanner = presentPairingScanner;
  const acceptPairingCode = claimPairingCode;

  const acceptAiConsent = useCallback(async () => {
    await writeStoredValue(STORAGE_AI_CONSENT, AI_CONSENT_VERSION);
    setAiConsent(true);
    setConsentVisible(false);
    announce('Data-processing consent saved. You can revoke it in Settings.');
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

  }, [announce]);

  const declineAiConsent = useCallback(() => {
    setConsentVisible(false);
    announce(
      aiConsent
        ? 'Data-processing consent remains enabled.'
        : 'Codex 操作尚未启用。配对、手机麦克风和通用快捷键不受此选项影响。',
    );
  }, [aiConsent, announce]);

  const revokeAiConsent = useCallback(() => {
    Alert.alert(
      'Revoke data-processing consent?',
      'Microdex will keep the saved Mac pairing, but Codex controls will remain blocked until you consent again. Microphone and generic shortcuts stay available.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await deleteStoredValue(STORAGE_AI_CONSENT);
              setAiConsent(false);
              setRemote(null);
              setLiveChannel('offline');
              setSettingsVisible(false);
              announce('Codex 数据处理同意已撤销；手机麦克风与通用快捷键仍可独立使用。');
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            })();
          },
        },
      ],
    );
  }, [announce]);

  const openExternal = useCallback(async (url: string, label: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      announce(`${label} could not be opened. Try again when you are online.`, true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [announce]);

  const showInfoSheet = useCallback((sheet: InfoSheet) => {
    setSettingsVisible(false);
    setConsentVisible(false);
    setTimeout(() => setInfoSheet(sheet), Platform.OS === 'ios' ? 320 : 0);
  }, []);

  const reviewAiConsent = useCallback(() => {
    setSettingsVisible(false);
    setTimeout(() => setConsentVisible(true), Platform.OS === 'ios' ? 320 : 0);
  }, []);

  const enterDemo = useCallback(async () => {
    const demoRemote = createDemoRemoteState();
    remoteRef.current = demoRemote;
    setDemoMode(true);
    setStatus(createDemoStatus(demoRemote, MICRO_ACTIONS.length));
    setRemote(demoRemote);
    setLiveChannel('live');
    setSettingsVisible(false);
    setScannerVisible(false);
    setInfoSheet(null);
    announce('Offline preview active. Every task and command here is fictional.');
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [announce]);

  const exitDemo = useCallback(async () => {
    remoteRef.current = null;
    setDemoMode(false);
    setStatus(null);
    setRemote(null);
    setLiveChannel('offline');
    setSettingsVisible(false);
    setInfoSheet(null);
    announce('Offline preview closed. Pair your Mac to control the real Codex app.');
    await Haptics.selectionAsync();
  }, [announce]);

  const leaveDemoAndPair = useCallback(() => {
    void exitDemo().then(() => openPairingScanner());
  }, [exitDemo, openPairingScanner]);

  const copyDiagnostics = useCallback(async () => {
    let latestStatus = status;
    let refreshError: string | null = null;
    if (bridgeUrl.trim() && token.trim()) {
      try {
        latestStatus = await bridgeRequest<BridgeStatus>(
          bridgeUrl,
          token,
          '/api/status',
        );
        setStatus(latestStatus);
      } catch (error) {
        refreshError = readableError(error);
      }
    }

    const report = {
      microdexDiagnostics: 1,
      generatedAt: new Date().toISOString(),
      app: {
        ...mobileAppInfo(),
        platform: Platform.OS,
      },
      bridge: latestStatus?.bridge ?? {
        version: 'legacy-or-unavailable',
        protocolVersion: 1,
      },
      capabilities: latestStatus?.capabilities ?? null,
      desktop: latestStatus?.desktop ?? null,
      connection: {
        connected: Boolean(latestStatus),
        refreshError,
        networkType: networkState.type,
        networkConnected: networkState.isConnected,
        transport: bridgeUrl.startsWith('https://') ? 'secure-remote' : 'local',
        remoteAccess: latestStatus?.connection ?? null,
      },
      remote: {
        online: Boolean(remote?.online),
        selectedTask: Boolean(remote?.selectedThreadId),
        lastCommand: remote?.commandResult ?? null,
      },
    };
    await Clipboard.setStringAsync(JSON.stringify(report, null, 2));
    announce('Diagnostic report copied. Send it with the failed button name.');
    await Haptics.selectionAsync();
  }, [
    announce,
    bridgeRequest,
    bridgeUrl,
    networkState.isConnected,
    networkState.type,
    remote,
    status,
    token,
  ]);

  const forgetPairedMac = useCallback(async () => {
    connectionGeneration.current++;
    connectionInFlight.current = false;
    setBridgeConnecting(false);
    setLoadingAction(null);
    pairingAbort.current?.abort();
    finishPairingDecision(false);
    // Stop this session even if Keychain/storage cleanup is unavailable.
    credentialRejected.current = true;
    registerBridgeEncryption(bridgeUrl, null);
    setBridgeUrl(inferBridgeUrl());
    setToken('');
    setE2ee(null);
    setAiConsent(false);
    setStatus(null);
    setRemote(null);
    setSettingsVisible(false);
    reconnectAttempt.current = 0;
    try {
      await Promise.all([pairingSave.current, connectionSave.current].map(saving => saving?.catch(() => {})));
      await Promise.all([
        deleteStoredValue(STORAGE_URL), deleteStoredValue(STORAGE_TOKEN),
        deleteStoredValue(STORAGE_E2EE), deleteStoredValue(STORAGE_AI_CONSENT),
      ]);
    } catch {
      setSettingsVisible(true);
      announce('本次连接已停止，但保存的配对数据未能清除。请重试移除此 Mac；重启 App 前请确认清理完成。', true);
      return;
    }
    announce('已移除此 Mac；使用前请重新配对。');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [announce, bridgeUrl]);

  useEffect(() => {
    if (!incomingUrl) return;
    // Accept both slash forms: links generated by older bridges use
    // `microdex://pair`, newer ones the `microdex:///pair` that Expo Router can
    // actually route.
    const isPairDeepLink = /^(?:voicedeck|microdex):\/\/\/?pair\b/.test(incomingUrl);
    const isPairHttp = /\/pair(?:\?|$)/.test(incomingUrl);
    if (!isPairDeepLink && !isPairHttp) return;
    // One attempt per link. `incomingUrl` keeps its value, and this effect
    // re-runs whenever a state update gives `acceptPairingCode` a new identity —
    // including the state update the failure itself causes. That turned a single
    // spent code into an endless retry loop with no way out.
    if (handledPairingUrl.current === incomingUrl) return;
    handledPairingUrl.current = incomingUrl;
    void acceptPairingCode(incomingUrl);
  }, [acceptPairingCode, incomingUrl]);

  useEffect(() => {
    if (
      !credentialsReady ||
      status ||
      !bridgeUrl.trim() ||
      !token.trim() ||
      networkState.isConnected === false ||
      // Nothing to retry once the Mac has rejected the credential.
      credentialRejected.current
    ) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const reconnect = async () => {
      const connected = await connectToBridge(bridgeUrl, token);
      if (cancelled || connected || credentialRejected.current) return;
      reconnectAttempt.current += 1;
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt.current, 4));
      retryTimer = setTimeout(() => void reconnect(), delay);
    };
    void reconnect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    bridgeUrl,
    connectToBridge,
    credentialsReady,
    networkState.isConnected,
    networkState.type,
    status,
    token,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && !status) {
        reconnectAttempt.current = 0;
        void connectToBridge(bridgeUrl, token);
      }
    });
    return () => subscription.remove();
  }, [bridgeUrl, connectToBridge, status, token]);

  const requireBridge = useCallback(() => {
    if (!demoMode && !aiConsent) {
      setConsentVisible(true);
      announce('Review and accept data processing before using live Mac controls.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return false;
    }
    if (status) return true;
    setSettingsVisible(true);
    announce('Connect the bridge running on your computer first.', true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return false;
  }, [aiConsent, announce, demoMode, status]);

  const requireVerifiedSettings = useCallback(() => {
    if (
      status?.capabilities?.verifiedSettings &&
      status.capabilities.actionAvailability &&
      status.capabilities.visibleDesktopRouting
    ) return true;
    announce(
      'Mac 客户端版本不支持此操作，请更新本产品的配套客户端后重试。',
      true,
    );
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return false;
  }, [
    announce,
    status?.capabilities?.actionAvailability,
    status?.capabilities?.visibleDesktopRouting,
    status?.capabilities?.verifiedSettings,
  ]);

  const unavailableReason = useCallback((actionId: string) => {
    if (['APPR', 'REJ', 'approval.approve', 'approval.decline'].includes(actionId) && !remote?.pendingApproval) {
      return '当前没有待审批请求';
    }
    const availability = remote?.actionAvailability?.[actionId];
    return availability && availability.status !== 'available'
      ? availability.reason ?? 'This control is not available right now.'
      : undefined;
  }, [remote?.actionAvailability, remote?.pendingApproval]);

  const requireActionAvailable = useCallback((actionId: string) => {
    const reason = unavailableReason(actionId);
    if (!reason) return true;
    announce(reason, true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    return false;
  }, [announce, unavailableReason]);

  const toggleFast = useCallback(async () => {
    if (!requireBridge()) {
      flashHardwareFeedback(LED.error);
      return;
    }
    if (!requireVerifiedSettings()) {
      flashHardwareFeedback(LED.error);
      return;
    }
    if (!requireActionAvailable('FAST')) {
      flashHardwareFeedback(LED.error);
      return;
    }
    if (!activeThread) {
      announce('Select a Codex task first.', true);
      flashHardwareFeedback(LED.error);
      return;
    }
    const enabled = !activeThread.fastMode;
    const previousRemote = remote;
    setLoadingAction('fast');
    setRemote((current) => current?.selected
      ? {
          ...current,
          selected: { ...current.selected, fastMode: enabled },
          threads: current.threads.map((thread) =>
            thread.id === current.selected?.id ? { ...thread, fastMode: enabled } : thread
          ),
        }
      : current);
    announce(enabled ? 'Enabling Fast Mode…' : 'Disabling Fast Mode…');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const nextRemote = await bridgeRequest<RemoteState>(bridgeUrl, token, '/api/remote/settings', {
        method: 'POST',
        body: { threadId: activeThread.id, fastMode: enabled },
      });
      requireVerifiedCommand(nextRemote);
      setRemote(nextRemote);
      announce(enabled ? 'Fast Mode enabled.' : 'Fast Mode disabled.');
      flashHardwareFeedback(LED.complete);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setRemote(previousRemote);
      handleActionError(error);
      flashHardwareFeedback(LED.error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoadingAction(null);
    }
  }, [
    activeThread,
    announce,
    bridgeRequest,
    bridgeUrl,
    flashHardwareFeedback,
    handleActionError,
    remote,
    requireBridge,
    requireActionAvailable,
    requireVerifiedSettings,
    token,
  ]);

  const commitReasoning = useCallback(
    async (index: number) => {
      if (!requireBridge()) {
        flashHardwareFeedback(LED.error);
        return;
      }
      if (!requireVerifiedSettings()) {
        setDialIndex(effortIndex);
        flashHardwareFeedback(LED.error);
        return;
      }
      const bounded = Math.min(supportedReasoningEfforts.length - 1, Math.max(0, index));
      const effort = supportedReasoningEfforts[bounded];
      setDialIndex(bounded);
      // Compare against what Codex holds, not against the dial: the dial has
      // already moved optimistically while the finger was down.
      if (effort === activeThread?.reasoningEffort) {
        announce(`Reasoning already at ${effort}.`);
        return;
      }
      setLoadingAction('reasoning');
      try {
        if (!activeThread) throw new Error('Select a Codex task first.');
        const nextRemote = await bridgeRequest<RemoteState>(
          bridgeUrl,
          token,
          '/api/remote/settings',
          {
            method: 'POST',
            body: {
              threadId: activeThread.id,
              reasoningEffort: effort,
            },
          },
        );
        requireVerifiedCommand(nextRemote);
        setRemote(nextRemote);
        setDialIndex(bounded);
        announce(`Reasoning set to ${effort}.`);
        flashHardwareFeedback(LED.complete);
        await Haptics.selectionAsync();
      } catch (error) {
        setDialIndex(effortIndex);
        handleActionError(error);
        flashHardwareFeedback(LED.error);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setLoadingAction(null);
      }
    },
    [
      activeThread,
      announce,
      bridgeRequest,
      bridgeUrl,
      effortIndex,
      flashHardwareFeedback,
      handleActionError,
      requireBridge,
      requireVerifiedSettings,
      supportedReasoningEfforts,
      token,
    ],
  );

  const previewReasoning = useCallback((index: number) => {
    const bounded = Math.min(supportedReasoningEfforts.length - 1, Math.max(0, index));
    setDialIndex(bounded);
    void Haptics.selectionAsync();
  }, [supportedReasoningEfforts.length]);

  const sendEncoderAction = useCallback((
    action: 'step' | 'press',
    delta?: -1 | 1,
    steps = 1,
  ) => {
    if (
      encoderMode === 'reasoning' ||
      !requireBridge() ||
      !requireVerifiedSettings()
    ) {
      return;
    }
    // The dial already ticks per notch while spinning, so a batch must not add
    // another one on top.
    if (steps <= 1) void Haptics.selectionAsync();
    encoderQueue.current = encoderQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const next = await bridgeRequest<RemoteState>(
            bridgeUrl,
            token,
            '/api/encoder/action',
            {
              method: 'POST',
              body: {
                mode: encoderMode,
                action,
                delta,
                steps,
              },
            },
          );
          requireVerifiedCommand(next);
          setRemote(next);
        } catch (error) {
          handleActionError(error);
          flashHardwareFeedback(LED.error);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      });
  }, [
    bridgeRequest,
    bridgeUrl,
    encoderMode,
    flashHardwareFeedback,
    handleActionError,
    requireBridge,
    requireVerifiedSettings,
    token,
  ]);

  const changeEncoderMode = useCallback(async (nextMode: EncoderMode) => {
    if (
      nextMode !== 'reasoning' &&
      !status?.capabilities?.encoderModes
    ) {
      announce(
        '请更新 Mac 配套客户端后再启用导航或滚动模式。',
        true,
      );
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setEncoderMode(nextMode);
    await writeStoredValue(STORAGE_ENCODER_MODE, nextMode);
    const label = nextMode === 'reasoning'
      ? 'Reasoning'
      : nextMode === 'composer-navigation'
        ? 'Composer navigation'
        : 'Conversation scroll';
    announce(`Dial mode: ${label}.`);
    await Haptics.selectionAsync();
  }, [announce, status?.capabilities?.encoderModes]);

  const remoteAction = useCallback(async (
    path: string,
    body: Record<string, unknown>,
    actionId: string,
    successMessage: string,
  ) => {
    if (!requireBridge()) {
      flashHardwareFeedback(LED.error);
      return false;
    }
    if (!requireVerifiedSettings()) {
      flashHardwareFeedback(LED.error);
      return false;
    }
    setLoadingAction(actionId);
    announce(ACTION_PROGRESS[actionId] ?? '正在发送操作…');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const next = await bridgeRequest<RemoteState>(bridgeUrl, token, path, { method: 'POST', body });
      const unconfirmed = requireVerifiedCommand(next);
      setRemote(next);
      announce(unconfirmed ? `${successMessage} ${unconfirmed}` : successMessage);
      flashHardwareFeedback(LED.complete);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return true;
    } catch (error) {
      handleActionError(error);
      flashHardwareFeedback(LED.error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return false;
    } finally {
      setLoadingAction(null);
    }
  }, [
    announce,
    bridgeRequest,
    bridgeUrl,
    flashHardwareFeedback,
    handleActionError,
    requireBridge,
    requireVerifiedSettings,
    token,
  ]);

  const handleVoicePress = useCallback(async () => {
    if (!requireBridge() || !requireVerifiedSettings()) {
      flashHardwareFeedback(LED.error);
      return;
    }
    const action = voiceActive ? 'voice-toggle-mute' : 'voice-start';
    setLoadingAction('voice');
    announce(voiceActive ? 'Updating the Voice microphone…' : 'Opening Voice Chat on your Mac…');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const next = await bridgeRequest<RemoteState>(
        bridgeUrl,
        token,
        '/api/desktop/action',
        { method: 'POST', body: { action } },
      );
      requireVerifiedCommand(next);
      setRemote(next);
      if (next.voice?.state === 'setup') {
        announce('Voice setup is open. Choose a voice on your Mac, then press VOICE again.');
      } else if (next.voice?.state === 'launching') {
        announce('Voice Chat opened on your Mac. Complete anything shown there, then press VOICE again.');
      } else if (next.voice?.state === 'active') {
        announce(next.voice.muted ? 'Voice Chat microphone muted.' : 'Voice Chat is live on your Mac.');
      } else {
        announce('Voice Chat command sent to your Mac.');
      }
      flashHardwareFeedback(LED.complete);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      handleActionError(error);
      flashHardwareFeedback(LED.error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoadingAction(null);
    }
  }, [
    announce,
    bridgeRequest,
    bridgeUrl,
    flashHardwareFeedback,
    handleActionError,
    requireBridge,
    requireVerifiedSettings,
    token,
    voiceActive,
  ]);

  const handleVoiceLongPress = useCallback(async () => {
    if (!requireBridge() || !requireVerifiedSettings()) {
      flashHardwareFeedback(LED.error);
      return;
    }
    setLoadingAction('voice');
    announce('Ending Voice Chat…');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const next = await bridgeRequest<RemoteState>(
        bridgeUrl,
        token,
        '/api/desktop/action',
        { method: 'POST', body: { action: 'voice-end' } },
      );
      requireVerifiedCommand(next);
      setRemote(next);
      announce('Voice Chat ended on your Mac.');
      flashHardwareFeedback(LED.complete);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      handleActionError(error);
      flashHardwareFeedback(LED.error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoadingAction(null);
    }
  }, [
    announce,
    bridgeRequest,
    bridgeUrl,
    flashHardwareFeedback,
    handleActionError,
    requireBridge,
    requireVerifiedSettings,
    token,
  ]);


  const switchRemoteThread = useCallback(async (threadId: string) => {
    if (!requireBridge() || !remote) return;
    const target = remote.threads.find((thread) => thread.id === threadId);
    if (!target) return;
    if (target.id === activeThread?.id) {
      closeChatSwitcher();
      return;
    }

    const previousRemote = remote;
    setLoadingAction('select');
    setRemote({
      ...remote,
      selectedThreadId: target.id,
      selected: target,
    });
    announce(`Opening ${target.name}…`);
    void Haptics.selectionAsync();

    try {
      const next = await bridgeRequest<RemoteState>(bridgeUrl, token, '/api/remote/select', {
        method: 'POST',
        body: { threadId: target.id },
      });
      setRemote(next);
      closeChatSwitcher();
      announce(`Now controlling ${next.selected?.name ?? target.name}.`);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setRemote(previousRemote);
      handleActionError(error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoadingAction(null);
    }
  }, [
    activeThread?.id,
    announce,
    bridgeRequest,
    bridgeUrl,
    closeChatSwitcher,
    handleActionError,
    remote,
    requireBridge,
    token,
  ]);

  const cycleRemoteThread = useCallback(() => {
    if (!remote?.threads.length) return;
    const nextIndex = activeThreadIndex < 0
      ? 0
      : (activeThreadIndex + 1) % remote.threads.length;
    void switchRemoteThread(remote.threads[nextIndex].id);
  }, [activeThreadIndex, remote?.threads, switchRemoteThread]);

  const archiveRemoteThread = useCallback((thread: NonNullable<RemoteState['selected']>) => {
    Alert.alert(
      'Archive this chat?',
      `“${thread.name}” will disappear from Microcodex and the active chats on your Mac. You can recover it from the Codex archive.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            void remoteAction(
              '/api/remote/archive',
              { threadId: thread.id },
              `archive-${thread.id}`,
              `${thread.name} archived.`,
            );
          },
        },
      ],
    );
  }, [remoteAction]);

  const archiveRemoteProject = useCallback((
    project: string,
    projectThreads: NonNullable<RemoteState['selected']>[],
  ) => {
    Alert.alert(
      `Archive “${project}”?`,
      `${projectThreads.length} project chats will be archived. The folder and files on your Mac will not be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive project',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (!requireBridge()) return;
              const actionId = `archive-project-${project}`;
              setLoadingAction(actionId);
              announce(`Archiving ${project}…`);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              try {
                let next: RemoteState | null = null;
                for (const thread of projectThreads) {
                  next = await bridgeRequest<RemoteState>(
                    bridgeUrl,
                    token,
                    '/api/remote/archive',
                    { method: 'POST', body: { threadId: thread.id } },
                  );
                  requireVerifiedCommand(next);
                }
                if (next) setRemote(next);
                announce(`${project} archived.`);
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              } catch (error) {
                handleActionError(error);
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              } finally {
                setLoadingAction(null);
              }
            })();
          },
        },
      ],
    );
  }, [announce, bridgeRequest, bridgeUrl, handleActionError, requireBridge, token]);

  const openKeyEditor = useCallback((slotIndex: number) => {
    if (!keysReady) { announce('请先连接已配对的 Mac 并等待配置加载', true); return; }
    const current = programmedKeys[slotIndex];
    const keycapId =
      current?.keycapId ??
      DEFAULT_MICRO_LAYOUT[slotIndex] ??
      (`EMPT${Math.min(slotIndex + 1, 5)}` as MicroKeycapId);
    setNoticeError(false);
    setEditingSlot(slotIndex);
    setChosenActionId('voicedeck.shortcut');
    setCustomPrompt('');
    setKeyLabel(current?.label ?? '');
    setShortcutKey(current?.action?.type === 'shortcut' ? current.action.key : 'Enter');
    setShortcutModifiers(current?.action?.type === 'shortcut' ? current.action.modifiers : []);
    setActionSearch('');
    void Haptics.selectionAsync();
  }, [programmedKeys, keysReady, announce]);

  const saveProgrammedKey = useCallback(async () => {
    if (editingSlot === null || !chosenAction) return;
    if (chosenAction.custom && !customPrompt.trim()) {
      announce('Write the custom prompt for this key.', true);
      return;
    }
    // Keep keycapId in storage and in the bridge payload for compatibility
    // with existing installations. It is implementation metadata now: the UI
    // always renders the selected command's semantic icon.
    const currentKeycapId =
      programmedKeys[editingSlot]?.keycapId ??
      DEFAULT_MICRO_LAYOUT[editingSlot] ??
      (`EMPT${Math.min(editingSlot + 1, 5)}` as MicroKeycapId);
    let assignedAction: ProgrammedKeyAction;
    if (chosenAction.id === 'voicedeck.shortcut') {
      try { assignedAction = { type: 'shortcut', ...normalizeShortcut({ key: shortcutKey, modifiers: shortcutModifiers }) }; }
      catch (error) { announce(error instanceof Error ? error.message : '按键配置无效', true); return; }
    } else {
      assignedAction = chosenAction.custom ? { type: 'prompt', text: customPrompt.trim() }
        : { type: 'command', commandId: chosenAction.id as ProgrammableCommandId };
    }
    const keycapId = suggestedKeycapForCommand(assignedAction.type === 'command' ? assignedAction.commandId : null) ?? currentKeycapId;
    const nextKeys = programmedKeys.map((key, index) => index === editingSlot
      ? { keycapId, action: assignedAction, ...(keyLabel.trim() ? { label: keyLabel.trim() } : {}) } : key);
    if (!await persistProgrammedKeys(nextKeys)) return;
    setEditingSlot(null);
    announce(`${chosenAction.label} assigned to key ${editingSlot + 1}.`);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [
    announce,
    chosenAction,
    customPrompt,
    editingSlot,
    programmedKeys, keyLabel, shortcutKey, shortcutModifiers, persistProgrammedKeys,
  ]);

  const removeProgrammedKey = useCallback(async (slotIndex: number) => {
    if (!programmedKeys[slotIndex]) return true;
    const nextKeys = programmedKeys.map((key, index) =>
      index === slotIndex ? null : key,
    );
    if (!await persistProgrammedKeys(nextKeys)) return false;
    announce(`Key ${slotIndex + 1} removed and ready to program.`);
    await Haptics.selectionAsync();
    return true;
  }, [announce, programmedKeys, persistProgrammedKeys]);

  const clearProgrammedKey = useCallback(async () => {
    if (editingSlot === null) return;
    if (await removeProgrammedKey(editingSlot)) setEditingSlot(null);
  }, [editingSlot, removeProgrammedKey]);

  const clearAllProgrammedKeys = useCallback(() => {
    if (!programmedKeys.some(Boolean)) return;
    Alert.alert(
      'Clear all programmable keys?',
      'This removes every custom key assignment. The fixed Microdex controls stay unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const nextKeys = programmedKeys.map(() => null);
              if (!await persistProgrammedKeys(nextKeys)) return;
              announce('All programmable keys cleared.');
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            })();
          },
        },
      ],
    );
  }, [announce, programmedKeys, persistProgrammedKeys]);

  const runProgrammedKey = useCallback(async (slotIndex: number) => {
    if (!keysReady || keysSaving) return;
    const action = (programmedKeys[slotIndex] || (slotIndex === 3 ? defaultProgrammedKeys()[3] : null))?.action;
    if (action?.type !== 'shortcut') { openKeyEditor(slotIndex); return; }
    if (sendInFlight.current) return;
    if (slotIndex === 3) {
      sendInFlight.current = true;
      const targetId = keyboardNow.current.target?.id;
      try {
        if (dictationActive) {
          if (!await togglePhoneDictation()) { announce('听写结束未确认，未发送；请检查后重试', true); return; }
          // ponytail: input methods have no shared completion API; allow 350ms to commit trailing text.
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (!targetId || keyboardNow.current.target?.id !== targetId) { announce('输入目标已变化，未发送', true); return; }
        const posted = await keyboardNow.current.press(action);
        flashProgrammedKey(slotIndex, posted ? LED.complete : LED.error);
      } finally { sendInFlight.current = false; }
      return;
    }
    if (dictationActive && (action.key === 'Enter' || action.modifiers.includes('command'))) {
      announce('请先结束讲话，再执行此快捷键', true); return;
    }
    const posted = await genericKeyboard.press(action);
    flashProgrammedKey(slotIndex, posted ? LED.complete : LED.error);
  }, [keysReady, keysSaving, programmedKeys, openKeyEditor, dictationActive, announce, genericKeyboard, flashProgrammedKey, togglePhoneDictation]);

  const sendDraft = useCallback(async () => {
    if (draftSendInFlight.current) return;
    if (!draft.trim()) { announce('请先输入要传到 Mac 的文字。'); return; }
    draftSendInFlight.current = true;
    try {
      // Clear only the acknowledged snapshot; keep edits made while sending.
      if (await genericKeyboard.press(draft)) setDraft(current => current === draft ? '' : current);
    } finally { draftSendInFlight.current = false; }
  }, [draft, announce, genericKeyboard]);

  const removeQueuedMessage = useCallback(async (messageId: string) => {
    if (!requireBridge()) return;
    setLoadingAction(`queue-${messageId}`);
    try {
      const next = await bridgeRequest<{ messageQueue: QueuedMessage[] }>(
        bridgeUrl,
        token,
        '/api/remote/queue/remove',
        {
          method: 'POST',
          body: { messageId },
        },
      );
      setRemote((current) => current ? {
        ...current,
        messageQueue: next.messageQueue,
      } : current);
      announce('Queued message removed.');
      await Haptics.selectionAsync();
    } catch (error) {
      handleActionError(error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoadingAction(null);
    }
  }, [announce, bridgeRequest, bridgeUrl, handleActionError, requireBridge, token]);

  const handleJoystickDirection = useCallback(async (direction: JoystickDirection) => {
    const slot = { up: 6, right: 7, down: 8, left: 9 }[direction];
    if (!keysReady || keysSaving) return;
    const action = programmedKeys[slot]?.action;
    if (action?.type !== 'shortcut') { openKeyEditor(slot); return; }
    await genericKeyboard.press(action, true);
  }, [genericKeyboard, programmedKeys, keysReady, keysSaving, openKeyEditor]);

  const resolveApproval = useCallback(async (decision: 'approve' | 'decline') => {
    if (!requireActionAvailable(decision === 'approve' ? 'APPR' : 'REJ')) return;
    await remoteAction(
      '/api/remote/approval',
      { decision, approval: remote?.pendingApproval ? { requestId: remote.pendingApproval.requestId, threadId: remote.pendingApproval.threadId } : undefined },
      decision === 'approve' ? 'approve' : 'decline',
      decision === 'approve' ? 'Codex request approved.' : 'Codex request declined.',
    );
  }, [remoteAction, requireActionAvailable, remote?.pendingApproval]);

  const forkCurrentTask = useCallback(async () => {
    if (!requireActionAvailable('SPLIT')) return;
    if (!activeThread) {
      announce('Select a Codex task first.', true);
      return;
    }
    await remoteAction(
      '/api/remote/fork',
      { threadId: activeThread.id },
      'fork',
      'Continued in a new Codex task.',
    );
  }, [activeThread, announce, remoteAction, requireActionAvailable]);

  const activityLabel = loadingAction
    ? ACTION_PROGRESS[loadingAction] ?? '正在发送操作'
    : activeMeta.label;
  const statusIcon = STATUS_ICON[activeAgent.status];

  // The deck reports activity in the one selected chat. It is dark at rest:
  // thinking pulses, needs-input/error stay visible, and complete flashes once.
  const micLight: MicLight = dictationActive
    ? 'recording'
    : loadingAction === 'dictation'
      ? 'processing'
      : 'off';
  const persistentStatusLight =
    activeAgent.status === 'thinking' ||
    activeAgent.status === 'waiting' ||
    activeAgent.status === 'error';
  const hardwareActionRunning = Boolean(status) && Boolean(loadingAction);
  const statusLit =
    Boolean(status) &&
    Boolean(activeThread) &&
    Boolean(
      persistentStatusLight ||
      completionLight ||
      hardwareActionRunning ||
      hardwareFeedbackColor,
    );
  const ledColor = micLight !== 'off'
    ? LED_RECORDING
    : hardwareFeedbackColor
      ?? (hardwareActionRunning
        ? LED.thinking
        : completionLight
          ? LED.complete
          : LED[activeAgent.status]);
  const deckLightsOn = statusLit || (Boolean(status) && micLight !== 'off');
  const deckLightPulses =
    hardwareActionRunning ||
    (statusLit && hardwareFeedbackColor == null && activeAgent.status === 'thinking');

  const renderProgrammedKey = (slotIndex: number) => {
    const programmed = programmedKeys[slotIndex] || (slotIndex === 3 ? defaultProgrammedKeys()[3] : null);
    const shortcut = programmed?.action?.type === 'shortcut' ? programmed.action : null;
    const labels: Record<string, string> = { Escape: 'Esc', Backspace: '⌫', Enter: '↵', Tab: '⇥', Home: '↖', End: '↘' };
    return <HardwareKey accessibilityLabel={slotIndex === 3 ? '发送' : programmed?.label || `自定义键 ${slotIndex + 1}`}
      caption={slotIndex === 3 ? '发送' : programmed?.label || (shortcut ? shortcut.key : '设置')}
      symbol={<Text style={{ color: skeuo.icon, fontSize: 24 }}>{shortcut ? labels[shortcut.key] || shortcut.key : '+'}</Text>}
      glowColor={keyResultLights[slotIndex]} disabled={!keysReady || keysSaving || genericKeyboard.busy}
      onPress={() => void runProgrammedKey(slotIndex)} onLongPress={() => openKeyEditor(slotIndex)} />;
  };


  const manualPairingSection = (
    <View style={styles.settingsGroup}>
      <Pressable accessibilityRole="button" accessibilityLabel="手动输入配对信息"
        onPress={() => setManualPairingOpen(value => !value)} style={styles.gateSecondaryButton}>
        <Text style={styles.gateSecondaryButtonText}>手动输入配对信息</Text>
      </Pressable>
      {manualPairingOpen ? <>
        <Text style={styles.gateNote}>在 Mac 客户端展开“使用配对文本”，将完整内容复制到这里；仍需在 Mac 确认。</Text>
        <TextInput accessibilityLabel="限时配对信息" value={manualPairingText} onChangeText={setManualPairingText}
          autoCapitalize="none" autoCorrect={false} multiline maxLength={4096} editable={!manualPairingBusy}
          style={[styles.settingsLinkMeta, { borderWidth: 1, borderColor: theme.border, padding: 12, minHeight: 88 }]}
          placeholder="粘贴 Mac 提供的完整配对信息" placeholderTextColor={theme.textFaint} />
        <Pressable accessibilityRole="button" accessibilityLabel="使用配对信息连接"
          disabled={manualPairingBusy || !manualPairingText.trim()} style={styles.gatePrimaryButton}
          onPress={() => void (async () => {
            if (manualPairingBusy) return;
            try {
              const payload = parsePairingUrl(manualPairingText);
              if (!payload.code || !payload.e2ee) throw new Error('需要限时加密配对信息');
            } catch { announce('配对信息无效，请完整复制 Mac 客户端提供的内容。', true); return; }
            setManualPairingBusy(true);
            try {
              if (await claimPairingCode(manualPairingText)) { setManualPairingText(''); setManualPairingOpen(false); }
            } finally { setManualPairingBusy(false); }
          })()}><Text style={styles.gatePrimaryButtonText}>{manualPairingBusy ? '等待 Mac 确认…' : '连接 Mac'}</Text></Pressable>
      </> : null}
    </View>
  );

  return (
      <View style={styles.screen}>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        {!status ? null : (
          <>
            <View style={styles.ambientBlue} />
            <View style={styles.ambientGreen} />
          </>
        )}
        {!status ? (
          <View style={styles.connectionGate}>
            <ScrollView
              style={styles.screenBody}
              contentContainerStyle={[
                styles.connectionGateContent,
                {
                  paddingTop: Math.max(insets.top + 32, 56),
                  paddingBottom: Math.max(insets.bottom, 24),
                },
              ]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {credentialLoadError ? (
                <View style={styles.gateContent}>
                  <Text style={styles.gateStateTitle}>暂时无法读取配对信息</Text>
                  <Text style={styles.gateStateBody}>保存的数据未被删除。请解锁手机后重试；若数据已损坏，也可以重新配对 Mac。</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="重试读取配对信息"
                    onPress={() => { setCredentialLoadError(false); setCredentialLoadAttempt(value => value + 1); }}
                    style={styles.gatePrimaryButton}><Text style={styles.gatePrimaryButtonText}>重试读取</Text></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="改为重新配对"
                    onPress={() => { credentialRejected.current = true; setCredentialLoadError(false); setCredentialsReady(true); }}
                    style={styles.gateSecondaryButton}><Text style={styles.gateSecondaryButtonText}>重新配对 Mac</Text></Pressable>
                </View>
              ) : !credentialsReady || (bridgeConnecting && Boolean(token.trim())) ? (
                <View style={[styles.gateContent, styles.gateContentCentered]}>
                  <ActivityIndicator size="small" color={theme.textMuted} />
                  <Text style={styles.gateStateTitle}>
                    {credentialsReady ? '正在连接 Mac' : '正在打开NoKey'}
                  </Text>
                  <Text style={styles.gateStateBody}>
                    {credentialsReady
                      ? '正在检查与 Mac 的加密连接。'
                      : '正在读取保存的配对信息。'}
                  </Text>
                </View>
              ) : token.trim() ? (
                <View style={styles.gateContent}>
                  <View style={styles.gateHero}>
                    <Text style={styles.gateTitle}>Mac 暂时无法连接</Text>
                    <Text style={styles.gateTitleMono}>请检查连接</Text>
                  </View>
                  <Text style={styles.gateNote}>
                    请唤醒 Mac 并打开“NoKey”客户端。异网连接还需要 Mac 上的国内服务可用。
                  </Text>

                  <Pressable
                    accessibilityRole="button"
                    disabled={bridgeConnecting}
                    onPress={() => void connectToBridge(bridgeUrl, token, true)}
                    style={({ pressed }) => [
                      styles.gatePrimaryButton,
                      pressed && styles.gateButtonPressed,
                    ]}>
                    {bridgeConnecting ? (
                      <ActivityIndicator size="small" color={theme.bg} />
                    ) : (
                      <CentralIcon name="refresh" size={17} color={theme.bg} />
                    )}
                    <Text style={styles.gatePrimaryButtonText}>重新连接</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void openPairingScanner()}
                    style={({ pressed }) => [
                      styles.gateSecondaryButton,
                      pressed && styles.gateButtonPressed,
                    ]}>
                    <CentralIcon name="qrCode" size={17} color={theme.text} />
                    <Text style={styles.gateSecondaryButtonText}>配对其他 Mac</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void forgetPairedMac()}
                    style={({ pressed }) => [
                      styles.gateTertiaryButton,
                      pressed && styles.gateButtonPressed,
                    ]}>
                    <Text style={styles.gateTertiaryButtonText}>移除此 Mac</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.gateContent}>
                  <View style={styles.gateHero}>
                    <Text style={styles.gateTitle}>NoKey</Text>
                    <Text style={styles.gateTitleMono}>连接你的 Mac</Text>
                  </View>

                  <View style={styles.gateSteps}>
                    <View style={styles.gateStep}>
                      <Text style={styles.gateStepMarker}>01</Text>
                      <View style={styles.gateStepCopy}>
                        <Text style={styles.gateStepTitle}>安装 Mac 配套客户端</Text>
                        <Text style={styles.gateStepBody}>
                          在 Mac 安装“NoKey”配套安装包，按向导重启并打开客户端。无需另装 Node 或音频路由软件。
                        </Text>
                      </View>
                    </View>

                    <View style={styles.gateStep}>
                      <Text style={styles.gateStepMarker}>02</Text>
                      <View style={styles.gateStepCopy}>
                        <Text style={styles.gateStepTitle}>扫码并确认配对</Text>
                        <Text style={styles.gateStepBody}>
                          扫描 Mac 客户端显示的限时二维码，并在 Mac 允许这台手机连接。
                        </Text>
                      </View>
                    </View>

                    <View style={[styles.gateStep, styles.gateStepLast]}>
                      <Text style={styles.gateStepMarker}>03</Text>
                      <View style={styles.gateStepCopy}>
                        <Text style={styles.gateStepTitle}>开始讲话与快捷操作</Text>
                        <Text style={styles.gateStepBody}>
                          在 Mac 选择“NoKey麦克风”，然后在手机点开始讲话。六个快捷槽可按需配置。
                        </Text>

                        <View style={styles.gateKeyPreview}>
                          {[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => (
                            <View
                              key={slot}
                              style={[
                                styles.gatePreviewKey,
                                slot === 4 && styles.gatePreviewDial,
                              ]}
                            />
                          ))}
                        </View>
                      </View>
                    </View>
                  </View>

                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void openPairingScanner()}
                    style={({ pressed }) => [
                      styles.gatePrimaryButton,
                      pressed && styles.gateButtonPressed,
                    ]}>
                    <CentralIcon name="qrCode" size={17} color={theme.bg} />
                    <Text style={styles.gatePrimaryButtonText}>扫描配对二维码</Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Explore Microdex without a Mac"
                    onPress={() => void enterDemo()}
                    style={({ pressed }) => [
                      styles.gateDemoButton,
                      pressed && styles.gateButtonPressed,
                    ]}>
                    <MaterialCommunityIcons name="play-outline" size={15} color={theme.textMuted} />
                    <Text style={styles.gateDemoButtonText}>先查看面板</Text>
                  </Pressable>

                  <Text style={styles.gateFootnote}>
                    手机与 Mac 可异网使用，需配置可用的国内连接服务。麦克风与通用快捷键不依赖 Codex。
                  </Text>
                </View>
              )}
              {credentialsReady && !credentialLoadError ? manualPairingSection : null}
              {noticeError ? <Text accessibilityLiveRegion="polite" style={[styles.gateNote, { color: theme.dangerText }]}>{notice}</Text> : null}
            </ScrollView>
          </View>
        ) : (
        <>
        <View style={styles.screenBody}>
        <ScrollView
          ref={mainScrollRef}
          style={styles.screenBody}
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingTop: Math.max(insets.top, 12),
              paddingBottom: Math.max(insets.bottom, 18),
            },
          ]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={{ color: status ? theme.online : theme.textMuted, fontSize: 14 }}>{status ? '● Mac 已连接' : '○ Mac 未连接'}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="打开 NoKey 设置"
            onPress={() => setSettingsVisible(true)} style={styles.statusButton}>
            <CentralIcon name="settings" size={20} color={theme.text} />
          </Pressable>
        </View>
        <View style={styles.deviceGlow}>
          <View style={styles.device}>
            <View style={[styles.hardwareArea, !status && styles.hardwareOffline]}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 2, gap: 10 }}>
                  {[0, 1].map(row => <View key={row} style={{ flexDirection: 'row', gap: 10 }}>
                    {([['全选', 'A', 'select-all'], ['复制', 'C', 'content-copy'], ['粘贴', 'V', 'content-paste'], ['撤销', 'Z', 'undo']] as const).slice(row * 2, row * 2 + 2).map(([label, key, icon]) =>
                      <View key={key} style={{ flex: 1, aspectRatio: 1 }}>
                        <HardwareKey accessibilityLabel={label} caption={label} symbol={<Text style={{ color: theme.text, fontSize: 25 }}>{key}</Text>}
                          disabled={genericKeyboard.busy} onPress={() => void genericKeyboard.press({ key, modifiers: ['command'] })} />
                      </View>)}
                  </View>)}
                </View>
                <View style={{ flex: 1, gap: 10, justifyContent: 'space-around' }}>
                  <View style={{ width: '100%', aspectRatio: 1 }}>
                    <ReasoningDial mode="composer-navigation" label="旋转移动" index={0} maxIndex={1}
                      onPreview={() => {}} onCommit={() => {}} onLongPress={() => setSettingsVisible(true)}
                      onStep={genericKeyboard.moveCursor}
                      onPress={() => { if (dictationActive) announce('请先结束讲话', true); else void genericKeyboard.press({ key: 'Enter', modifiers: [] }); }} />
                  </View>
                  <View style={{ width: '100%', aspectRatio: 1 }}><Joystick onDirection={direction => void handleJoystickDirection(direction)} onConfigure={direction => openKeyEditor({ up: 6, right: 7, down: 8, left: 9 }[direction])} labels={{ up: programmedKeys[6]?.label, right: programmedKeys[7]?.label, down: programmedKeys[8]?.label, left: programmedKeys[9]?.label }} /></View>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                {[0, 1, 2, 4, 5].map(index => <View key={index} style={{ flex: 1, height: 66 }}>{renderProgrammedKey(index)}</View>)}
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1, height: 66 }}>
                  <HardwareKey accessibilityLabel="切换应用，长按切换窗口" caption="切换应用" icon="application-outline"
                    onPress={() => { if (dictationActive) announce('请先结束讲话，再切换应用', true); else void genericKeyboard.press({ key: 'Tab', modifiers: ['command'] }); }}
                    onLongPress={() => { if (dictationActive) announce('请先结束讲话，再切换窗口', true); else void genericKeyboard.press({ key: '`', modifiers: ['command'] }); }} />
                </View>
                <View style={{ flex: 1, height: 66 }}>{renderProgrammedKey(3)}</View>
              </View>
            </View>
          </View>
        </View>
        <View style={{ height: 76, marginBottom: 8 }}>
          <HardwareKey accessibilityLabel={dictationActive ? '结束讲话' : '开始讲话'}
            symbol={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><MaterialCommunityIcons name="microphone" size={23} color={dictationActive ? '#356B53' : theme.text} /><Text style={{ color: dictationActive ? '#356B53' : theme.text, fontSize: 16, fontWeight: '600' }}>{dictationEnding ? '正在结束…' : dictationActive ? '正在讲话 · 点击结束' : '点击讲话'}</Text></View>} disabled={dictationEnding}
            active={dictationActive} flatTint
            onPress={() => void togglePhoneDictation()} />
        </View>
        <View style={{ minHeight: 44, paddingHorizontal: 6, paddingBottom: 8, gap: 3 }} accessibilityLiveRegion="polite">
          <Text style={{ color: noticeError ? theme.dangerText : theme.textMuted, fontSize: 12 }}>
            {phoneMicrophone.telemetry.inputError || (noticeError && notice ? notice : dictationLinked && dictationActive ? '正在讲话 · 再点长条结束' : phoneMicrophone.message || genericKeyboard.message)}
          </Text>
          {!!genericKeyboard.result && <Text style={{ color: theme.textMuted, fontSize: 12 }}>{genericKeyboard.result}</Text>}
        </View>

        {composerVisible ? (
        <View style={styles.composerPanel}>
          <Text style={{ color: theme.textMuted, fontSize: 12 }}>填入到：{genericKeyboard.target?.name || '等待 Mac 输入目标'}</Text>
          <View style={styles.composerBox}>
            <CentralIcon
              name="chat"
              size={18}
              color={theme.textFaint}
              style={styles.composerLeadingIcon}
            />
            <TextInput
              ref={composerRef}
              autoCapitalize="sentences"
              multiline
              value={draft}
              onChangeText={setDraft}
              placeholder={status ? '在这里输入，传到 Mac 光标处…' : '连接 Mac 后输入内容'}
              placeholderTextColor={theme.textFaint}
              editable={Boolean(status)}
              style={styles.composerInput}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="输入到 Mac"
              disabled={!status || !draft.trim() || loadingAction === 'send' || genericKeyboard.busy}
              onPress={() => void sendDraft()}
              style={({ pressed }) => [
                styles.sendButton,
                (!status || !draft.trim() || loadingAction === 'send') && styles.sendButtonDisabled,
                pressed && styles.sendButtonPressed,
              ]}>
              {loadingAction === 'send' ? (
                <ActivityIndicator size="small" color={theme.accentText} />
              ) : (
                <Text style={{ color: theme.accentText, fontSize: 13 }}>填入</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.composerFooter}>
            <Text style={styles.composerMeta}>
              填入成功后清空 · 不自动提交
            </Text>
            <View style={styles.composerRoute}>
              <CentralIcon name="output" size={12} color={theme.textFaint} />
              <Text style={styles.composerMeta}>结果显示在 Mac</Text>
            </View>
          </View>

          {noticeError ? (
            <View style={[styles.notice, styles.noticeError, styles.composerNotice]}>
              <CentralIcon name="alert" size={16} color={theme.dangerText} />
              <Text style={[styles.noticeText, styles.noticeTextError]}>{notice}</Text>
            </View>
          ) : null}
        </View>
        ) : null}
      </ScrollView>
        </View>

        </>
        )}

      <Modal visible={pairingTarget !== null} transparent animationType="fade" onRequestClose={() => finishPairingDecision(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { padding: 24, paddingBottom: Math.max(insets.bottom, 24) }]}>
            <Text style={styles.sheetTitle}>确认要连接的 Mac</Text>
            <Text selectable style={styles.infoParagraph}>{pairingTarget?.name}</Text>
            <Text selectable style={styles.infoParagraph}>{pairingTarget?.address}</Text>
            <Text style={styles.infoParagraph}>名称来自配对邀请，请与 Mac 核对；继续后仍需在 Mac 上授权。</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="确认连接此 Mac" style={styles.gatePrimaryButton} onPress={() => finishPairingDecision(true)}>
              <Text style={styles.gatePrimaryButtonText}>继续配对</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="取消此次配对" style={styles.gatePrimaryButton} onPress={() => finishPairingDecision(false)}>
              <Text style={styles.gatePrimaryButtonText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={keyManagerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyManagerVisible(false)}>
        <GestureHandlerRootView style={styles.modalGestureRoot}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setKeyManagerVisible(false)} />
          <DismissibleSheet
            open={keyManagerVisible}
            onDismiss={() => setKeyManagerVisible(false)}
            style={[
              styles.sheet,
              styles.keyManagerSheet,
              { paddingBottom: Math.max(insets.bottom, 18) + 12 },
            ]}
            header={
              <>
                <SheetHandlePill color={theme.borderStrong} />
                <View style={styles.sheetTitleRow}>
                  <View>
                    <Text style={styles.sheetKicker}>YOUR MICRODEX</Text>
                    <Text style={styles.sheetTitle}>Customize keys</Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Close key manager"
                    onPress={() => setKeyManagerVisible(false)}
                    style={styles.closeButton}>
                    <CentralIcon name="close" size={20} color={theme.text} />
                  </Pressable>
                </View>
              </>
            }>
            <Text style={styles.sheetBody}>
              Choose an empty key or replace an existing one. Use the trash button to remove an
              assignment and turn it back into an empty programmable key.
            </Text>
            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.keyManagerGrid}>
              {programmedKeys.map((programmed, slotIndex) => {
                const actionId = programmedActionId(programmed);
                const action = findMicroAction(actionId);
                return (
                  <View key={slotIndex} style={styles.keyManagerCard}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        action
                          ? `Change key ${slotIndex + 1}, currently ${programmed?.label || action.label}`
                          : `Choose action for key ${slotIndex + 1}`
                      }
                      onPress={() => {
                        setKeyManagerVisible(false);
                        openKeyEditor(slotIndex);
                      }}
                      style={({ pressed }) => [
                        styles.keyManagerChoice,
                        pressed && styles.actionCardPressed,
                      ]}>
                      <View style={[styles.keyManagerIcon, !action && styles.keyManagerIconEmpty]}>
                        {actionId ? (
                          <CodexCommandGlyph
                            actionId={actionId}
                            size={24}
                            color={action ? theme.text : theme.blue}
                          />
                        ) : (
                          <CentralIcon name="plus" size={24} color={theme.blue} />
                        )}
                      </View>
                      <Text style={styles.keyManagerSlot}>{slotIndex >= 6 ? `摇杆 · ${['上', '右', '下', '左'][slotIndex - 6]}` : `KEY ${slotIndex + 1}`}</Text>
                      <Text adjustsFontSizeToFit minimumFontScale={0.72} numberOfLines={1} style={styles.keyManagerLabel}>
                        {programmed?.label || action?.label || (programmed ? 'Choose command' : 'Choose action')}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove key ${slotIndex + 1}`}
                      disabled={!programmed}
                      onPress={() => void removeProgrammedKey(slotIndex)}
                      style={({ pressed }) => [
                        styles.removeKeyButton,
                        !programmed && styles.removeKeyButtonDisabled,
                        pressed && styles.removeKeyButtonPressed,
                      ]}>
                      <CentralIcon name="trash" size={16} color={theme.danger} />
                      <Text style={styles.removeKeyText}>REMOVE</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
            <Pressable accessibilityRole="button" accessibilityLabel="恢复默认快捷键"
              disabled={!keysReady || keysSaving}
              onPress={() => void (async () => {
                if (await persistProgrammedKeys(defaultProgrammedKeys())) announce('已恢复当前设备的默认快捷键');
              })()} style={styles.clearAllKeysButton}>
              <Text style={styles.clearAllKeysText}>恢复默认快捷键</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear all programmable keys"
              disabled={!programmedKeys.some(Boolean)}
              onPress={clearAllProgrammedKeys}
              style={({ pressed }) => [
                styles.clearAllKeysButton,
                !programmedKeys.some(Boolean) && styles.clearAllKeysButtonDisabled,
                pressed && styles.removeKeyButtonPressed,
              ]}>
              <CentralIcon name="trash" size={17} color={theme.danger} />
              <Text style={styles.clearAllKeysText}>CLEAR ALL</Text>
            </Pressable>
          </DismissibleSheet>
        </View>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={editingSlot !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingSlot(null)}>
        <GestureHandlerRootView style={styles.modalGestureRoot}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditingSlot(null)} />
          <DismissibleSheet
            open={editingSlot != null}
            onDismiss={() => setEditingSlot(null)}
            style={[
              styles.sheet,
              styles.catalogSheet,
              { paddingBottom: Math.max(insets.bottom, 14) + 8 },
            ]}
            header={
              <>
                <SheetHandlePill color={theme.borderStrong} />
                <View style={styles.sheetTitleRow}>
                  <View>
                    <Text style={styles.sheetKicker}>快捷键配置</Text>
                    <Text style={styles.sheetTitle}>
                      {editingSlot !== null && editingSlot >= 6 ? `摇杆 · ${['上', '右', '下', '左'][editingSlot - 6]}` : `编辑第 ${editingSlot === null ? '' : editingSlot + 1} 个快捷键`}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Close key catalog"
                    onPress={() => setEditingSlot(null)}
                    style={styles.closeButton}>
                    <CentralIcon name="close" size={20} color={theme.text} />
                  </Pressable>
                </View>
              </>
            }>
            <Text style={styles.sheetBody}>
              设置通用快捷键，发送到 Mac 当前应用。摇杆四个方向可以分别设置。
            </Text>
            <View style={styles.searchWrap}>
              <CentralIcon name="search" size={18} color={theme.textFaint} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                value={actionSearch}
                onChangeText={setActionSearch}
                placeholder="搜索快捷键"
                placeholderTextColor={theme.textFaint}
                style={styles.searchInput}
              />
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.actionCatalog}>
              {filteredActions.map((action) => {
                const selected = chosenActionId === action.id;
                return (
                  <Pressable
                    key={action.id}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setChosenActionId(action.id);
                      if (!action.custom) setCustomPrompt('');
                      void Haptics.selectionAsync();
                    }}
                    style={({ pressed }) => [
                      styles.actionRow,
                      pressed && styles.actionRowPressed,
                    ]}>
                    <View style={styles.actionRowIcon}>
                      <CodexCommandGlyph
                        actionId={action.id}
                        size={21}
                        color={selected ? theme.text : theme.textMuted}
                      />
                    </View>
                    <View style={styles.actionCopy}>
                      <View style={styles.actionTitleRow}>
                        <Text
                          style={[styles.actionTitle, selected && styles.actionTitleSelected]}
                          numberOfLines={1}>
                          {action.label}
                        </Text>
                        <Text style={styles.actionCategory}>{action.category}</Text>
                      </View>
                      <Text style={styles.actionDescription} numberOfLines={1}>
                        {action.description}
                      </Text>
                    </View>
                    <View style={styles.actionCheck}>
                      {selected ? (
                        <CentralIcon name="check" size={18} color={theme.text} />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            {editingSlot !== null && editingSlot >= 6 && <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}>
              {['上', '右', '下', '左'].map((label, index) => <Pressable key={label} accessibilityRole="button"
                accessibilityLabel={`配置摇杆${label}`} accessibilityState={{ selected: editingSlot === index + 6 }}
                disabled={keysSaving} onPress={() => openKeyEditor(index + 6)}
                style={[styles.clearButton, editingSlot === index + 6 && { borderColor: theme.blue, borderWidth: 1 }]}>
                <Text style={styles.clearButtonText}>{label}</Text>
              </Pressable>)}
            </View>}
            <TextInput accessibilityLabel="快捷键显示名称" maxLength={24} value={keyLabel}
              onChangeText={setKeyLabel} placeholder="显示名称（可选）" placeholderTextColor={theme.textFaint} style={[styles.input, { minHeight: 44, flexShrink: 0 }]} />
            {chosenAction?.id === 'voicedeck.shortcut' && <View style={{ gap: 8, marginVertical: 8 }}>
              <Text style={styles.sheetBody}>组合键：{[...shortcutModifiers, shortcutKey].join(' + ')}（Mac 物理键位）</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {(Object.keys(MODIFIER_FLAGS) as ShortcutModifier[]).map(modifier => <Pressable key={modifier}
                  accessibilityRole="button" accessibilityLabel={`修饰键 ${modifier}`}
                  accessibilityState={{ selected: shortcutModifiers.includes(modifier) }}
                  onPress={() => setShortcutModifiers(current => current.includes(modifier) ? current.filter(item => item !== modifier) : [...current, modifier])}
                  style={[styles.clearButton, shortcutModifiers.includes(modifier) && { borderColor: theme.blue, borderWidth: 1 }]}>
                  <Text style={styles.clearButtonText}>{shortcutModifiers.includes(modifier) ? '✓ ' : ''}{modifier}</Text>
                </Pressable>)}
              </View>
              <ScrollView horizontal keyboardShouldPersistTaps="handled" style={{ maxHeight: 52 }}>
                {Object.keys(KEY_CODES).map(key => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`主键 ${key}`}
                  accessibilityState={{ selected: shortcutKey === key }} onPress={() => setShortcutKey(key)}
                  style={[styles.clearButton, { marginRight: 6 }, shortcutKey === key && { borderColor: theme.blue, borderWidth: 1 }]}>
                  <Text style={styles.clearButtonText}>{shortcutKey === key ? '✓ ' : ''}{key}</Text>
                </Pressable>)}
              </ScrollView>
            </View>}
            {chosenAction?.custom ? (
              <TextInput
                autoCapitalize="sentences"
                multiline
                value={customPrompt}
                onChangeText={setCustomPrompt}
                placeholder="Example: Review the current changes and fix the tests."
                placeholderTextColor={theme.textFaint}
                style={[styles.input, styles.customPromptInput]}
              />
            ) : null}
            {noticeError && <Text style={styles.sheetBody} accessibilityLiveRegion="polite">{notice}</Text>}
            <View style={styles.editorButtons}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void clearProgrammedKey()}
                style={({ pressed }) => [styles.clearButton, pressed && styles.guideButtonPressed]}>
                <CentralIcon name="trash" size={18} color={theme.textMuted} />
                <Text style={styles.clearButtonText}>CLEAR</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="保存快捷键"
                disabled={!chosenAction || !keysReady || keysSaving}
                onPress={() => void saveProgrammedKey()}
                style={({ pressed }) => [
                  styles.saveKeyButton,
                  !chosenAction && styles.saveKeyButtonDisabled,
                  pressed && styles.connectButtonPressed,
                ]}>
                <Text style={styles.connectButtonText}>{keysSaving ? '保存中…' : '保存快捷键'}</Text>
                <CentralIcon name="check" size={20} color={theme.accentText} />
              </Pressable>
            </View>
          </DismissibleSheet>
        </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={guideVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setGuideVisible(false)}>
        <GestureHandlerRootView style={styles.modalGestureRoot}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setGuideVisible(false)} />
          <DismissibleSheet
            open={guideVisible}
            onDismiss={() => setGuideVisible(false)}
            style={[
              styles.sheet,
              styles.guideSheet,
              { paddingBottom: Math.max(insets.bottom, 14) + 8 },
            ]}
            header={
              <>
                <SheetHandlePill color={theme.borderStrong} />
                <View style={styles.sheetTitleRow}>
                  <View>
                    <Text style={styles.sheetKicker}>通用快捷键</Text>
                    <Text style={styles.sheetTitle}>操作说明</Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Close key guide"
                    onPress={() => setGuideVisible(false)}
                    style={styles.closeButton}>
                    <CentralIcon name="close" size={20} color={theme.text} />
                  </Pressable>
                </View>
              </>
            }>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.guideContent}>
              <GuideItem styles={styles} theme={theme} icon="microphone" title="讲话与结束" body="长条点一次开始，再点一次结束。结束后核对电脑文字，点发送提交。" />
              <GuideItem styles={styles} theme={theme} icon="keyboard-outline" title="通用键盘" body="按键作用于 Mac 当前输入位置。长按功能键可以配置系统快捷键；填入文字不会自动提交。" />
              <GuideItem styles={styles} theme={theme} icon="gamepad-round-outline" title="光标和窗口" body="摇杆发送方向键；旋钮左右移动光标，按下回车。切换应用键点击切到上一个应用，长按切换同一应用的窗口。" />
            </ScrollView>
          </DismissibleSheet>
        </View>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={settingsVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsVisible(false)}>
        <GestureHandlerRootView style={styles.modalGestureRoot}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSettingsVisible(false)} />
          <DismissibleSheet
            open={settingsVisible}
            onDismiss={() => setSettingsVisible(false)}
            style={[styles.sheet, styles.settingsSheet, { paddingBottom: Math.max(insets.bottom, 18) + 12 }]}
            header={
              <>
                <SheetHandlePill color={theme.borderStrong} />
                <View style={styles.sheetTitleRow}>
                  <Text style={styles.sheetTitle}>Settings</Text>
                  <Pressable
                    accessibilityLabel="Close settings"
                    onPress={() => setSettingsVisible(false)}
                    style={styles.closeButton}>
                    <CentralIcon name="close" size={18} color={theme.text} />
                  </Pressable>
                </View>
              </>
            }>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={styles.settingsContent}>
              <View style={styles.settingsGroup}>
                <Text style={styles.settingsGroupLabel}>麦克风音量</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {[{ label: '减小音量', step: -0.25, title: '−' }, { label: '增大音量', step: 0.25, title: '+' }].map(button => {
              const disabled = phoneMicrophone.gainBusy || phoneMicrophone.gain + button.step < 0 || phoneMicrophone.gain + button.step > 4;
              return <Pressable key={button.label} accessibilityRole="button" accessibilityLabel={button.label}
                accessibilityState={{ disabled }} disabled={disabled}
                onPress={() => void phoneMicrophone.changeGain(phoneMicrophone.gain + button.step)}
                style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}>
                <Text style={{ color: theme.text, fontSize: 24 }}>{button.title}</Text>
              </Pressable>;
            })}
            <Text style={{ color: theme.text }}>输入音量 {Math.round(phoneMicrophone.gain * 100)}%{phoneMicrophone.gain === 0 ? '（静音）' : ''}</Text>
          </View>
          {!!phoneMicrophone.gainMessage && <Text style={{ color: theme.textMuted }} accessibilityLiveRegion="polite">{phoneMicrophone.gainMessage}</Text>}
              </View>
              <View style={styles.settingsGroup}>
                <Text style={styles.settingsGroupLabel}>配对</Text>
                {status ? manualPairingSection : null}
                <Text style={styles.settingsLinkMeta}>在 Mac 打开“NoKey”客户端，扫描其中的配对二维码，并在 Mac 确认。</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Scan computer pairing QR"
                  onPress={() => void openPairingScanner()}
                  style={({ pressed }) => [
                    styles.settingsPrimaryButton,
                    pressed && styles.gateButtonPressed,
                  ]}>
                  <CentralIcon name="qrCode" size={16} color={theme.bg} />
                  <Text style={styles.settingsPrimaryButtonText}>扫描配对二维码</Text>
                </Pressable>
                {noticeError ? (
                  <View style={[styles.notice, styles.noticeError]}>
                    <CentralIcon name="alert" size={16} color={theme.dangerText} />
                    <Text style={[styles.noticeText, styles.noticeTextError]}>{notice}</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.settingsGroup}>
                <Text style={styles.settingsGroupLabel}>Appearance</Text>
                <View style={styles.themeSegment}>
                  {(['light', 'dark'] as const).map((option) => {
                    const active = mode === option;
                    return (
                      <Pressable
                        key={option}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => {
                          setMode(option);
                          void Haptics.selectionAsync();
                        }}
                        style={[styles.themeSegmentOption, active && styles.themeSegmentOptionActive]}>
                        <CentralIcon
                          name={option === 'dark' ? 'moon' : 'sun'}
                          size={15}
                          color={active ? theme.text : theme.textMuted}
                        />
                        <Text style={[styles.themeSegmentText, active && styles.themeSegmentTextActive]}>
                          {option === 'dark' ? 'Dark' : 'Light'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.settingsGroup}>
                <Text style={styles.settingsGroupLabel}>Controller</Text>
                <Text style={styles.settingsLinkMeta}>旋钮左右移动光标，按下回车；摇杆发送方向键。</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setSettingsVisible(false);
                    setKeyManagerVisible(true);
                  }}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <Text style={styles.settingsLinkTitle}>Customize keys</Text>
                  <CentralIcon name="chevronRight" size={18} color={theme.textFaint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setSettingsVisible(false);
                    setGuideVisible(true);
                  }}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <Text style={styles.settingsLinkTitle}>Controls guide</Text>
                  <CentralIcon name="chevronRight" size={18} color={theme.textFaint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Copy diagnostic report"
                  onPress={() => void copyDiagnostics()}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <Text style={styles.settingsLinkTitle}>Copy diagnostics</Text>
                  <CentralIcon name="copy" size={16} color={theme.textFaint} />
                </Pressable>
              </View>

              <View style={styles.settingsGroup}>
                <Text style={styles.settingsGroupLabel}>Offline Experience</Text>
                <Text style={styles.settingsSupportingText}>
                  The offline preview runs entirely on this device with fictional tasks. It never contacts a Mac, Cloudflare or OpenAI.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void (demoMode ? exitDemo() : enterDemo())}
                  style={({ pressed }) => [
                    styles.settingsLinkRow,
                    pressed && styles.settingsLinkRowPressed,
                  ]}>
                  <Text style={styles.settingsLinkTitle}>
                    {demoMode ? 'Exit offline preview' : '先查看面板'}
                  </Text>
                  <MaterialCommunityIcons
                    name={demoMode ? 'exit-to-app' : 'play-outline'}
                    size={18}
                    color={theme.textFaint}
                  />
                </Pressable>
                {demoMode ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={leaveDemoAndPair}
                    style={({ pressed }) => [
                      styles.settingsLinkRow,
                      pressed && styles.settingsLinkRowPressed,
                    ]}>
                    <Text style={styles.settingsLinkTitle}>Pair a real Mac</Text>
                    <CentralIcon name="qrCode" size={16} color={theme.textFaint} />
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.settingsGroup}>
                <Text style={styles.settingsGroupLabel}>隐私与帮助</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => showInfoSheet('privacy')}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <Text style={styles.settingsLinkTitle}>隐私说明</Text>
                  <CentralIcon name="chevronRight" size={18} color={theme.textFaint} />
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  onPress={() => showInfoSheet('support')}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <Text style={styles.settingsLinkTitle}>使用帮助</Text>
                  <CentralIcon name="chevronRight" size={18} color={theme.textFaint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => showInfoSheet('licenses')}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <Text style={styles.settingsLinkTitle}>Licenses & Attributions</Text>
                  <CentralIcon name="chevronRight" size={18} color={theme.textFaint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => showInfoSheet('about')}
                  style={({ pressed }) => [styles.settingsLinkRow, pressed && styles.settingsLinkRowPressed]}>
                  <View>
                    <Text style={styles.settingsLinkTitle}>关于NoKey</Text>
                    <Text style={styles.settingsLinkMeta}>
                      Version {appInfo.version} ({appInfo.buildNumber})
                    </Text>
                  </View>
                  <CentralIcon name="chevronRight" size={18} color={theme.textFaint} />
                </Pressable>
              </View>

              {!demoMode ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void forgetPairedMac()}
                  style={({ pressed }) => [
                    styles.settingsDangerLink,
                    pressed && styles.gateButtonPressed,
                  ]}>
                  <Text style={styles.settingsDangerLinkText}>Forget this Mac and consent</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </DismissibleSheet>
        </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={consentVisible}
        transparent
        animationType="fade"
        onRequestClose={declineAiConsent}>
        <GestureHandlerRootView style={styles.modalGestureRoot}>
          <View style={styles.modalBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={declineAiConsent} />
            <DismissibleSheet
              open={consentVisible}
              onDismiss={declineAiConsent}
              style={[
                styles.sheet,
                styles.consentSheet,
                { paddingBottom: Math.max(insets.bottom, 18) + 12 },
              ]}
              header={
                <>
                  <SheetHandlePill color={theme.borderStrong} />
                  <View style={styles.sheetTitleRow}>
                    <View style={styles.consentTitleCopy}>
                      <Text style={styles.sheetKicker}>YOUR DATA, YOUR CHOICE</Text>
                      <Text style={styles.sheetTitle}>Codex 操作如何处理内容</Text>
                    </View>
                    <Pressable
                      accessibilityLabel="Close data processing information"
                      onPress={declineAiConsent}
                      style={styles.closeButton}>
                      <CentralIcon name="close" size={19} color={theme.text} />
                    </Pressable>
                  </View>
                </>
              }>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.consentLead}>
                  此同意仅用于 Codex 操作。配对、手机麦克风和通用快捷键可独立使用。
                </Text>
                <View style={styles.consentPoint}>
                  <Text style={styles.consentPointNumber}>01</Text>
                  <Text style={styles.consentPointText}>
                    手机与 Mac 之间的控制内容加密传输；配套连接服务用于建立连接和必要转发。
                  </Text>
                </View>
                <View style={styles.consentPoint}>
                  <Text style={styles.consentPointNumber}>02</Text>
                  <Text style={styles.consentPointText}>
                    你主动发送给 Codex 的内容由 Codex 及其服务处理，使用 Mac 上已登录的账号。
                  </Text>
                </View>
                <View style={styles.consentPoint}>
                  <Text style={styles.consentPointNumber}>03</Text>
                  <Text style={styles.consentPointText}>
                    手机麦克风仅在你主动开启时采集，实时发送到已配对 Mac 的虚拟麦克风，不经 Codex 转发；是否云端识别取决于你使用的输入法或应用。
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="阅读隐私说明"
                  onPress={() => showInfoSheet('privacy')}
                  style={({ pressed }) => [
                    styles.inlineLink,
                    pressed && styles.settingsLinkRowPressed,
                  ]}>
                  <Text style={styles.inlineLinkText}>阅读隐私说明</Text>
                  <CentralIcon name="link" size={16} color={theme.textMuted} />
                </Pressable>
              </ScrollView>
              <View style={styles.consentButtons}>
                {aiConsent ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      onPress={declineAiConsent}
                      style={({ pressed }) => [
                        styles.consentSecondaryButton,
                        pressed && styles.gateButtonPressed,
                      ]}>
                      <Text style={styles.consentSecondaryButtonText}>KEEP ENABLED</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        setConsentVisible(false);
                        revokeAiConsent();
                      }}
                      style={({ pressed }) => [
                        styles.consentDangerButton,
                        pressed && styles.gateButtonPressed,
                      ]}>
                      <Text style={styles.consentDangerButtonText}>REVOKE</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      onPress={declineAiConsent}
                      style={({ pressed }) => [
                        styles.consentSecondaryButton,
                        pressed && styles.gateButtonPressed,
                      ]}>
                      <Text style={styles.consentSecondaryButtonText}>NOT NOW</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void acceptAiConsent()}
                      style={({ pressed }) => [
                        styles.consentPrimaryButton,
                        pressed && styles.gateButtonPressed,
                      ]}>
                      <Text style={styles.consentPrimaryButtonText}>CONTINUE</Text>
                      <CentralIcon name="check" size={18} color={theme.bg} />
                    </Pressable>
                  </>
                )}
              </View>
            </DismissibleSheet>
          </View>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={infoSheet !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setInfoSheet(null)}>
        <GestureHandlerRootView style={styles.modalGestureRoot}>
          <View style={styles.modalBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setInfoSheet(null)} />
            <DismissibleSheet
              open={infoSheet !== null}
              onDismiss={() => setInfoSheet(null)}
              style={[
                styles.sheet,
                styles.infoSheet,
                { paddingBottom: Math.max(insets.bottom, 18) + 12 },
              ]}
              header={
                <>
                  <SheetHandlePill color={theme.borderStrong} />
                  <View style={styles.sheetTitleRow}>
                    <View>
                      <Text style={styles.sheetKicker}>NoKey</Text>
                      <Text style={styles.sheetTitle}>
                        {infoSheet === 'privacy'
                          ? '隐私说明'
                          : infoSheet === 'support'
                            ? '使用帮助'
                            : infoSheet === 'licenses'
                              ? 'Licenses & Attributions'
                              : '关于NoKey'}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityLabel="Close information"
                      onPress={() => setInfoSheet(null)}
                      style={styles.closeButton}>
                      <CentralIcon name="close" size={19} color={theme.text} />
                    </Pressable>
                  </View>
                </>
              }>
              <ScrollView showsVerticalScrollIndicator={false}>
                {infoSheet === 'privacy' ? (
                  <>
                    <Text style={styles.infoLead}>NoKey隐私说明（开发版）</Text>
                    <Text style={styles.infoParagraph}>
                      本说明适用于NoKey开发版，更新于 2026-09-16。公开服务运营主体、联系方式和具体服务商尚未确定；本版没有已开放的默认公共中继，正式发布前将补齐对应信息。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      你点击开始讲话后，iPhone 采集麦克风声音，经加密实时连接传到已配对 Mac 的虚拟麦克风。本产品不默认保存录音、不提供转写历史；接收声音的输入法、录音或识别应用如何保存和处理声音，由该应用及你的设置决定。语音不经 Codex 转发。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      已开启的讲话可在锁屏或后台继续；停止讲话会释放采音。来电等系统中断会结束本次采音，需要主动恢复。连接中断超过产品设定的恢复时限会停止采音。后台和中断行为仍需 iPhone 真机验收。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      快捷指令和 Mac 返回的任务信息在手机与 Mac 之间加密传输。只有使用 Codex 功能时，相关任务内容才由 Mac 上的 Codex 及其服务处理；Codex 同意与通用麦克风、通用快捷键独立。撤销 Codex 同意阻止后续 Codex 操作，不会删除已经提交给其服务的数据。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      配对地址、访问凭据和加密材料通过 iOS 安全存储保存；浏览器开发预览使用该浏览器的本地存储。Mac 客户端将配对与连接配置保存在用户 Application Support/VoiceDeck 目录。音量与快捷槽配置也保存在本地。相机只用于扫码，产品不保存或上传扫码画面。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      直连不可用时，配置的连接或媒体中继可处理 IP 地址、时间、连接标识和加密流量大小。媒体和控制内容加密，不能据此声称没有网络元数据。国内节点是部署要求，当前自部署服务的地址、日志和保留期限由部署者配置；未部署的服务不能视为已经提供。当前构建关闭 Expo 在线更新；iOS、TestFlight 或 App Store 自身服务适用各自说明。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      手机设置中的移除此 Mac 会清除手机保存的配对和 Codex 同意记录；清理失败会提示重试。它不会撤销 Mac 保存的设备授权，需在 Mac 客户端撤销对应手机。撤销授权会终止该手机的音频与控制连接。音量和快捷槽偏好可能保留在本地；Mac 卸载包保留用户配置，不声称卸载即删除所有数据。
                    </Text>
                    <Text style={styles.infoParagraph}>
                      开发版问题请反馈给向你提供本构建的维护者。不要发送配对二维码、完整配对文本、密钥或私人任务内容。正式支持渠道与数据保留安排将在公开发布前明确；原 Microdex 作者不是本改版的支持方。
                    </Text>
                  </>
                ) : infoSheet === 'support' ? (
                  <>
                    <Text style={styles.infoLead}>开发版使用帮助</Text>
                    <Text style={styles.infoParagraph}>配对失败：确认 Mac 客户端已打开，重新生成限时邀请；无法扫码时使用完整配对文本。异网连接需要已配置的国内连接服务。</Text>
                    <Text style={styles.infoParagraph}>没有声音：先看手机采音和 Mac 收音状态，再在目标应用选择NoKey麦克风。Mac 尚未安装虚拟设备时，按配套安装包的提示处理。</Text>
                    <Text style={styles.infoParagraph}>快捷键不可用：检查 Mac 客户端的快捷控制开关、目标应用及系统权限。批准／拒绝只在存在当前审批时可用。</Text>
                    <Text style={styles.infoParagraph}>请向提供本构建的维护者反馈系统版本、失败动作与现象。发送诊断前检查是否含私人任务信息；不要提供二维码、配对文本或密钥。正式支持渠道尚未开放。</Text>
                  </>
                ) : infoSheet === 'licenses' ? (
                  <>
                    <Text style={styles.infoLead}>Open source, with attribution.</Text>
                    <Text style={styles.infoParagraph}>
                      本产品复用 Microdex 的 MIT 许可代码，以及 BlackHole 的 GPL-3.0 许可驱动代码。各组件保留原有声明，不能把整套产品概括为 MIT。键帽素材及其他第三方内容的再分发条件需在公开发布前逐项确认。
                    </Text>
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => void openExternal(LICENSE_URL, 'Microdex License')}
                      style={({ pressed }) => [styles.infoSecondaryAction, pressed && styles.gateButtonPressed]}>
                      <Text style={styles.infoSecondaryActionText}>上游 Microdex 许可</Text>
                      <CentralIcon name="link" size={16} color={theme.text} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => void openExternal(THIRD_PARTY_LICENSE_URL, 'Third-party licenses')}
                      style={({ pressed }) => [styles.infoSecondaryAction, pressed && styles.gateButtonPressed]}>
                      <Text style={styles.infoSecondaryActionText}>THIRD-PARTY NOTICES</Text>
                      <CentralIcon name="link" size={16} color={theme.text} />
                    </Pressable>
                  </>
                ) : (
                  <>
                    <View style={styles.aboutMark}><MicrodexMark size={64} /></View>
                    <Text style={styles.infoLead}>手机语音与快捷操作，连接自己的 Mac。</Text>
                    <Text style={styles.infoParagraph}>
                      NoKey是基于开源项目开发的独立产品，将手机实时麦克风与快捷面板整合到一起。Codex 是可选功能，不包含其账号或服务。下方链接为上游参考项目，并非本改版的发布或支持渠道。
                    </Text>
                    <Text style={styles.infoVersion}>
                      APP {appInfo.version} ({appInfo.buildNumber}) · {demoMode ? 'OFFLINE PREVIEW' : `BRIDGE ${status?.bridge?.version ?? 'OFFLINE'}`}
                    </Text>
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => void openExternal(PROJECT_URL, 'Microdex repository')}
                      style={({ pressed }) => [styles.infoAction, pressed && styles.gateButtonPressed]}>
                      <Text style={styles.infoActionText}>查看上游 Microdex 项目</Text>
                      <CentralIcon name="link" size={17} color={theme.bg} />
                    </Pressable>
                  </>
                )}
              </ScrollView>
            </DismissibleSheet>
          </View>
        </GestureHandlerRootView>
      </Modal>

      <Modal
        visible={scannerVisible}
        animationType="fade"
        onRequestClose={() => setScannerVisible(false)}>
        <View style={styles.scannerScreen}>
          {scannerVisible ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => void acceptPairingCode(data)}
            />
          ) : null}
          <View style={[styles.scannerHeader, { paddingTop: insets.top + 12 }]}>
            <Pressable
              accessibilityLabel="Close QR scanner"
              onPress={() => setScannerVisible(false)}
              style={styles.scannerClose}>
              <CentralIcon name="close" size={23} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.scannerTitle}>Scan your computer</Text>
            <View style={styles.scannerHeaderSpacer} />
          </View>
          <View style={styles.scannerFrame}>
            <View style={[styles.scannerCorner, styles.scannerCornerTopLeft]} />
            <View style={[styles.scannerCorner, styles.scannerCornerTopRight]} />
            <View style={[styles.scannerCorner, styles.scannerCornerBottomLeft]} />
            <View style={[styles.scannerCorner, styles.scannerCornerBottomRight]} />
          </View>
          <View style={[styles.scannerFooter, { paddingBottom: insets.bottom + 24 }]}>
            <Text style={styles.scannerHint}>
              将相机对准 Mac NoKey客户端显示的配对二维码。
            </Text>
          </View>
        </View>
        </Modal>
      </View>
  );
}

function createStyles(theme: ThemePalette) {
  const skeuo = getSkeuo(theme);
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    screenBody: { flex: 1, backgroundColor: theme.bg },
    connectionGate: { flex: 1, backgroundColor: theme.bg },
    connectionGateContent: {
      flexGrow: 1,
      paddingHorizontal: 24,
    },
    gateContent: {
      width: '100%', maxWidth: 430, alignSelf: 'stretch',
    },
    gateContentCentered: {
      flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingBottom: 80,
    },
    gateHero: {
      marginBottom: 34,
    },
    gateTitle: {
      fontFamily: Fonts.sansBold,
      fontSize: 34,
      lineHeight: 38,
      letterSpacing: -1.1,
      color: theme.text,
    },
    gateTitleMono: {
      marginTop: 2,
      fontFamily: Fonts.mono,
      fontSize: 25,
      lineHeight: 33,
      letterSpacing: 0.2,
      color: theme.textFaint,
    },
    gateNote: {
      marginBottom: 4,
      fontFamily: Fonts.sans,
      fontSize: 14,
      lineHeight: 21,
      color: theme.textMuted,
    },
    gateStateTitle: {
      fontFamily: Fonts.sansSemi,
      fontSize: 17,
      letterSpacing: -0.3,
      color: theme.text,
    },
    gateStateBody: {
      maxWidth: 280,
      textAlign: 'center',
      fontFamily: Fonts.sans,
      fontSize: 13.5,
      lineHeight: 20,
      color: theme.textMuted,
    },
    gateSteps: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.divider,
    },
    gateStep: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 14,
      paddingVertical: 20,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.divider,
    },
    gateStepLast: {
      borderBottomWidth: 0,
    },
    gateStepMarker: {
      width: 20,
      paddingTop: 4,
      fontFamily: Fonts.monoMedium,
      fontSize: 11,
      letterSpacing: 0.6,
      color: theme.textFaint,
    },
    gateStepCopy: { flex: 1, minWidth: 0 },
    gateStepTitle: {
      fontFamily: Fonts.sansSemi,
      fontSize: 16,
      lineHeight: 21,
      letterSpacing: -0.2,
      color: theme.text,
    },
    gateStepBody: {
      marginTop: 4,
      maxWidth: 290,
      fontFamily: Fonts.sans,
      fontSize: 13.5,
      lineHeight: 20,
      color: theme.textMuted,
    },
    gateKeyPreview: {
      marginTop: 14,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      maxWidth: 208,
    },
    gatePreviewKey: {
      width: 46,
      height: 28,
      borderRadius: 7,
      backgroundColor: theme.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    gatePreviewDial: {
      borderRadius: 14,
      backgroundColor: theme.surface,
    },
    gateCommandRow: {
      marginTop: 14,
      minHeight: 46,
      paddingLeft: 12,
      paddingRight: 6,
      paddingVertical: 6,
      borderRadius: 12,
      backgroundColor: theme.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    gatePrompt: {
      fontFamily: Fonts.mono,
      fontSize: 12.5,
      color: theme.textFaint,
    },
    gateCommandText: {
      flex: 1,
      fontFamily: Fonts.mono,
      fontSize: 12.5,
      color: theme.text,
    },
    gateCopyButton: {
      minWidth: 34,
      height: 34,
      paddingHorizontal: 9,
      borderRadius: 9,
      backgroundColor: theme.surface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
    },
    gateCopyButtonDone: {
      backgroundColor: theme.mode === 'dark' ? 'rgba(16,163,127,0.22)' : 'rgba(16,163,127,0.12)',
    },
    gateCopyButtonLabel: {
      fontFamily: Fonts.sansSemi,
      fontSize: 12,
      color: theme.online,
    },
    gatePrimaryButton: {
      marginTop: 28,
      height: 50,
      borderRadius: 12,
      backgroundColor: theme.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
    },
    gatePrimaryButtonText: {
      fontFamily: Fonts.sansSemi,
      fontSize: 15,
      letterSpacing: -0.2,
      color: theme.bg,
    },
    gateSecondaryButton: {
      marginTop: 10,
      height: 50,
      borderRadius: 12,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
    },
    gateSecondaryButtonText: {
      fontFamily: Fonts.sansSemi,
      fontSize: 15,
      letterSpacing: -0.2,
      color: theme.text,
    },
    gateDemoButton: {
      alignSelf: 'center',
      minHeight: 44,
      marginTop: 8,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    gateDemoButtonText: {
      fontFamily: Fonts.sansMedium,
      fontSize: 13,
      color: theme.textMuted,
    },
    gateTertiaryButton: {
      height: 44, marginTop: 4, alignItems: 'center', justifyContent: 'center',
    },
    gateTertiaryButtonText: {
      fontFamily: Fonts.sansMedium,
      fontSize: 13,
      color: theme.dangerText,
    },
    gateButtonPressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
    gateFootnote: {
      marginTop: 16,
      fontFamily: Fonts.sans,
      fontSize: 12.5,
      color: theme.textFaint,
    },
    edgeSwipeZone: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 32,
      zIndex: 30,
      backgroundColor: 'transparent',
    },
    modalGestureRoot: { flex: 1 },
    ambientBlue: {
      position: 'absolute', width: 430, height: 430, borderRadius: 215, top: 120, left: -20,
      backgroundColor: 'rgba(255,255,255,0.035)',
    },
    ambientGreen: {
      position: 'absolute', width: 360, height: 360, borderRadius: 180, top: 300, left: -200,
      backgroundColor: 'rgba(16,163,127,0.025)',
    },
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 16,
      paddingHorizontal: 2,
      gap: 10,
    },
    headerTitleBlock: { flex: 1, minWidth: 0 },
    headerControls: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'flex-end' },
    headerIconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    headerStatusDot: {
      position: 'absolute',
      right: 8,
      top: 8,
      width: 7,
      height: 7,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: theme.surface,
    },
    eyebrow: {
      fontFamily: Fonts.monoMedium,
      fontSize: 8,
      letterSpacing: 1,
      color: theme.textFaint,
    },
    title: {
      fontFamily: Fonts.sansSemi,
      fontSize: 17,
      lineHeight: 22,
      letterSpacing: -0.4,
      fontWeight: '600',
      color: theme.text,
    },
    iconButton: {
      width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
    },
    iconButtonPressed: { opacity: 0.72, backgroundColor: theme.surfaceMuted },
    statusButton: {
      width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
    },
    statusRing: {
      position: 'absolute', width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, opacity: 0.45,
    },
    statusDot: { width: 9, height: 9, borderRadius: 5 },
    threadSwitcher: {
      height: 40,
      borderRadius: 20,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    threadSwitcherDisabled: { opacity: 0.45 },
    threadSwitcherMain: {
      paddingLeft: 10, paddingRight: 8, flexDirection: 'row', alignItems: 'center', gap: 5,
    },
    threadSwitcherNext: {
      width: 30, alignItems: 'center', justifyContent: 'center',
      borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.border,
    },
    threadSwitcherPressed: { backgroundColor: theme.surfaceMuted },
    threadSwitcherText: {
      fontSize: 13, fontWeight: '500', letterSpacing: -0.2, color: theme.textMuted,
    },

    deviceGlow: {
      width: '100%',
      maxWidth: 620,
      alignSelf: 'center',
      marginTop: 0,
      marginBottom: 14,
      marginHorizontal: 0,
    },
    device: {},
    deviceInner: { padding: 16 },
    hardwareArea: { flex: 1, justifyContent: 'flex-start', gap: 5 },
    hardwareOffline: { opacity: 0.5 },
    fourRow: { flexDirection: 'row', justifyContent: 'space-between' },
    bottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'stretch' },
    squareSlot: { width: '23.2%', aspectRatio: 1 },
    wideSlot: { width: '48.8%', aspectRatio: 2.1 },
    agentSlotGlyph: {
      fontSize: 13,
      fontWeight: '500',
      color: skeuo.iconMuted,
      opacity: 0.5,
    },
    screwTopLeft: { position: 'absolute', zIndex: 4, left: '7.8%', top: '6.4%' },
    screwTopRight: { position: 'absolute', zIndex: 4, right: '7.8%', top: '6.4%' },
    screwBottomLeft: { position: 'absolute', zIndex: 4, left: '7.8%', bottom: '6.8%' },
    screwBottomRight: { position: 'absolute', zIndex: 4, right: '7.8%', bottom: '6.8%' },
    frameMarkTop: {
      position: 'absolute',
      zIndex: 5,
      top: '4.2%',
      left: 0,
      right: 0,
      textAlign: 'center',
      color: '#111516',
      fontSize: 17,
      fontWeight: '300',
    },
    sideLabelLeftWrap: {
      position: 'absolute',
      left: -92,
      top: '50%',
      marginTop: -9,
      width: 200,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 5,
      transform: [{ rotate: '-90deg' }],
    },
    sideLabelLeft: {
      width: 200,
      textAlign: 'center',
      fontSize: 5.4,
      fontWeight: '500',
      letterSpacing: 0.48,
      color: '#111516',
    },
    sideLabelRightWrap: {
      position: 'absolute',
      right: -92,
      top: '50%',
      marginTop: -9,
      width: 200,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 5,
      transform: [{ rotate: '90deg' }],
    },
    sideLabelRight: {
      width: 200,
      textAlign: 'center',
      fontSize: 5.4,
      fontWeight: '500',
      letterSpacing: 0.6,
      color: '#111516',
    },
    buildLabel: {
      marginTop: 5, textAlign: 'center', fontSize: 6, fontWeight: '600',
      letterSpacing: 0.25, color: '#111516',
    },
    buildLink: {
      marginTop: 6, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingVertical: 4, paddingHorizontal: 4,
    },
    buildLinkPressed: { opacity: 0.6 },
    buildLinkText: { fontSize: 7, fontWeight: '800', letterSpacing: 0.9, color: skeuo.accent },
    touchModule: {
      width: '23.2%', aspectRatio: 1, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'center', gap: 5,
    },
    touchPressed: { transform: [{ scale: 0.97 }, { translateY: 1 }] },
    ledStack: { gap: 3.5 },
    miniLed: {
      width: 5.5, height: 4.5, borderRadius: 1, borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(0,0,0,0.25)',
      shadowColor: skeuo.rgb, shadowOffset: { width: 0, height: 0 },
      shadowRadius: 3, shadowOpacity: 0.6,
    },
    touchRing: {
      width: '56%', aspectRatio: 1, borderRadius: 999, backgroundColor: '#171B1E', borderWidth: 1.5,
      borderColor: '#050708', alignItems: 'center', justifyContent: 'center',
      shadowColor: '#000000', shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3, shadowRadius: 5, elevation: 6, overflow: 'hidden',
    },
    touchRingGlint: {
      position: 'absolute', top: '14%', left: '20%', width: '45%', height: '20%',
      borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.12)',
      transform: [{ rotate: '-24deg' }],
    },
    touchCenter: {
      width: '66%', aspectRatio: 1, borderRadius: 999, backgroundColor: '#050708',
      borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.06)',
    },

    composerPanel: {
      borderRadius: 24, padding: 16, backgroundColor: theme.surface, borderWidth: 1,
      borderColor: theme.border, marginTop: 18, marginBottom: 8,
      shadowColor: '#000000', shadowOffset: { width: 0, height: 8 },
      shadowOpacity: theme.mode === 'dark' ? 0.3 : 0.04, shadowRadius: 18, elevation: 2,
    },
    composerHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    },
    composerIdentity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
    composerChatIcon: {
      width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.surfaceMuted,
    },
    composerIdentityText: { flex: 1, minWidth: 0 },
    composerKicker: {
      fontSize: 11, fontWeight: '500', letterSpacing: -0.1, color: theme.textFaint,
    },
    composerStatusDot: { width: 8, height: 8, borderRadius: 4 },
    composerTitle: {
      marginTop: 1, fontSize: 15, fontWeight: '600', letterSpacing: -0.3, color: theme.text,
    },
    composerStatusTail: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '38%' },
    composerStatusText: {
      fontSize: 11, fontWeight: '500', letterSpacing: -0.1, textAlign: 'right',
    },
    composerClose: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surfaceMuted,
    },
    composerBox: {
      minHeight: 56, maxHeight: 130, marginTop: 14, borderRadius: 18, paddingLeft: 12,
      paddingRight: 6, paddingVertical: 6, backgroundColor: theme.surfaceInput, borderWidth: 1,
      borderColor: theme.surfaceInputBorder, flexDirection: 'row', alignItems: 'flex-end', gap: 6,
    },
    composerLeadingIcon: { marginBottom: 12, marginLeft: 2 },
    composerInput: {
      flex: 1, minHeight: 42, maxHeight: 114, paddingTop: 10, paddingBottom: 10,
      fontSize: 15, lineHeight: 21, color: theme.text, textAlignVertical: 'top',
    },
    sendButton: {
      width: 40, height: 40, borderRadius: 14, backgroundColor: theme.accent,
      alignItems: 'center', justifyContent: 'center',
    },
    sendButtonDisabled: { backgroundColor: theme.surfaceMuted, opacity: 0.7 },
    sendButtonPressed: { transform: [{ scale: 0.95 }] },
    queueWrap: { marginTop: 12 },
    queueLabel: {
      fontSize: 10, fontWeight: '600', letterSpacing: 0.2, color: theme.textFaint, marginBottom: 4,
    },
    queueRow: {
      minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 4,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.divider, paddingVertical: 6,
    },
    queueSpinner: { width: 20, alignItems: 'center' },
    queueDotMark: { width: 6, height: 6, borderRadius: 3, marginHorizontal: 7 },
    queueText: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '500', color: theme.textMuted },
    queueRemove: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    queueRemoveDisabled: { opacity: 0.4 },
    queueRemovePressed: { opacity: 0.5 },
    composerFooter: {
      marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    composerRoute: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    composerMeta: { fontSize: 10, fontWeight: '600', letterSpacing: 0.2, color: theme.textFaint },
    composerNotice: { marginTop: 12 },
    notice: {
      marginTop: 12, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10,
      backgroundColor: theme.surfaceMuted, flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    },
    noticeError: { backgroundColor: theme.dangerSurface },
    noticeText: { flex: 1, fontSize: 11.5, lineHeight: 16, fontWeight: '700', color: theme.textMuted },
    noticeTextError: { color: theme.dangerText },

    modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.scrim },
    sheet: {
      borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 20, paddingTop: 11,
      backgroundColor: theme.surface, borderTopWidth: 1, borderColor: theme.border,
    },
    settingsSheet: { maxHeight: '88%' },
    consentSheet: { maxHeight: '92%' },
    infoSheet: { maxHeight: '86%' },
    settingsContent: { paddingTop: 4, paddingBottom: 8 },
    catalogSheet: { maxHeight: '92%' },
    keyManagerSheet: { maxHeight: '88%' },
    guideSheet: { maxHeight: '88%' },
    sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: theme.borderStrong, alignSelf: 'center', marginBottom: 18 },
    sheetTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sheetKicker: {
      fontSize: 13, fontWeight: '500', letterSpacing: -0.1, color: theme.textFaint,
    },
    sheetTitle: {
      fontSize: 26, letterSpacing: -0.7, fontWeight: '600', color: theme.text, marginTop: 2,
    },
    closeButton: {
      width: 36, height: 36, borderRadius: 18, backgroundColor: theme.surfaceMuted,
      alignItems: 'center', justifyContent: 'center',
    },
    sheetBody: {
      marginTop: 10, marginBottom: 12, fontSize: 14, lineHeight: 21,
      letterSpacing: -0.15, color: theme.textMuted,
    },
    consentTitleCopy: { flex: 1, paddingRight: 14 },
    consentLead: {
      marginTop: 18, marginBottom: 18, fontFamily: Fonts.sansSemi,
      fontSize: 17, lineHeight: 24, letterSpacing: -0.3, color: theme.text,
    },
    consentPoint: {
      paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.divider, flexDirection: 'row', alignItems: 'flex-start', gap: 13,
    },
    consentPointNumber: {
      width: 24, paddingTop: 2, fontFamily: Fonts.mono, fontSize: 10,
      letterSpacing: 0.5, color: theme.textFaint,
    },
    consentPointText: {
      flex: 1, fontFamily: Fonts.sans, fontSize: 13.5, lineHeight: 20,
      letterSpacing: -0.1, color: theme.textMuted,
    },
    inlineLink: {
      minHeight: 44, marginTop: 6, paddingVertical: 11,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    inlineLinkText: {
      fontFamily: Fonts.sansSemi, fontSize: 13.5, color: theme.text,
      textDecorationLine: 'underline',
    },
    consentButtons: {
      paddingTop: 14, flexDirection: 'row', gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.divider,
    },
    consentSecondaryButton: {
      flex: 1, height: 50, borderRadius: 14, borderWidth: 1,
      borderColor: theme.borderStrong, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.surface,
    },
    consentSecondaryButtonText: {
      fontFamily: Fonts.sansSemi, fontSize: 11, letterSpacing: 0.7, color: theme.textMuted,
    },
    consentDangerButton: {
      flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.dangerSurface, borderWidth: 1, borderColor: theme.danger,
    },
    consentDangerButtonText: {
      fontFamily: Fonts.sansSemi, fontSize: 11, letterSpacing: 0.7, color: theme.dangerText,
    },
    consentPrimaryButton: {
      flex: 1.2, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
      flexDirection: 'row', gap: 8, backgroundColor: theme.text,
    },
    consentPrimaryButtonText: {
      fontFamily: Fonts.sansSemi, fontSize: 11, letterSpacing: 0.7, color: theme.bg,
    },
    infoLead: {
      marginTop: 18, fontFamily: Fonts.sansSemi, fontSize: 18,
      lineHeight: 24, letterSpacing: -0.35, color: theme.text,
    },
    infoParagraph: {
      marginTop: 14, fontFamily: Fonts.sans, fontSize: 13.5,
      lineHeight: 21, letterSpacing: -0.12, color: theme.textMuted,
    },
    infoAction: {
      minHeight: 50, marginTop: 22, borderRadius: 14, paddingHorizontal: 16,
      backgroundColor: theme.text, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'center', gap: 9,
    },
    infoActionText: {
      fontFamily: Fonts.sansSemi, fontSize: 11, letterSpacing: 0.65, color: theme.bg,
    },
    infoSecondaryAction: {
      minHeight: 48, marginTop: 10, borderRadius: 14, paddingHorizontal: 15,
      borderWidth: 1, borderColor: theme.borderStrong, flexDirection: 'row',
      alignItems: 'center', justifyContent: 'space-between',
    },
    infoSecondaryActionText: {
      fontFamily: Fonts.sansSemi, fontSize: 11, letterSpacing: 0.55, color: theme.text,
    },
    aboutMark: { marginTop: 20, alignSelf: 'flex-start' },
    infoVersion: {
      marginTop: 18, fontFamily: Fonts.mono, fontSize: 10.5,
      lineHeight: 16, letterSpacing: 0.35, color: theme.textFaint,
    },
    cliCommand: {
      minHeight: 48, marginBottom: 14, paddingHorizontal: 14, borderRadius: 14,
      backgroundColor: theme.surfaceInput, borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border, flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    cliCommandPrompt: { fontSize: 13, fontWeight: '700', color: theme.textFaint },
    cliCommandText: {
      flex: 1, fontSize: 13, fontWeight: '600', color: theme.text,
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    },

    chatDrawerModal: { flex: 1 },
    chatDrawerScrim: {
      ...StyleSheet.absoluteFillObject, backgroundColor: theme.drawerScrim,
    },
    chatDrawer: {
      position: 'absolute', top: 0, bottom: 0, left: 0, paddingHorizontal: 18,
      backgroundColor: theme.surface, borderTopRightRadius: 28, borderBottomRightRadius: 28,
      borderRightWidth: 1, borderColor: theme.border,
      shadowColor: '#000000', shadowOffset: { width: 12, height: 0 },
      shadowOpacity: 0.28, shadowRadius: 30, elevation: 24,
    },
    chatDrawerHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    },
    chatDrawerKicker: {
      fontSize: 8, fontWeight: '900', letterSpacing: 1.15, color: theme.textFaint,
    },
    chatDrawerTitle: {
      marginTop: 3, fontSize: 30, lineHeight: 33, fontWeight: '900',
      letterSpacing: -1.2, color: theme.text,
    },
    chatDrawerClose: {
      width: 40, height: 40, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border,
    },
    chatDrawerContent: { paddingTop: 20, paddingBottom: 20 },
    chatDrawerSectionText: {
      fontSize: 8, fontWeight: '900', letterSpacing: 1.05, color: theme.textFaint, marginBottom: 8,
    },
    projectGroup: { marginBottom: 18 },
    projectHeader: {
      minHeight: 32, paddingHorizontal: 2,
      flexDirection: 'row', alignItems: 'center', gap: 8,
    },
    projectHeaderPressed: { opacity: 0.6 },
    projectName: {
      flex: 1, fontSize: 13, fontWeight: '900', letterSpacing: -0.2, color: theme.text,
    },
    projectCount: { fontSize: 11, fontWeight: '800', color: theme.textFaint },
    projectThreads: { marginTop: 2 },
    chatRow: {
      minHeight: 54, flexDirection: 'row', alignItems: 'stretch',
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.divider,
    },
    chatRowBar: {
      position: 'absolute', left: 0, top: 12, bottom: 12, width: 3, borderRadius: 2,
      backgroundColor: theme.blue,
    },
    chatRowOpen: {
      flex: 1, minWidth: 0, paddingLeft: 14, paddingVertical: 11,
      flexDirection: 'row', alignItems: 'center', gap: 12,
    },
    chatRowPressed: { opacity: 0.55 },
    chatDot: { width: 8, height: 8, borderRadius: 4 },
    chatRowCopy: { flex: 1, minWidth: 0 },
    chatRowName: { fontSize: 13.5, fontWeight: '700', color: theme.textMuted },
    chatRowNameSelected: { fontWeight: '900', color: theme.text },
    chatRowTask: { marginTop: 2, fontSize: 10.5, color: theme.textFaint },
    chatRowArchive: {
      width: 40, alignItems: 'center', justifyContent: 'center',
    },
    chatRowArchivePressed: { opacity: 0.5 },
    chatDrawerFooter: {
      minHeight: 42, paddingTop: 11, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'center', gap: 7, borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    chatDrawerFooterText: {
      fontSize: 8, fontWeight: '800', letterSpacing: 0.25, color: theme.textFaint,
    },

    inputLabel: {
      fontSize: 13, fontWeight: '500', letterSpacing: -0.1, color: theme.textMuted, marginBottom: 8,
    },
    input: {
      height: 50,
      borderRadius: 14,
      paddingHorizontal: 14,
      marginBottom: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.surfaceInputBorder,
      backgroundColor: theme.surfaceInput,
      color: theme.text,
      fontSize: 15,
      fontWeight: '400',
      letterSpacing: -0.2,
    },
    searchWrap: {
      height: 46, borderRadius: 14, paddingHorizontal: 13, marginBottom: 10, borderWidth: 1,
      borderColor: theme.surfaceInputBorder, backgroundColor: theme.surfaceInput, flexDirection: 'row',
      alignItems: 'center', gap: 8,
    },
    searchInput: { flex: 1, height: '100%', color: theme.text, fontSize: 13, fontWeight: '600' },
    actionCatalog: { paddingBottom: 10 },
    actionRow: {
      minHeight: 58, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 14,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.divider,
    },
    actionRowPressed: { opacity: 0.55 },
    actionRowIcon: { width: 24, alignItems: 'center', justifyContent: 'center' },
    actionCardPressed: { transform: [{ scale: 0.988 }] },
    actionCopy: { flex: 1, minWidth: 0 },
    actionTitleRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    },
    actionTitle: { flex: 1, fontSize: 13.5, fontWeight: '700', color: theme.textMuted },
    actionTitleSelected: { fontWeight: '900', color: theme.text },
    actionCategory: {
      fontSize: 7, fontWeight: '900', letterSpacing: 0.6, color: theme.textFaint,
      textTransform: 'uppercase',
    },
    actionDescription: { marginTop: 2, fontSize: 10.5, lineHeight: 14, color: theme.textFaint },
    actionCheck: { width: 20, alignItems: 'center' },
    keyManagerGrid: {
      flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between',
      rowGap: 11, paddingBottom: 4,
    },
    keyManagerCard: {
      width: '48.4%', borderRadius: 17, borderWidth: 1, borderColor: theme.border,
      backgroundColor: theme.surfaceInput, overflow: 'hidden',
    },
    keyManagerChoice: { alignItems: 'center', paddingHorizontal: 10, paddingTop: 14, paddingBottom: 10 },
    keyManagerIcon: {
      width: 48, height: 48, borderRadius: 15, backgroundColor: theme.surfaceMuted,
      alignItems: 'center', justifyContent: 'center',
    },
    keyManagerIconEmpty: { backgroundColor: theme.accentSoft, borderWidth: 1, borderColor: theme.accentSoftBorder },
    keyManagerSlot: {
      marginTop: 9, fontSize: 7, fontWeight: '900', letterSpacing: 0.85, color: theme.textFaint,
    },
    keyManagerLabel: {
      width: '100%', marginTop: 3, textAlign: 'center', fontSize: 12,
      fontWeight: '900', color: theme.text,
    },
    removeKeyButton: {
      height: 36, borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.dangerSurface,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    },
    removeKeyButtonDisabled: { opacity: 0.3 },
    removeKeyButtonPressed: { opacity: 0.8 },
    removeKeyText: { fontSize: 8, fontWeight: '900', letterSpacing: 0.65, color: theme.danger },
    clearAllKeysButton: {
      height: 46, marginTop: 12, borderRadius: 15, borderWidth: 1,
      borderColor: theme.danger, backgroundColor: theme.dangerSurface,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    },
    clearAllKeysButtonDisabled: { opacity: 0.35 },
    clearAllKeysText: {
      fontSize: 9, fontWeight: '900', letterSpacing: 0.75, color: theme.danger,
    },
    customPromptInput: {
      height: 82, paddingTop: 11, textAlignVertical: 'top', marginTop: 2, marginBottom: 8,
    },
    editorButtons: { flexDirection: 'row', gap: 9 },
    clearButton: {
      height: 52, paddingHorizontal: 16, borderRadius: 15, backgroundColor: theme.surfaceMuted,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    },
    clearButtonText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.7, color: theme.textMuted },
    saveKeyButton: {
      flex: 1, height: 52, borderRadius: 15, backgroundColor: theme.accent,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    saveKeyButtonDisabled: { opacity: 0.4 },
    guideContent: { gap: 10, paddingTop: 16, paddingBottom: 6 },
    guideItem: {
      borderRadius: 16, padding: 13, backgroundColor: theme.surfaceInput, borderWidth: 1,
      borderColor: theme.border, flexDirection: 'row', gap: 12,
    },
    guideIcon: {
      width: 42, height: 42, borderRadius: 13, backgroundColor: theme.surfaceMuted,
      alignItems: 'center', justifyContent: 'center',
    },
    guideCopy: { flex: 1 },
    guideTitle: { fontSize: 13, fontWeight: '900', color: theme.text },
    guideBody: { marginTop: 4, fontSize: 11, lineHeight: 15, color: theme.textMuted },
    guideButtonPressed: { opacity: 0.66, transform: [{ scale: 0.98 }] },
    guideSectionIntro: { marginTop: 22, marginBottom: 2 },
    guideSectionTitle: { fontSize: 15, fontWeight: '900', letterSpacing: -0.2, color: theme.text },
    guideSectionBody: { marginTop: 5, fontSize: 11.5, lineHeight: 16, color: theme.textMuted },
    guideGroup: { gap: 10 },
    guideGroupHeading: {
      marginTop: 10, marginBottom: -1, fontSize: 10, fontWeight: '900',
      letterSpacing: 0.8, color: theme.textFaint,
    },
    connectButton: {
      height: 52, borderRadius: 999, marginTop: 6, backgroundColor: theme.accent,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    connectButtonPressed: { opacity: 0.88 },
    connectButtonText: {
      fontSize: 15, fontWeight: '600', letterSpacing: -0.2, color: theme.accentText,
    },
    scanButton: {
      minHeight: 68, borderRadius: 18, marginBottom: 18, paddingHorizontal: 14,
      backgroundColor: theme.surfaceMuted, borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      flexDirection: 'row', alignItems: 'center', gap: 12,
    },
    scanButtonPressed: { opacity: 0.82 },
    scanButtonIcon: {
      width: 42, height: 42, borderRadius: 21, backgroundColor: theme.accent,
      alignItems: 'center', justifyContent: 'center',
    },
    scanButtonCopy: { flex: 1 },
    scanButtonTitle: {
      fontSize: 15, fontWeight: '600', letterSpacing: -0.2, color: theme.text,
    },
    scanButtonBody: { marginTop: 2, fontSize: 13, color: theme.textFaint },
    manualDivider: {
      marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 10,
    },
    manualDividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
    manualDividerText: {
      fontSize: 12, fontWeight: '400', letterSpacing: -0.1, color: theme.textFaint,
    },
    settingsSectionDivider: {
      height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginTop: 8, marginBottom: 18,
    },
    forgetMacButton: {
      height: 48, marginBottom: 8, borderRadius: 14, backgroundColor: theme.dangerSurface,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    forgetMacButtonText: { fontSize: 14, fontWeight: '700', color: theme.dangerText },
    settingsSpace: { marginTop: 20 },
    settingsGroup: {
      marginBottom: 22,
    },
    settingsGroupLabel: {
      fontFamily: Fonts.sansMedium,
      fontSize: 12,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: theme.textFaint,
      marginBottom: 10,
    },
    settingsSupportingText: {
      marginTop: -3, marginBottom: 7, fontFamily: Fonts.sans,
      fontSize: 12.5, lineHeight: 18, color: theme.textMuted,
    },
    settingsCommandRow: {
      minHeight: 44,
      paddingLeft: 12,
      paddingRight: 6,
      borderRadius: 12,
      backgroundColor: theme.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
    },
    settingsCommandPrompt: {
      fontFamily: Fonts.mono,
      fontSize: 12.5,
      color: theme.textFaint,
    },
    settingsCommandText: {
      flex: 1,
      fontFamily: Fonts.mono,
      fontSize: 12,
      color: theme.text,
    },
    settingsCopyChip: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface,
    },
    settingsCopyChipDone: {
      backgroundColor: theme.mode === 'dark' ? 'rgba(16,163,127,0.22)' : 'rgba(16,163,127,0.12)',
    },
    settingsPrimaryButton: {
      height: 46,
      borderRadius: 12,
      backgroundColor: theme.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    settingsPrimaryButtonText: {
      fontFamily: Fonts.sansSemi,
      fontSize: 14.5,
      letterSpacing: -0.2,
      color: theme.bg,
    },
    themeSegment: {
      flexDirection: 'row', gap: 8,
    },
    themeSegmentOption: {
      flex: 1, height: 42, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
      backgroundColor: theme.surfaceInput, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'center', gap: 7,
    },
    themeSegmentOptionActive: { borderColor: theme.text, backgroundColor: theme.surfaceMuted },
    themeSegmentText: { fontFamily: Fonts.sansMedium, fontSize: 13, letterSpacing: -0.1, color: theme.textMuted },
    themeSegmentTextActive: { color: theme.text },
    controllerFieldLabel: {
      marginBottom: 8, fontFamily: Fonts.sansMedium, fontSize: 12, color: theme.textMuted,
    },
    encoderModeSegment: {
      flexDirection: 'row', gap: 6, marginBottom: 10,
    },
    encoderModeOption: {
      flex: 1, height: 38, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border, backgroundColor: theme.surfaceInput,
      alignItems: 'center', justifyContent: 'center',
    },
    encoderModeOptionActive: {
      borderColor: theme.text, backgroundColor: theme.surfaceMuted,
    },
    encoderModeText: {
      fontFamily: Fonts.sansMedium, fontSize: 11.5, color: theme.textMuted,
    },
    encoderModeTextActive: { color: theme.text },
    settingsLinkRow: {
      minHeight: 48,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.divider,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    settingsLinkRowPressed: { opacity: 0.55 },
    settingsLinkTitle: {
      fontFamily: Fonts.sansSemi,
      fontSize: 15,
      letterSpacing: -0.2,
      color: theme.text,
    },
    settingsLinkMeta: {
      marginTop: 3, fontFamily: Fonts.sans, fontSize: 11.5, color: theme.textFaint,
    },
    consentStatusDot: { width: 8, height: 8, borderRadius: 4 },
    settingsDangerLink: {
      marginTop: 4,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    settingsDangerLinkText: {
      fontFamily: Fonts.sansMedium,
      fontSize: 14,
      color: theme.dangerText,
    },
    settingsRow: {
      minHeight: 56, borderRadius: 16, paddingHorizontal: 14, marginTop: 8,
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: theme.surfaceMuted, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border,
    },
    settingsRowPressed: { backgroundColor: theme.surfaceMuted },
    settingsRowIcon: {
      width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
      backgroundColor: theme.surfaceMuted,
    },
    settingsRowCopy: { flex: 1 },
    settingsRowTitle: { fontSize: 13, fontWeight: '900', color: theme.text },
    settingsRowBody: { marginTop: 2, fontSize: 10.5, lineHeight: 14, color: theme.textMuted },

    scannerScreen: { flex: 1, backgroundColor: '#071014' },
    scannerHeader: {
      position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 18,
      paddingBottom: 16, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'space-between', backgroundColor: 'rgba(4,12,15,0.58)',
    },
    scannerClose: {
      width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.16)',
    },
    scannerTitle: { fontSize: 16, fontWeight: '900', color: '#FFFFFF' },
    scannerHeaderSpacer: { width: 42 },
    scannerFrame: {
      position: 'absolute', width: 252, height: 252, left: '50%', top: '50%',
      marginLeft: -126, marginTop: -126,
    },
    scannerCorner: { position: 'absolute', width: 42, height: 42, borderColor: theme.blue },
    scannerCornerTopLeft: { top: 0, left: 0, borderTopWidth: 5, borderLeftWidth: 5, borderTopLeftRadius: 16 },
    scannerCornerTopRight: { top: 0, right: 0, borderTopWidth: 5, borderRightWidth: 5, borderTopRightRadius: 16 },
    scannerCornerBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 5, borderLeftWidth: 5, borderBottomLeftRadius: 16 },
    scannerCornerBottomRight: { bottom: 0, right: 0, borderBottomWidth: 5, borderRightWidth: 5, borderBottomRightRadius: 16 },
    scannerFooter: {
      position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 32,
      paddingTop: 22, backgroundColor: 'rgba(4,12,15,0.68)',
    },
    scannerHint: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  });
}
