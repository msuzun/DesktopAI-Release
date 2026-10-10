export type Language = "en" | "tr";
export interface ProductPreferences {
  version: 1;
  language: Language;
  onboardingCompleted: boolean;
  developerMode: boolean;
}
export const PRODUCT_PREFERENCES_KEY = "companion.product.v1";
export function loadProductPreferences(): ProductPreferences {
  const defaults: ProductPreferences = {
    version: 1,
    language:
      typeof navigator !== "undefined" &&
      navigator.language.toLowerCase().startsWith("tr")
        ? "tr"
        : "en",
    onboardingCompleted: false,
    developerMode: false,
  };
  try {
    const existingProvider = JSON.parse(
      localStorage.getItem("companion.ai.v1") ?? "null",
    );
    defaults.onboardingCompleted =
      typeof existingProvider?.providerId === "string" &&
      existingProvider.providerId.length > 0 &&
      typeof existingProvider?.model === "string";
  } catch {
    /* Invalid provider preferences do not discard product preferences. */
  }
  try {
    const saved = JSON.parse(
      localStorage.getItem(PRODUCT_PREFERENCES_KEY) ?? "null",
    );
    if (saved?.version !== 1) return defaults;
    return {
      ...defaults,
      language:
        saved.language === "tr" || saved.language === "en"
          ? saved.language
          : defaults.language,
      onboardingCompleted: saved.onboardingCompleted === true,
      developerMode: saved.developerMode === true,
    };
  } catch {
    return defaults;
  }
}
export function saveProductPreferences(value: ProductPreferences) {
  try {
    localStorage.setItem(
      PRODUCT_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        language: value.language,
        onboardingCompleted: value.onboardingCompleted,
        developerMode: value.developerMode,
      }),
    );
  } catch {
    /* Session preferences still work when storage is unavailable. */
  }
}
