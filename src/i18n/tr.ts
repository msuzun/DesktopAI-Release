import type { en } from "./en";
type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};
export const tr: LocaleShape<typeof en> = {
  actions: {
    title: "Eylemler",
    beta: "JEV — BETA / DENEYSEL",
    betaNotice:
      "JEV eylem niyetini sınıflandırır. Gerçek komut yürütme ve sesli eylem iş akışları tam olarak doğrulanmamıştır. Gelecek sürümlerde güvenlik, doğruluk ve entegrasyon geliştirilecektir. Her adayı inceleyin; gerçek yürütme kapalı kalır.",
    enable: "Eylem isteklerini incelemeye izin ver",
    notice:
      "Eylemler başlangıçta kapalıdır. Açıldığında, desteklenen açık istekler yorumlanmak üzere JEV’e gönderilebilir. Her eylem inceleme ve onay gerektirir. Sesli yanıtlar ve AI çıktıları yürütmeyi onaylayamaz.",
    validationPending:
      "Eylem adaylarını inceleyebilirsiniz. Eylem güvenliği kabulü tamamlanana kadar yürütme kullanılamaz.",
    error: "Eylem ayarları kullanılamıyor. Yeni eylemler çalıştırılamaz.",
    confirmTitle: "Eylemi incele",
    confirmNotice:
      "Yalnızca bu eylem tam olarak istediğiniz işlemse onaylayın. Yeni istek, kesinti veya süre sonu bu onayı iptal eder.",
    kind: "Eylem türü",
    kinds: {
      application: "Uygulama",
      terminal: "Terminal",
      command: "Sentetik komut",
      script: "Sentetik script",
    },
    executable: "Çalıştırılabilir dosya",
    arguments: "Tam bağımsız değişkenler",
    workingDirectory: "Çalışma dizini",
    content: "Tam komut veya script",
    expires: "Onay geçerlilik sonu",
    identity: "Aday kimliği",
    candidateId: "Aday ID",
    digest: "Aday SHA-256",
    executableHash: "Çalıştırılabilir dosya SHA-256",
    turn: "İstek ID",
    reject: "Eylemi iptal et",
    confirm: "Bu eylemi onayla",
  },
  routingReadiness: {
    currentScreen: "Güncel ekran modu seçili; yerel model gerektirmez.",
    noValidatedEngine:
      "Otomatik akıllı yönlendirme bu sürümde kullanılamıyor: doğruluk eşiğini geçen bir model yok. Sohbeti durdurup Güncel ekran modunu seçebilirsiniz. Deneysel LAYA değerlendirmesi için Ayarlar > Geliştirici Modu > Akıllı Görsel Yönlendirme’yi kullanın.",
    legacy:
      "Ekran yönlendirmesi yerel LAYA gerektirir. Güncel yönlendirme ayarlarını geri yüklemek için Geliştirici Modu’nda Otomatik’i seçin.",
    localOnly:
      "Engellendi: {{engine}} bulut erişimi gerektiriyor, ancak yönlendirme bu bilgisayarla sınırlı.",
    remoteConsent:
      "Engellendi: {{engine}} için Geliştirici Modu’nda açık bulut değerlendirme onayı gerekiyor.",
    loading: "{{engine}} yükleniyor. Ekran yönlendirmesi henüz hazır değil.",
    unavailable:
      "Engellendi: seçilen motor hazır değil. Geliştirici Modu’nda mevcut kurulumunu ve durumunu kontrol edin.",
    experimental:
      "{{engine}} deneysel değerlendirme için kullanılabilir. Yönlendirme doğruluğu henüz doğrulama eşiğini geçmedi.",
    ready: "{{engine}} görsel yönlendirme için hazır ve doğrulanmış.",
  },
  developer: {
    title: "Geliştirici araçları",
    finishTurn: "Konuşmayı bitir ve yanıtla",
    capture: "Yerel ekran yakalama ve görsel algılama",
    captureNote:
      "Elle alınan deneme görüntüleri yerel kalır. Ekran Farkındalığı kapalıysa geçici yerel oturum görüntü alındıktan sonra kapanır.",
    captureScreen: "Ekran görüntüsü al",
    captureDetail: "Ayrıntı görüntüsü al",
    routing: "Görsel yönlendirme ayarları",
    shadow: "Görsel yönlendirmeyi Shadow modunda değerlendir",
    fallback: "Teknik hata durumunda yedek motor",
    fallbackNote:
      "Başarısız bir değerlendirme mevcut ses ve ekran yanıtlarını durdurmaz. NONE dâhil başarılı kararlar başka bir motoru tetiklemez.",
    laya: "LAYA yerel çalışma ortamı — BETA / DENEYSEL",
    layaBetaNotice:
      "LAYA görsel niyeti yerel olarak yönlendirir. Zamansal ve referansa dayalı yönlendirme doğruluğu üretim kullanımına hazır değildir. Gelecek sürümlerde güvenilirlik ve performans geliştirilecektir. Hatalı veya kullanılamayan seçimler yanıtı engelleyebilir.",
    installNote:
      "İsteğe bağlı olarak ayrıca kurulur. Buradan model indirilmez. Değerlendirmeden önce bir kez hazırlayın; model konuşma turları arasında yüklü kalır.",
    python: "Python yürütülebilir dosyası",
    pythonPath: "İsteğe bağlı çalışma ortamının python.exe dosyasının tam yolu",
    modelPath: "Model dizini",
    modelPathHint: "Özeti doğrulanmış modelin tam yolu",
    checkpoint: "Model",
    multilingual: "Çok dilli",
    english: "İngilizce",
    typed: "Tür tanımlı kararlar",
    device: "Aygıt",
    cuda: "CUDA (uyumlu isteğe bağlı çalışma ortamı gerektirir)",
    prepare: "Yerel modeli hazırla",
    unload: "Yerel modeli bellekten kaldır",
    jev: "JEV eylem yorumlama — BETA / DENEYSEL",
    jevNotice:
      "JEV açık eylem isteklerini yorumlar. Sınırlı istek metnini alır; ekran görüntülerini veya kayıtlı Hafıza’yı almaz. Eylemleri çalıştıramaz. Mevcut JEV anahtarınız korunur.",
    remoteConsent: "Bu oturumda bulut Shadow değerlendirmesine izin ver",
    jevKey: "Jev API anahtarı",
    jevKeyHint: "TypeSafe API anahtarınız",
    jevSave: "Jev anahtarını kaydet",
    jevRemove: "Kayıtlı Jev anahtarını kaldır",
    jevSaved:
      "Jev anahtarı güvenli depoya kaydedildi. Doğrulama isteği gönderilmedi.",
    jevRemoved: "Kayıtlı Jev anahtarı kaldırıldı.",
    jevError: "Güvenli kimlik bilgisi deposundaki Jev anahtarı güncellenemedi.",
    jevKeyNotice:
      "Anahtarlar Windows Kimlik Bilgisi Yöneticisi’nde tutulur. Ortam anahtarı kayıtlı anahtardan önceliklidir. Eylemler’i kapatmak yeni istekleri durdurur; gönderilmiş metin geri alınamaz.",
    error:
      "Yönlendirme ayarlarında bir sorun var. Aşağıdaki motor durumunu inceleyin.",
    status: "Durum",
    legacyPanels:
      "Teknik ölçümlerde motorların özgün tanımları kullanılır. Sohbet ve ekran içeriği çevrilmez.",
  },
  app: {
    name: "AI Desktop Companion",
    tagline: "Çalışırken size eşlik eden bir yardımcı.",
    home: "Ana Sayfa",
    memory: "Hafıza",
    settings: "Ayarlar",
    navigation: "Ana menü",
  },
  common: {
    on: "Açık",
    off: "Kapalı",
    paused: "Duraklatıldı",
    ready: "Hazır",
    unavailable: "Kullanılamıyor",
    save: "Kaydet",
    cancel: "Vazgeç",
    close: "Kapat",
    delete: "Sil",
    next: "İleri",
    back: "Geri",
    refresh: "Yenile",
    loading: "Yükleniyor…",
    working: "İşlem sürüyor…",
    retry: "Yeniden dene",
    configured: "Yapılandırıldı",
    notConfigured: "Kurulum gerekli",
    all: "Tümü",
    today: "Bugün",
    yesterday: "Dün",
    earlier: "Daha önce",
    confirm: "Onayla",
    optional: "İsteğe bağlı",
    bytes: "{{value}} MB",
    none: "Yok",
    learnMore: "Daha fazla bilgi",
  },
  home: {
    textReady: "Yazılı sohbet hazır",
    message: "Sorunuz",
    messagePlaceholder: "Bir soru sorun veya ekranınız hakkında bilgi isteyin…",
    messageStart: "Soru sormak için Companion’ı başlatın.",
    send: "Soruyu gönder",
    interrupt: "Yanıtı kes",
    conversation: "Sohbet",
    you: "Siz",
    assistant: "Companion",
    eyebrow: "SİZE EŞLİK EDEN YARDIMCI",
    title: "Bir sohbete yer açın.",
    intro: "İşinizi konuşun, bir soru sorun veya sesli düşünün.",
    session: "Companion oturumu",
    ready: "Siz hazır olduğunuzda",
    connecting: "Bağlanıyor…",
    stopping: "Durduruluyor…",
    connectionFailed: "Bağlantı kurulamadı",
    testing: "Bağlantı deneniyor…",
    muted: "Mikrofon sessizde",
    paused: "Sohbet duraklatıldı",
    speaking: "Konuşuyor",
    thinking: "Düşünüyor",
    listening: "Dinliyor",
    start: "Companion’ı başlat",
    stop: "Companion’ı durdur",
    mute: "Mikrofonu sustur",
    unmute: "Mikrofonu aç",
    restart: "Sohbeti yeniden başlat",
    audioNotice:
      "Başlattığınızda mikrofon sesi {{provider}} hizmetine gönderilir.",
    wait: "Konuşmadan önce Companion’ın hazır olmasını bekleyin.",
    setup:
      "Konuşmaya başlamak için Ayarlar’dan sağlayıcınızın API anahtarını ekleyin.",
    configure: "Yapay zekâ sağlayıcısını ayarla",
    responseFailed: "Yanıt alınamadı. Sohbeti yeniden başlatıp tekrar sorun.",
    voiceNotice:
      "Sesli görüşmede bir sorun var. Sohbet durduysa yeniden başlatın.",
    sessionError:
      "Sohbet sürdürülemedi. Sağlayıcı ayarlarını ve bağlantınızı kontrol edip tekrar deneyin.",
    microphoneError:
      "Mikrofona erişilemiyor. Sistem ayarlarından mikrofon erişimine izin verip tekrar deneyin.",
    retryVisual: "Güncel ekranı yeniden dene",
    visualError:
      "Bu soru için ekranınız hazırlanamadı. Yanıt bekletiliyor. Yeniden deneyin veya Ekran Farkındalığı’nı kapatıp yalnızca sesli bir sohbet başlatın.",
    routingError:
      "Bu soru için kullanılacak ekran bağlamı seçilemedi. Yanıt bekletiliyor. Yeniden deneyin; sorun sürerse Ayarlar’daki görsel yönlendirme durumunu kontrol edin.",
    routingTimeout:
      "Bu soru için ekran bağlamını seçme işlemi zaman aşımına uğradı. Yanıt bekletiliyor. Yeniden deneyin; sorun sürerse Ayarlar’daki yerel model durumunu kontrol edin.",
    routingBusy:
      "Yerel model önceki ekran bağlamı seçimini hâlâ işliyor. Biraz bekleyip yeniden deneyin.",
    screenSendingError:
      "Ekran bağlamı gönderilemedi. Bağlantınızı kontrol edip tekrar deneyin.",
    screenExpired:
      "Bu soru için alınan ekran görüntüsünün süresi doldu. Güncel ekranınızı yeniden deneyin.",
    screenUnavailable:
      "Bu soru için güncel ekran görüntüsü alınamadı. Görüntü gönderilmedi ve yanıt bekletiliyor. Güncel ekranı yeniden deneyin.",
    screenTooLarge:
      "Ekran görüntüsü bu bağlantının boyut sınırını aşıyor. Görüntü gönderilmedi ve yanıt bekletiliyor.",
    screenReadbackFailed:
      "Yakalanan ekran görüntüsü okunamadı. Görüntü gönderilmedi. Güncel ekranı yeniden deneyin.",
    screenEncodingFailed:
      "Ekran görüntüsü gönderim için kodlanamadı. Görüntü gönderilmedi. Güncel ekranı yeniden deneyin.",
    screenPermission:
      "Ekran erişimi kesildi. Companion’ı durdurup yeniden başlatın.",
    screenBusy:
      "Ekran bağlamı hâlâ hazırlanıyor. Biraz bekleyip tekrar deneyin.",
    screenTimeout: "Ekranın güncellenmesi çok uzun sürdü. Yeniden deneyin.",
    screenReceived:
      "Bu soru için {{count}} ekran görüntüsünün alındığını sağlayıcı doğruladı.",
    screenSent: "Bu soru için {{count}} ekran görüntüsü gönderildi.",
    screenNoImage:
      "Bu soru için kullanılabilir ekran görüntüsü bulunamadı; görüntü gönderilmedi.",
    screenNotUsed: "Akıllı yönlendirme bu soru için ekran görüntüsü seçmedi.",
    screen: "Ekran Farkındalığı",
    screenOn:
      "Sohbet sırasında seçilen ekran bağlamı yapay zekâ sağlayıcınızla paylaşılabilir.",
    screenOff: "Ekranınız yapay zekâ ile paylaşılmıyor.",
    screenIdle: "Companion’ı başlattığınızda ekranınızı kullanmaya hazır.",
    screenStop:
      "Bunu kapatmak sohbeti durdurur. Yalnızca sesle devam etmek için yeniden başlatın.",
    screenDescription:
      "Ekran analizi bu bilgisayarda yapılır. Açıkken seçilen görsel bağlam yapay zekâ sağlayıcınıza gönderilebilir. Geçici görsel geçmişin süresi dolar; kayıtlı Hafıza’dan ayrıdır.",
    provider: "Yapay zekâ sağlayıcısı",
    routing: "Görsel yönlendirme",
    routingState: "Yerel LAYA",
    routingDescription:
      "Yerel LAYA görsel bağlamı seçer. Ekran yönlendirmesi yayımlanmadan önce doğruluk eşiğini geçmelidir.",
    memoryOff: "Hiçbir ekran anı kaydedilmiyor.",
    memoryManual: "Yalnızca elle kayıt · {{count}} kayıt",
    memoryAutomatic: "Seçilen önemli değişiklikler · {{count}} kayıt",
    memoryPaused: "Yeni kayıtlar duraklatıldı · {{count}} kayıt",
    remember: "Bu ekranı hatırla",
    rememberHint:
      "Güncel ekranınızı kaydetmek için Companion’ı Ekran Farkındalığı açıkken başlatın.",
    openMemory: "Hafıza’yı aç",
    saved: "Ekran Hafıza’ya kaydedildi.",
    savedDuplicate: "Bu ekran zaten Hafıza’da kayıtlı.",
  },
  providerErrors: {
    secureConnection:
      "Bu sağlayıcıyla güvenli bağlantı kurulamadı. Hizmet adresini ve sertifikasını kontrol edin veya yapılandırılmış başka bir sağlayıcı seçin.",
    authentication:
      "Bu hizmet için geçerli bir API anahtarı gerekiyor. Yapay Zekâ ve Ses ayarlarındaki profilini kontrol edin.",
    quota:
      "Bu hizmetin kullanım veya istek sınırına ulaşıldı. Daha sonra tekrar deneyin ya da yapılandırılmış başka bir sağlayıcı seçin.",
    timeout:
      "Bu hizmet zamanında yanıt vermedi. Başka bir soru sorabilir veya sağlayıcı değiştirebilirsiniz.",
    routing:
      "Ekran yönlendirmesi hazır değil. Ayarlar’daki Akıllı Görsel Yönlendirme’yi kontrol edin veya yazılı sorular için Ekran Farkındalığı’nı kapatın.",
    visual:
      "İstenen ekran bağlamı kullanılamıyor veya bu model görüntüyü kabul edemiyor. Modelin görüntü desteğini kontrol edin; sorunuz sessizce değiştirilmedi.",
    recognition:
      "Konuşma tanınamadı. Yeniden konuşmayı deneyin veya sorunuzu yazın.",
    synthesis:
      "Yanıt seslendirilemedi. Alınan yanıt metin olarak kullanılabilir. Seslendirme profilini kontrol edin veya tekrar deneyin.",
    messageLimit: "Bu ileti çok uzun. Kısaltıp tekrar deneyin.",
    profile:
      "Bu hizmet profili kullanılamıyor. Yapay Zekâ ve Ses ayarlarından bir sağlayıcı seçin veya yapılandırın.",
    cancelled: "Yanıt durduruldu. Yeni bir soru sorabilirsiniz.",
    request:
      "Bu sağlayıcı isteği tamamlayamadı. Ayarlarını kontrol edin veya yapılandırılmış başka bir sağlayıcı seçin.",
  },
  settings: {
    aiVoice: "Yapay Zekâ ve Ses",
    chooseProvider: "Bir yapay zekâ sağlayıcısı seçin",
    noKeyNeeded: "Bu profil API anahtarı gerektirmiyor.",
    composedVoice:
      "Companion konuşmanızı tanıyabilir ve bu modelin yanıtlarını seslendirebilir. Sağlayıcının kendi ses API’si olması gerekmez.",
    noVision:
      "Bu model yalnızca metin için yapılandırılmış. Ekran soruları için görüntü destekleyen bir model gerekir.",
    recognition: "Konuşma tanıma",
    chooseRecognition: "Bir konuşma tanıma profili seçin",
    synthesis: "Sesli yanıtlar",
    chooseSynthesis: "Bir seslendirme profili seçin",
    systemVoice: "Bu bilgisayarın sistem sesi",
    speechLanguage: "Konuşma dili",
    recognitionNeeded:
      "Sesli sohbet için konuşma tanıma ve seslendirme profillerini seçin. Yazılı sorular kullanılabilir.",
    voicePrivacy:
      "Mikrofon: {{recognition}}. Akıl yürütme ve seçilen ekran bağlamı: {{reasoning}}. Sesli yanıtlar: {{synthesis}}.",
    addProvider: "Yapay zekâ veya ses sağlayıcısı ekle",
    manageProfiles: "Yapılandırılmış sağlayıcılar",
    chooseProfile: "Yönetilecek profili seçin",
    editProfile: "Profili düzenle",
    deleteProfileConfirm:
      "Bu profil ve kayıtlı API anahtarı kaldırılsın mı? Seçili yapay zekâ kaldırılırsa sohbet için yeniden sağlayıcı seçmeniz gerekir.",
    configureProfile: "Sağlayıcıyı yapılandır",
    displayName: "Görünen ad",
    integration: "Bağlantı türü",
    compatibleProvider: "Uyumlu yapay zekâ sağlayıcısı",
    recognitionService: "Uyumlu konuşma tanıma",
    synthesisService: "Uyumlu seslendirme",
    endpoint: "Hizmetin temel adresi",
    endpointPolicy:
      "Uzak hizmetler için HTTPS kullanın. HTTP yalnızca bu bilgisayardaki yerel geri döngü hizmetlerinde kullanılabilir. Adrese anahtar eklemeyin.",
    endpointImmutable:
      "Hizmet adresini veya kimlik doğrulamasını değiştirmek için yeni bir profil oluşturup anahtarını ayrıca girin.",
    authentication: "Kimlik doğrulama",
    noAuthentication: "API anahtarı yok",
    replaceKeyOptional:
      "Yeni API anahtarı (kayıtlı anahtarı korumak için boş bırakın)",
    declaredCapabilities:
      "Seçtiğiniz modelin desteklediği özellikleri belirtin. Bu ayarlar doğrulanmış bir yetenek testi değildir.",
    supportsVision: "Görüntüleri kabul eder",
    supportsCompare: "Karşılaştırma için birden çok görüntüyü kabul eder",
    supportsStreaming: "Metni oluşturuldukça iletir",
    profileSaved:
      "Sağlayıcı profili kaydedildi. Kullanmak istediğinizde yukarıdan seçin.",
    profileRemoved: "Sağlayıcı profili ve kayıtlı anahtarı kaldırıldı.",
    profileError:
      "Değişiklik kaydedilemedi. Hizmet adresini, modeli ve güvenli anahtar deposunu kontrol edin. Kaydedilmiş bir profil için hâlâ anahtar gerekebilir.",
    compatibleScope:
      "Uyumlu yapay zekâ bağlantısı Chat Completions biçimini; ses bağlantıları konuşma tanıma veya seslendirme adreslerini kullanır. Destek hizmete ve modele göre değişir. İstekler bu bilgisayardan doğrudan seçilen hizmete gider.",
    title: "Size uygun hale getirin.",
    intro: "Sesiniz, diliniz ve gizlilik tercihleriniz.",
    general: "Genel",
    language: "Arayüz dili",
    languageNote: "Değişiklik hemen uygulanır. Sohbet dili bundan bağımsızdır.",
    provider: "Yapay zekâ sağlayıcısı",
    model: "Model",
    voice: "Ses",
    key: "API anahtarı",
    keyPlaceholder: "Sağlayıcınızın API anahtarını girin",
    keyChecking: "Güvenli anahtar deposu kontrol ediliyor…",
    keyMissing: "Devam etmek için bir API anahtarı ekleyin.",
    keySaved: "API anahtarı güvenli depoya kaydedildi.",
    keyRemoved: "API anahtarı kaldırıldı.",
    keyError:
      "Değişiklik kaydedilemedi. API anahtarını kontrol edip tekrar deneyin.",
    keyUnavailable:
      "Güvenli anahtar deposuna erişilemiyor. Masaüstü uygulamasını açıp tekrar deneyin.",
    changeKey: "API anahtarını değiştir",
    removeKey: "API anahtarını kaldır",
    cancelKey: "Anahtar değişikliğinden vazgeç",
    test: "Bağlantıyı dene",
    testSuccess: "Bağlantı başarılı",
    testDone:
      "Bağlantı denemesi tamamlandı. Bağlantı hâlâ kurulamıyorsa geliştirici tanılamasındaki sonucu inceleyin.",
    keyPrivacy:
      "API anahtarları Windows Kimlik Bilgisi Yöneticisi’nde tutulur; tarayıcı deposunda veya projeye ait bir sunucuda saklanmaz. Bağlantı denemesi sağlayıcı ücreti doğurabilir.",
    sessionLocked: "Sağlayıcı ayarlarını değiştirmeden önce sohbeti durdurun.",
    privacy: "Ekran ve gizlilik",
    privacyNote:
      "Ekran Farkındalığı’nı kapatmak geçici görsel geçmişi temizler ve yeni ekran gönderimlerini durdurur. Sağlayıcıya gönderilmiş görüntüleri geri alamaz. Kayıtlı Hafıza ayrıca yönetilir.",
    advanced: "Gelişmiş",
    developer: "Geliştirici Modu",
    developerNote: "Teknik tanılamayı ve deneme araçlarını gösterir.",
    tools: "Geliştirici araçları",
    loadingTools: "Geliştirici araçları yükleniyor…",
    onboarding: "Karşılama kurulumunu yeniden göster",
    diagnostics: "Hafıza tanılaması",
    routing: "Akıllı Görsel Yönlendirme",
    routingEngine: "Görsel niyet motoru",
    screenContextMode: "Ekran paylaşım modu",
    screenContextCurrent: "Güncel ekran",
    screenContextSemantic: "Akıllı seçim — LAYA (BETA / DENEYSEL)",
    screenContextCurrentNote:
      "Ekran Farkındalığı açıkken sorunuz metne çevrildikten sonra güncel ekran görüntüsü alınır ve yanıttan önce gönderilir. Bu mod önceki ekranları seçmez; LAYA kurulumu gerektirmez. Modu değiştirmek için sohbeti durdurun.",
    screenContextSemanticNote:
      "LAYA görsel niyeti yerel olarak yönlendirerek güncel ekranı, geçici geçmişi veya görüntü göndermemeyi seçer. Zamansal ve referansa dayalı doğruluk üretim kullanımına hazır değildir; güvenilirlik ve performans geliştirilmelidir. Geliştirici Modu’nda hazırlayın. Başarısız seçim yanıtı bekletir.",
    auto: "Otomatik",
    legacy: "Uyumluluk",
    localOnly: "Yönlendirme değerlendirmelerini bu bilgisayarda tut",
    routingNote:
      "Görsel niyet bu bilgisayarda LAYA tarafından sınıflandırılır. JEV yalnızca eylem istekleri için kullanılır. Yerel kurulum ve deneysel değerlendirme Geliştirici Modu’ndadır; deneysel bir yapılandırma seçmek doğruluğunu onaylamaz.",
    encryption:
      "Kayıtlı Hafıza bu bilgisayarda tutulur ve uygulama tarafından ayrıca şifrelenmez. Windows hesabınızın ve diskinizin koruması geçerlidir.",
    storageLocation: "Depolama konumu",
    storageLocationNote:
      "Hafıza, bu uygulamanın yerel veri klasöründe saklanır. Hafıza’yı temizlemek kayıtları ve ilgili görüntüleri siler.",
    memoryLink: "Kayıtlı anları yönet",
  },
  onboarding: {
    label: "Karşılama kurulumu",
    step: "Adım {{current}} / {{total}}",
    welcomeTitle: "Merhaba. Birlikte ayarlayalım.",
    welcome:
      "Companion, izin verdiğinizde ekranınızdan seçilen bağlamı anlayabilen sesli bir yapay zekâ yardımcısıdır.",
    language: "Dilinizi seçin",
    providerTitle: "Kiminle konuşacağınızı seçin.",
    provider:
      "Bir yapay zekâ sağlayıcısı seçin. Ayarlar’dan uyumlu metin veya görüntü modelleri ekleyebilir, konuşma tanıma ve seslendirmeyi ayrı ayrı seçebilirsiniz. Kurulumu daha sonra tamamlayabilirsiniz.",
    screenTitle: "Nelerin görüleceğine siz karar verin.",
    screen:
      "Ekran Farkındalığı ekranınızı yerel olarak analiz eder ve seçilen görüntüleri yapay zekâ sağlayıcınıza gönderebilir. Companion her açıldığında kapalı başlar.",
    routingTitle: "Sohbeti sade tutun.",
    routing:
      "Güncel ekran modu, Ekran Farkındalığı açıkken her soruda güncel görüntüyü paylaşır. Deneysel akıllı seçim için LAYA’yı ayrıca yapılandırabilirsiniz. Ekran paylaşımı kayıtlı Hafıza’yı veya Eylemler’i açmaz.",
    memoryTitle: "Bir anı yalnızca siz istediğinizde saklayın.",
    memory:
      "Kalıcı Görsel Hafıza, “Bu ekranı hatırla” düğmesine bastığınızda bir ekranı bu bilgisayara kaydedebilir. Başlangıçta kapalıdır. Ayarlar’dan seçili otomatik kayıtları ayrıca açabilirsiniz. Arama, ekranın anlamı üzerinde değil, kayıtlı etiketlerde çalışır.",
    finish: "Companion’ı aç",
    later: "Hafıza şimdilik kapalı kalsın",
    completed:
      "Tercihleriniz hazır. Bunları istediğiniz zaman Ayarlar’dan değiştirebilirsiniz.",
  },
  memory: {
    title: "İşe yarayan anlar için bir yer.",
    intro: "Saklamayı seçtiğiniz ekranlara bu bilgisayarda yeniden bakın.",
    titleShort: "Kalıcı Görsel Hafıza",
    disabled: "Kalıcı Hafıza kapalı.",
    disabledDescription:
      "Yeni ekran anları kaydedilmez. Önceki kayıtlarınıza aşağıdan ulaşabilirsiniz.",
    empty: "Henüz bir an kaydedilmedi.",
    emptyDescription:
      "Hafıza’yı açın, Companion’ı Ekran Farkındalığı açıkken başlatın ve “Bu ekranı hatırla” seçeneğini kullanın. Ayarlar’dan seçili otomatik kayıtları ayrıca açabilirsiniz.",
    enable: "Hafıza’yı aç",
    disable: "Hafıza’yı kapat",
    pause: "Kaydı duraklat",
    resume: "Kayda devam et",
    manual: "Elle kayıt",
    manualDescription:
      "Yalnızca “Bu ekranı hatırla” bir kayıt oluşturur. Otomatik kayıt kapalıdır.",
    automatic: "Seçili otomatik kayıtlar",
    automaticSetting: "Önemli ekran değişikliklerini otomatik kaydet",
    automaticDescription:
      "Ekran Farkındalığı ve Hafıza açıkken seçilen kalıcı değişiklikler ve kısa görsel olaylar, dakikada en fazla bir kez yerel olarak kaydedilebilir. Bu seçenek sohbet turlarını kaydetmez. Elle kayıt kullanılmaya devam eder. Yeni kayıtları durdurmak için Hafıza’yı duraklatın veya kapatın.",
    consentTitle: "Seçtiğiniz anlar bu bilgisayara kaydedilsin mi?",
    consent:
      "Hafıza başlangıçta yalnızca açıkça seçtiğiniz ekranları elle kaydeder. Otomatik kayıt, Ayarlar’da ayrıca seçilmelidir. Kayıtlar siz silene veya saklama süresi dolana kadar uygulamanın yerel veri klasöründe tutulur. İşaretlediğiniz kayıtlar otomatik temizlemeden korunur. Ekran Farkındalığı ve Hafıza ayrı tercihlerdir.",
    consentSharing:
      "Göz atma ve arama yereldir. Bu sürüm kayıtlı Hafıza’yı hiçbir zaman yapay zekâ sağlayıcısına göndermez. Canlı Ekran Farkındalığı’nın paylaşım izni ayrıdır.",
    consentPolicy:
      "Geçerli sınır: {{days}} gün ve {{size}} MB. Bunları Ayarlar’dan değiştirebilirsiniz. Tek bir kaydı silebilir veya Hafıza’yı tamamen temizleyebilirsiniz.",
    consentConfirm: "Yerel Hafıza’yı aç",
    state: "Hafıza durumu",
    search: "Kayıtlı etiketlerde ara",
    searchHint:
      "Yalnızca yerel üst veriler aranır. Ekrandaki metin veya anlam aranmaz.",
    dateFrom: "Başlangıç",
    dateTo: "Bitiş",
    bookmarksOnly: "Yalnızca işaretlenenler",
    searchButton: "Ara",
    searchEmpty: "Bu filtrelere uyan kayıt yok.",
    reset: "Filtreleri temizle",
    savedCount: "{{count}} kayıtlı an",
    storage: "{{size}} MB kullanılıyor",
    details: "Kayıt ayrıntıları",
    open: "Kayıtlı anı aç",
    time: "Kayıt zamanı",
    label: "Etiket",
    labelOptional: "Bu an için bir etiket (isteğe bağlı)",
    labelPlaceholder: "Örneğin: düzen fikri",
    rememberTitle: "Bu ekranı hatırla",
    rememberDescription:
      "Güncel ekranı Hafıza ayarlarınızla bu bilgisayara kaydedin. Bu işlem görüntüyü sağlayıcınıza göndermez.",
    rememberConfirm: "Bu anı kaydet",
    bookmark: "Bu kaydı sakla",
    bookmarked: "İşaretlendi",
    removeBookmark: "İşareti kaldır",
    bookmarkNote:
      "İşaretli kayıtlar otomatik saklama süresinden etkilenmez. Depolama sınırına dâhil olmaya devam ederler.",
    deleteTitle: "Bu kayıt silinsin mi?",
    deleteDescription:
      "Kayıt ve başka bir kaydın kullanmadığı görüntüleri silinir. Bu işlem geri alınamaz.",
    clear: "Tüm Hafıza’yı temizle",
    clearTitle: "Kayıtlı Hafıza tamamen silinsin mi?",
    clearDescription:
      "Tüm kayıtlar, işaretler ve ilgili görüntüler kalıcı olarak silinir. API anahtarları, dil ve sağlayıcı ayarları korunur.",
    clearConfirm: "Tüm kayıtlı anları sil",
    loadMore: "Daha fazla yükle",
    storageMode: "Saklanacak içerik",
    visual: "Görüntü ve üst veri",
    thumbnail: "Küçük önizleme ve üst veri",
    metadata: "Yalnızca üst veri",
    modeHelp:
      "Üst veriler etiketinizi ve kayıt zamanını içerir. Görüntü seçenekleri seçilen ekranı da saklar; ekranda görünen hassas bilgiler kayda girebilir.",
    retention: "İşaretlenmemiş kayıtların saklama süresi",
    days: "{{count}} gün",
    day: "1 gün",
    storageLimit: "Depolama sınırı (MB)",
    settingsSave: "Hafıza ayarlarını kaydet",
    settingsSaved: "Hafıza ayarları kaydedildi.",
    imageAlt: "{{date}} tarihinde kaydedilen ekran",
    imageUnavailable: "Kayıtlı görüntü kullanılamıyor.",
    metadataOnly: "Bu kayıt yalnızca üst veri içerir.",
    imageLoading: "Kayıtlı görüntü yükleniyor…",
    localOnly: "Yerel olarak saklanıyor",
    history: "Kayıtlı anlar",
    error:
      "Hafıza şu anda kullanılamıyor. Sohbetiniz devam edebilir. Yeniden deneyin veya depolama ayarlarını kontrol edin.",
    MemoryDisabled: "Ekran kaydetmeden önce Hafıza’yı açın.",
    MemoryPaused:
      "Hafıza kaydı duraklatıldı. Ekran kaydetmek için kayda devam edin.",
    MemoryUnavailable:
      "Hafıza şu anda kullanılamıyor. Sohbetiniz devam edebilir.",
    MemoryDatabaseUnavailable:
      "Kayıtlı Hafıza açılamadı. Companion’ı yeniden başlatıp deneyin.",
    MemoryMigrationFailed:
      "Hafıza’nın açılmadan önce onarılması gerekiyor. Sohbetiniz devam edebilir.",
    MemoryAssetMissing:
      "Kayıtlı görüntü bulunamadı. Kayıt ayrıntılarını yönetmeye devam edebilirsiniz.",
    MemoryWriteFailed:
      "Bu an kaydedilemedi. Boş disk alanını kontrol edip tekrar deneyin.",
    MemoryDeleteFailed: "Kayıt tamamen silinemedi. Yeniden deneyin.",
    MemoryPermissionDenied:
      "Companion, Hafıza deposuna erişemiyor. Klasör izinlerini kontrol edip tekrar deneyin.",
    MemoryDiskFull:
      "Bu anı kaydetmek için yeterli alan yok. Alan açın veya Hafıza sınırını artırın.",
    MemoryStorageLimit:
      "Hafıza sınırınız doldu. Bazı anları silin veya sınırı artırın.",
    MemoryNotFound: "Bu kayıt artık mevcut değil. Listeyi yenileyin.",
    MemoryInvalidInput:
      "Hafıza ayarlarını veya arama tarihlerini kontrol edip tekrar deneyin.",
    ScreenAwarenessRequired:
      "Güncel ekranı kaydetmeden önce Companion’ı Ekran Farkındalığı açıkken başlatın.",
    unavailable: "Hafıza’da bir sorun var",
    privacy:
      "Kaydetme ve göz atma yereldir. Bu sürüm kayıtlı Hafıza’yı hiçbir zaman yapay zekâ sağlayıcısına göndermez. Canlı Ekran Farkındalığı ayrıca yönetilir.",
    manualEvent: "Kaydedilen ekran",
    metadataEvent: "Kaydedilen not",
    source: "Kaynak",
    provenance: "Açık isteğinizle kaydedildi",
    automaticProvenance: "Otomatik Hafıza ayarınızla kaydedildi",
    stableEvent: "Önemli ekran değişikliği",
    transientEvent: "Kısa görsel olay",
    labelSource: "Etiketiniz",
    expires: "{{date}} sonrasında otomatik temizlenir",
    degraded:
      "Kayıtlı Hafıza geçici olarak kullanılamıyor. Ses ve canlı ekran özellikleri devam edebilir.",
    pausedDescription:
      "Duraklatıldığında yeni anlar kaydedilmez. Mevcut kayıtlarınıza ulaşmaya devam edebilirsiniz.",
    offConfirmTitle: "Yeni Hafıza kayıtları kapatılsın mı?",
    offConfirm:
      "Mevcut kayıtlar bu bilgisayarda kalır. Bunlara istediğiniz zaman göz atabilir veya silebilirsiniz.",
    updateFailed: "Hafıza ayarları güncellenemedi. Yeniden deneyin.",
  },
};
