/** Only translation keys leave this boundary; never display remote bodies. */
export function providerNoticeKey(notice: string | null | undefined): string {
  const text = (notice ?? "").toLowerCase();
  if (
    /text conversation is ready|speech recognition and speech output/.test(text)
  )
    return "settings.recognitionNeeded";
  if (/secure connection|certificate|\btls\b/.test(text))
    return "providerErrors.secureConnection";
  if (/api key|credential|authentication/.test(text))
    return "providerErrors.authentication";
  if (/quota|rate limit/.test(text)) return "providerErrors.quota";
  if (/took too long|timeout|timed out/.test(text))
    return "providerErrors.timeout";
  if (/screen routing|visual decision engine/.test(text))
    return "providerErrors.routing";
  if (/image|vision|visual context|snapshot/.test(text))
    return "providerErrors.visual";
  if (/no usable speech|recognition/.test(text))
    return "providerErrors.recognition";
  if (/microphone/.test(text)) return "home.microphoneError";
  if (/speech|synthesis|audio format/.test(text))
    return "providerErrors.synthesis";
  if (/message is too long/.test(text)) return "providerErrors.messageLimit";
  if (/profile|choose an available|select a configured/.test(text))
    return "providerErrors.profile";
  if (/cancelled/.test(text)) return "providerErrors.cancelled";
  return "providerErrors.request";
}
