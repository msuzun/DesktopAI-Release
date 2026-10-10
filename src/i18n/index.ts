import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { loadProductPreferences } from "../product/preferences";
import { en } from "./en";
import { tr } from "./tr";

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, tr: { translation: tr } },
  lng: loadProductPreferences().language,
  fallbackLng: "en",
  supportedLngs: ["en", "tr"],
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});
document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});
export default i18n;
