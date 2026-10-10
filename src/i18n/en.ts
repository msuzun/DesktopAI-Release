export const en = {
  actions: {
    title: "Actions",
    beta: "JEV — BETA / EXPERIMENTAL",
    betaNotice:
      "JEV classifies action intent. Real command execution and voice-action workflows are not fully validated. Future versions will improve safety, accuracy, and integration. Review every candidate; real execution remains disabled.",
    enable: "Allow action request review",
    notice:
      "Actions start off. When enabled, supported explicit requests may be sent to JEV for interpretation. Every action requires review and confirmation. Voice replies and AI output cannot approve execution.",
    validationPending:
      "You can review action candidates. Execution remains unavailable until action safety acceptance is complete.",
    error: "Action settings are unavailable. No new actions can run.",
    confirmTitle: "Review action",
    confirmNotice:
      "Confirm only if this exact action is what you requested. A new request, interruption or expiry cancels this approval.",
    kind: "Action type",
    kinds: {
      application: "Application",
      terminal: "Terminal",
      command: "Synthetic command",
      script: "Synthetic script",
    },
    executable: "Executable",
    arguments: "Exact arguments",
    workingDirectory: "Working directory",
    content: "Exact command or script",
    expires: "Approval expires at",
    identity: "Candidate identity",
    candidateId: "Candidate ID",
    digest: "Candidate SHA-256",
    executableHash: "Executable SHA-256",
    turn: "Request ID",
    reject: "Cancel action",
    confirm: "Confirm this action",
  },
  routingReadiness: {
    currentScreen:
      "Current screen mode is selected; no local model is required.",
    noValidatedEngine:
      "Automatic semantic routing is unavailable in this version: no model has passed accuracy validation. Stop the conversation and select Current screen mode to share your current view. For experimental LAYA evaluation, use Settings > Developer Mode > Smart Visual Routing.",
    legacy:
      "Screen routing requires local LAYA. Choose Auto in Developer Mode to restore the current routing settings.",
    localOnly:
      "Blocked: {{engine}} requires cloud access, but routing is restricted to this computer.",
    remoteConsent:
      "Blocked: {{engine}} requires explicit cloud evaluation consent in Developer Mode.",
    loading: "{{engine}} is loading. Screen routing is not ready yet.",
    unavailable:
      "Blocked: the selected engine is not ready. Check its existing setup and health in Developer Mode.",
    experimental:
      "{{engine}} is available for experimental evaluation. Its routing accuracy has not passed validation.",
    ready: "{{engine}} is ready and validated for visual routing.",
  },
  developer: {
    title: "Developer tools",
    finishTurn: "Finish speaking and respond",
    capture: "Local capture & visual detection",
    captureNote:
      "Manual test captures stay local. When Screen Awareness is off, a temporary local session closes after capture.",
    captureScreen: "Capture screen",
    captureDetail: "Capture detail",
    routing: "Visual routing settings",
    shadow: "Evaluate visual routing in Shadow",
    fallback: "Technical failure fallback",
    fallbackNote:
      "A failed evaluation leaves existing voice and screen responses running. Successful decisions, including NONE, never trigger another engine.",
    laya: "LAYA local runtime — BETA / EXPERIMENTAL",
    layaBetaNotice:
      "LAYA routes visual intent locally. Temporal and reference-routing accuracy is not production-ready. Future versions will improve reliability and performance. Incorrect or unavailable selections can block a response.",
    installNote:
      "Optional, separate installation. No model downloads occur here. Prepare once before evaluation; the model stays loaded between turns.",
    python: "Python executable",
    pythonPath: "Absolute path to the optional runtime python.exe",
    modelPath: "Checkpoint directory",
    modelPathHint: "Absolute path to a hash-verified checkpoint",
    checkpoint: "Checkpoint",
    multilingual: "Multilingual",
    english: "English",
    typed: "Typed decisions",
    device: "Device",
    cuda: "CUDA (requires a compatible optional runtime)",
    prepare: "Prepare local model",
    unload: "Unload local model",
    jev: "JEV action intelligence — BETA / EXPERIMENTAL",
    jevNotice:
      "JEV interprets explicit action requests. It receives bounded request text, never screenshots or saved Memory. It cannot execute actions. Your existing JEV key is preserved.",
    remoteConsent: "Allow cloud Shadow evaluation this session",
    jevKey: "Jev API key",
    jevKeyHint: "Your TypeSafe API key",
    jevSave: "Save Jev key",
    jevRemove: "Remove saved Jev key",
    jevSaved: "Jev key saved securely. No validation request was sent.",
    jevRemoved: "Saved Jev key removed.",
    jevError: "Could not update the Jev key in secure credential storage.",
    jevKeyNotice:
      "Keys stay in Windows Credential Manager. An environment key takes precedence over a saved key. Turning Actions off stops new requests; transmitted text cannot be recalled.",
    error: "Routing settings need attention. Review the engine status below.",
    status: "Status",
    legacyPanels:
      "Technical metrics use their original engine identifiers. No conversation or screen content is translated.",
  },
  app: {
    name: "AI Desktop Companion",
    tagline: "A little company. A clearer day.",
    home: "Home",
    memory: "Memory",
    settings: "Settings",
    navigation: "Main navigation",
  },
  common: {
    on: "On",
    off: "Off",
    paused: "Paused",
    ready: "Ready",
    unavailable: "Unavailable",
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    delete: "Delete",
    next: "Next",
    back: "Back",
    refresh: "Refresh",
    loading: "Loading…",
    working: "Working…",
    retry: "Try again",
    configured: "Configured",
    notConfigured: "Needs setup",
    all: "All",
    today: "Today",
    yesterday: "Yesterday",
    earlier: "Earlier",
    confirm: "Confirm",
    optional: "Optional",
    bytes: "{{value}} MB",
    none: "None",
    learnMore: "Learn more",
  },
  home: {
    textReady: "Text conversation ready",
    message: "Your question",
    messagePlaceholder: "Ask a question or ask about your screen…",
    messageStart: "Start Companion to ask a question.",
    send: "Send question",
    interrupt: "Interrupt reply",
    conversation: "Conversation",
    you: "You",
    assistant: "Companion",
    eyebrow: "YOUR COMPANION",
    title: "Make room for a conversation.",
    intro: "Talk through your work, ask a question, or think out loud.",
    session: "Companion session",
    ready: "Ready when you are",
    connecting: "Connecting…",
    stopping: "Stopping…",
    connectionFailed: "Could not connect",
    testing: "Testing connection…",
    muted: "Microphone muted",
    paused: "Conversation paused",
    speaking: "Speaking",
    thinking: "Thinking",
    listening: "Listening",
    start: "Start Companion",
    stop: "Stop Companion",
    mute: "Mute microphone",
    unmute: "Unmute microphone",
    restart: "Restart conversation",
    audioNotice: "Starting sends microphone audio to {{provider}}.",
    wait: "Wait until the companion is ready before speaking.",
    setup: "Add your provider’s API key in Settings to start talking.",
    configure: "Set up your AI provider",
    responseFailed:
      "No reply received. Restart the conversation, then ask again.",
    voiceNotice:
      "Voice needs attention. Restart the conversation if it has stopped.",
    sessionError:
      "The conversation could not continue. Check your provider settings and connection, then try again.",
    microphoneError:
      "Microphone access is unavailable. Allow microphone access in your system settings, then try again.",
    retryVisual: "Try current screen again",
    visualError:
      "Your screen could not be prepared for this question. Your answer is paused. Try again, or turn Screen Awareness off and start a voice-only conversation.",
    routingError:
      "Screen context could not be selected for this question. The response is held. Retry; if the problem persists, check visual routing status in Settings.",
    routingTimeout:
      "Screen context selection timed out for this question. The response is held. Retry; if the problem persists, check the local model status in Settings.",
    routingBusy:
      "The local model is still processing the previous screen context selection. Wait a moment, then retry.",
    screenSendingError:
      "Screen context could not be sent. Check your connection and try again.",
    screenExpired:
      "The screen image for this question has expired. Try your current screen again.",
    screenUnavailable:
      "No current screen image could be captured for this question. No image was sent and the response is held. Try your current screen again.",
    screenTooLarge:
      "The screen image exceeds this connection's size limit. No image was sent and the response is held.",
    screenReadbackFailed:
      "The captured screen image could not be read. No image was sent. Try your current screen again.",
    screenEncodingFailed:
      "The screen image could not be encoded for sending. No image was sent. Try your current screen again.",
    screenPermission:
      "Screen access was interrupted. Stop and start the companion again.",
    screenBusy:
      "Screen context is still being prepared. Wait a moment and try again.",
    screenTimeout: "Updating your screen took too long. Try again.",
    screenReceived:
      "The provider acknowledged {{count}} screen image(s) for this question.",
    screenSent: "Sent {{count}} screen image(s) for this question.",
    screenNoImage:
      "No usable screen image was available for this question; no image was sent.",
    screenNotUsed:
      "Semantic routing selected no screen image for this question.",
    screen: "Screen Awareness",
    screenOn:
      "Selected screen context may be shared with your AI provider during conversation.",
    screenOff: "Your screen is not shared with the AI.",
    screenIdle: "Ready to use your screen when you start Companion.",
    screenStop:
      "Turning this off stops the conversation. Start again to continue with voice only.",
    screenDescription:
      "Screen perception happens on this computer. When enabled, selected visual context may be sent to your AI provider. Temporary visual history expires and is separate from saved Memory.",
    provider: "AI provider",
    routing: "Visual routing",
    routingState: "LAYA Local",
    routingDescription:
      "Local LAYA selects the visual context. Screen routing must pass accuracy validation before release.",
    memoryOff: "No screen moments are being saved.",
    memoryManual: "Manual saving only · {{count}} saved",
    memoryAutomatic: "Selected important changes · {{count}} saved",
    memoryPaused: "New saves are paused · {{count}} saved",
    remember: "Remember this screen",
    rememberHint:
      "Start Companion with Screen Awareness on to save your current screen.",
    openMemory: "Open Memory",
    saved: "Screen saved to Memory.",
    savedDuplicate: "This screen is already saved in Memory.",
  },
  providerErrors: {
    secureConnection:
      "A secure connection to this provider failed. Check its service address and certificate, or choose another configured provider.",
    authentication:
      "This service needs a valid API key. Check its profile in AI & Voice settings.",
    quota:
      "This service reached its usage or rate limit. Try again later or choose another configured provider.",
    timeout:
      "This service took too long to respond. You can try another question or switch providers.",
    routing:
      "Screen routing is not ready. Check Smart Visual Routing in Settings, or turn Screen Awareness off for text questions.",
    visual:
      "The requested screen context is unavailable or this model cannot accept it. Check the model’s image capabilities; the question was not silently changed.",
    recognition:
      "Speech could not be recognized. Try speaking again or type your question.",
    synthesis:
      "The reply could not be spoken. Any received answer remains available as text. Check the speech output profile or try again.",
    messageLimit: "This message is too long. Shorten it and try again.",
    profile:
      "This service profile is unavailable. Select or configure a provider in AI & Voice settings.",
    cancelled: "The response was stopped. You can ask another question.",
    request:
      "This provider could not complete the request. Check its settings or choose another configured provider.",
  },
  settings: {
    aiVoice: "AI & Voice",
    chooseProvider: "Choose an AI provider",
    noKeyNeeded: "This profile does not require an API key.",
    composedVoice:
      "Companion can recognize your speech and speak this model’s replies. A native voice API is not required.",
    noVision:
      "This model is configured for text only. Screen questions require a model with image support.",
    recognition: "Speech recognition",
    chooseRecognition: "Choose a speech recognition profile",
    synthesis: "Spoken replies",
    chooseSynthesis: "Choose a speech output profile",
    systemVoice: "System voice on this computer",
    speechLanguage: "Conversation language",
    recognitionNeeded:
      "Select speech recognition and speech output profiles to use voice. Typed questions remain available.",
    voicePrivacy:
      "Microphone: {{recognition}}. Reasoning and selected screen context: {{reasoning}}. Spoken replies: {{synthesis}}.",
    addProvider: "Add AI or speech provider",
    manageProfiles: "Configured providers",
    chooseProfile: "Choose a profile to manage",
    editProfile: "Edit profile",
    deleteProfileConfirm:
      "Remove this profile and its saved API key? Removing the selected AI leaves conversation unconfigured.",
    configureProfile: "Configure provider",
    displayName: "Display name",
    integration: "Integration",
    compatibleProvider: "Compatible AI provider",
    recognitionService: "Compatible speech recognition",
    synthesisService: "Compatible speech synthesis",
    endpoint: "Service base URL",
    endpointPolicy:
      "Use HTTPS for remote services. HTTP is allowed only for loopback services on this computer. Do not include a key in the URL.",
    endpointImmutable:
      "To change the service address or authentication, create a new profile and enter its key separately.",
    authentication: "Authentication",
    noAuthentication: "No API key",
    replaceKeyOptional:
      "Replacement API key (leave empty to keep the saved key)",
    declaredCapabilities:
      "Declare the selected model’s supported features. These settings are not a verified capability test.",
    supportsVision: "Accepts images",
    supportsCompare: "Accepts multiple images for comparison",
    supportsStreaming: "Returns text as it is generated",
    profileSaved:
      "Provider profile saved. Select it above when you want to use it.",
    profileRemoved: "Provider profile and its saved key removed.",
    profileError:
      "Could not save your change. Check the service address, model, and secure key storage. A saved profile may still need its key.",
    compatibleScope:
      "Compatible AI uses the Chat Completions format; compatible speech uses transcription or speech endpoints. Service and model support varies. Requests go directly from this computer to the selected service.",
    title: "Make yourself at home.",
    intro: "Your voice, your language, your privacy choices.",
    general: "General",
    language: "Interface language",
    languageNote:
      "Changes apply immediately. Your conversation language is independent.",
    provider: "AI provider",
    model: "Model",
    voice: "Voice",
    key: "API key",
    keyPlaceholder: "Enter your provider’s API key",
    keyChecking: "Checking secure key storage…",
    keyMissing: "Add an API key to continue.",
    keySaved: "API key saved securely.",
    keyRemoved: "API key removed.",
    keyError: "Could not save your change. Check the API key and try again.",
    keyUnavailable:
      "Secure key storage is unavailable. Open the desktop app and try again.",
    changeKey: "Replace API key",
    removeKey: "Remove API key",
    cancelKey: "Cancel key change",
    test: "Test connection",
    testSuccess: "Connection Successful",
    testDone:
      "Connection test finished. Review the result in developer diagnostics if the connection still fails.",
    keyPrivacy:
      "API keys are stored in Windows Credential Manager, not browser storage or a project-owned server. A connection test may incur provider charges.",
    sessionLocked: "Stop the conversation before changing provider settings.",
    privacy: "Screen & privacy",
    privacyNote:
      "Turning Screen Awareness off clears temporary visual history and stops new screen uploads. It cannot recall images already sent to a provider. Saved Memory is managed separately.",
    advanced: "Advanced",
    developer: "Developer Mode",
    developerNote: "Shows technical diagnostics and testing controls.",
    tools: "Developer tools",
    loadingTools: "Loading developer tools…",
    onboarding: "Show welcome setup again",
    diagnostics: "Memory diagnostics",
    routing: "Smart Visual Routing",
    routingEngine: "Visual intent engine",
    screenContextMode: "Screen sharing mode",
    screenContextCurrent: "Current screen",
    screenContextSemantic: "Smart selection — LAYA (BETA / EXPERIMENTAL)",
    screenContextCurrentNote:
      "With Screen Awareness on, a current screen image is captured after your question is transcribed and sent before the reply. This mode does not select earlier screens and needs no LAYA installation. Stop the conversation before changing modes.",
    screenContextSemanticNote:
      "LAYA routes visual intent locally between the current screen and temporary history, or selects no image. Temporal and reference accuracy is not production-ready; reliability and performance need further improvement. Prepare it in Developer Mode. A failed selection holds the response.",
    auto: "Auto",
    legacy: "Compatibility",
    localOnly: "Keep routing evaluations on this computer",
    routingNote:
      "Visual intent is classified on this computer by LAYA. JEV is used only for action requests. Local setup and experimental evaluation are available in Developer Mode; choosing an experimental configuration does not validate its accuracy.",
    encryption:
      "Saved Memory stays on this computer and is not additionally encrypted by the application. Your Windows account and disk protection still apply.",
    storageLocation: "Storage location",
    storageLocationNote:
      "Memory is stored in this application’s local data folder. Clearing Memory removes its saved records and associated images.",
    memoryLink: "Manage saved memories",
  },
  onboarding: {
    label: "Welcome setup",
    step: "Step {{current}} of {{total}}",
    welcomeTitle: "Hello. Let’s make this yours.",
    welcome:
      "Companion is a voice AI assistant that can understand selected context from your screen when you allow it.",
    language: "Choose your language",
    providerTitle: "Choose who you talk with.",
    provider:
      "Choose an AI provider. In Settings you can add compatible text or vision providers and choose speech recognition and spoken replies independently. You can finish this later.",
    screenTitle: "You decide what’s visible.",
    screen:
      "Screen Awareness analyzes your screen locally and may send selected views to your chosen AI provider. It starts off each time you open Companion.",
    routingTitle: "Keep conversation simple.",
    routing:
      "Current screen mode shares the current view for each question when Screen Awareness is on. You can configure LAYA separately for experimental smart selection. Screen sharing does not enable saved Memory or Actions.",
    memoryTitle: "Keep a moment, only when you choose.",
    memory:
      "Persistent Visual Memory can save a screen on this computer when you press “Remember this screen”. It starts off. You can separately enable selected automatic saves in Settings. Search works on saved labels, not screen meaning.",
    finish: "Open Companion",
    later: "Keep Memory off for now",
    completed:
      "Your choices are ready. You can change them any time in Settings.",
  },
  memory: {
    title: "A place for useful moments.",
    intro: "Revisit the screens you chose to keep, on this computer.",
    titleShort: "Persistent Visual Memory",
    disabled: "Persistent Memory is off.",
    disabledDescription:
      "No new screen moments are saved. Previously saved memories remain available below.",
    empty: "Nothing saved here yet.",
    emptyDescription:
      "Enable Memory, start Companion with Screen Awareness, then choose “Remember this screen”. You can also separately enable selected automatic saves in Settings.",
    enable: "Enable Memory",
    disable: "Turn Memory off",
    pause: "Pause saving",
    resume: "Resume saving",
    manual: "Manual saving",
    manualDescription:
      "Only “Remember this screen” creates a memory. Automatic saving is off.",
    automatic: "Selected automatic saves",
    automaticSetting: "Save important screen changes automatically",
    automaticDescription:
      "While Screen Awareness and Memory are on, selected stable changes and brief visual events can be saved locally, at most once per minute. This does not save conversation turns. Manual saving remains available. Pause or turn off Memory to stop new saves.",
    consentTitle: "Save selected moments on this computer?",
    consent:
      "Memory starts with manual saving for screens you explicitly choose. Automatic saving requires a separate choice in Settings. Saved items stay in the application’s local data folder until you delete them or the retention period ends. Bookmarked items are protected from automatic cleanup. Screen Awareness and Memory are separate choices.",
    consentSharing:
      "Browsing and searching are local. This version never sends saved Memory to an AI provider. Live Screen Awareness has its own separate sharing permission.",
    consentPolicy:
      "Current limit: {{days}} days and {{size}} MB. Change these in Settings. You can delete individual items or clear all Memory.",
    consentConfirm: "Enable local Memory",
    state: "Memory state",
    search: "Search saved labels",
    searchHint:
      "Local metadata search only. Screen text and meaning are not searched.",
    dateFrom: "From",
    dateTo: "To",
    bookmarksOnly: "Bookmarked only",
    searchButton: "Search",
    searchEmpty: "No memories match these filters.",
    reset: "Reset filters",
    savedCount: "{{count}} saved moments",
    storage: "{{size}} MB used",
    details: "Memory details",
    open: "Open saved memory",
    time: "Saved",
    label: "Label",
    labelOptional: "A label for this moment (optional)",
    labelPlaceholder: "For example: layout idea",
    rememberTitle: "Remember this screen",
    rememberDescription:
      "Save the current screen locally using your Memory settings. This does not send it to your provider.",
    rememberConfirm: "Save this moment",
    bookmark: "Keep this memory",
    bookmarked: "Bookmarked",
    removeBookmark: "Remove bookmark",
    bookmarkNote:
      "Bookmarked memories are excluded from automatic retention. They still count toward your storage limit.",
    deleteTitle: "Delete this memory?",
    deleteDescription:
      "This removes the saved record and its images when no other memory uses them. This cannot be undone.",
    clear: "Clear all Memory",
    clearTitle: "Clear all saved Memory?",
    clearDescription:
      "All saved memories, bookmarks, and their images will be permanently removed. API keys, language, and provider settings are kept.",
    clearConfirm: "Delete all saved memories",
    loadMore: "Load more",
    storageMode: "What to keep",
    visual: "Image and metadata",
    thumbnail: "Small preview and metadata",
    metadata: "Metadata only",
    modeHelp:
      "Metadata contains your label and save time. Image modes also store the selected screen; sensitive information visible on it may be included.",
    retention: "Keep unbookmarked memories for",
    days: "{{count}} days",
    day: "1 day",
    storageLimit: "Storage limit (MB)",
    settingsSave: "Save Memory settings",
    settingsSaved: "Memory settings saved.",
    imageAlt: "Screen saved on {{date}}",
    imageUnavailable: "The saved image is unavailable.",
    metadataOnly: "This memory contains metadata only.",
    imageLoading: "Loading saved image…",
    localOnly: "Stored locally",
    history: "Saved moments",
    error:
      "Memory is unavailable right now. Your conversation can continue. Try again or check your storage settings.",
    MemoryDisabled: "Enable Memory before saving a screen.",
    MemoryPaused: "Memory saving is paused. Resume it to save a screen.",
    MemoryUnavailable:
      "Memory is unavailable right now. Your conversation can continue.",
    MemoryDatabaseUnavailable:
      "Saved Memory could not be opened. Try again after restarting Companion.",
    MemoryMigrationFailed:
      "Memory needs attention before it can be opened. Your conversation can continue.",
    MemoryAssetMissing:
      "The saved image is missing. You can still manage this memory’s details.",
    MemoryWriteFailed:
      "The moment could not be saved. Check available disk space and try again.",
    MemoryDeleteFailed:
      "The memory could not be completely removed. Try again.",
    MemoryPermissionDenied:
      "Companion cannot access its Memory storage. Check folder permissions and try again.",
    MemoryDiskFull:
      "There is not enough space to save this moment. Free space or increase your Memory limit.",
    MemoryStorageLimit:
      "Your Memory limit is full. Delete some saved moments or increase the limit.",
    MemoryNotFound: "This memory is no longer available. Refresh the list.",
    MemoryInvalidInput:
      "Check the Memory settings or search dates and try again.",
    ScreenAwarenessRequired:
      "Start Companion with Screen Awareness on before saving the current screen.",
    unavailable: "Memory needs attention",
    privacy:
      "Saving and browsing are local. This version never sends saved Memory to an AI provider. Live Screen Awareness is managed separately.",
    manualEvent: "Saved screen",
    metadataEvent: "Saved note",
    source: "Source",
    provenance: "Saved by your explicit request",
    automaticProvenance: "Saved by your automatic Memory setting",
    stableEvent: "Important screen change",
    transientEvent: "Brief visual event",
    labelSource: "Your label",
    expires: "Automatic cleanup after {{date}}",
    degraded:
      "Saved Memory is temporarily unavailable. Voice and live screen features can continue.",
    pausedDescription:
      "No new moments are saved while paused. Your existing memories remain available.",
    offConfirmTitle: "Turn off new Memory saves?",
    offConfirm:
      "Existing memories stay on this computer. You can browse or delete them at any time.",
    updateFailed: "Memory settings could not be updated. Try again.",
  },
};
