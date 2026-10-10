import { voiceConfig } from "./config.js";
import { VoiceError } from "./errors.js";

export interface Credential {
  clientSecret: string;
  expiresAt: number;
  model: string;
}
const brokerErrors: Record<string, string> = {
  api_key_missing:
    "The broker has no OPENAI_API_KEY. Configure it in the broker terminal and restart the broker.",
  openai_access_denied:
    "OpenAI rejected the broker key or model access. Check the key and project permissions.",
  openai_rate_limit:
    "OpenAI quota or rate limit reached. Check API billing and try again later.",
  credential_creation_failed:
    "OpenAI could not create a voice credential. Check the broker model and voice settings.",
  openai_unavailable:
    "The broker cannot reach OpenAI. Check its internet connection.",
  openai_timeout: "OpenAI credential creation timed out. Try again.",
};

export async function getCredential(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Credential> {
  let response: Response;
  try {
    response = await fetcher(voiceConfig.brokerUrl, {
      method: "POST",
      headers: { "X-Desktop-Companion": "voice-m3" },
      signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw new VoiceError(
      "Local voice broker unavailable. Start it on 127.0.0.1:4317, then try again.",
    );
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;
    throw new VoiceError(
      brokerErrors[data?.code ?? ""] ??
        (response.status === 429
          ? "Too many session attempts. Wait a minute and try again."
          : "The local broker could not create a voice credential."),
    );
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object")
    throw new VoiceError("The broker returned an invalid credential.");
  const value = data as Partial<Credential>;
  if (
    typeof value.clientSecret !== "string" ||
    !value.clientSecret.startsWith("ek_") ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt * 1000 <= Date.now() ||
    typeof value.model !== "string" ||
    !value.model
  )
    throw new VoiceError(
      "The broker returned an invalid or expired voice credential.",
    );
  return value as Credential;
}

export async function exchangeOffer(
  fetcher: typeof fetch,
  offer: string,
  credential: Credential,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetcher(voiceConfig.callsUrl, {
    method: "POST",
    body: offer,
    headers: {
      Authorization: `Bearer ${credential.clientSecret}`,
      "Content-Type": "application/sdp",
    },
    signal,
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    // Provider messages can echo request data. Classify them into fixed text;
    // never expose the raw response, SDP, headers, or credential.
    const body = await response.text().catch(() => "");
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      /* Some call failures use plain text. */
    }
    const code = data?.error?.code ?? data?.error?.type;
    const message = (
      typeof data?.error?.message === "string" ? data.error.message : body
    ).toLowerCase();
    const quota =
      code === "insufficient_quota" ||
      (response.status === 429 &&
        /quota|billing|credits|balance/.test(message));
    const reason = quota
      ? "OpenAI API quota is exhausted. Check API billing, credits, and spending limits."
      : response.status === 429
        ? "OpenAI rate limit reached. Wait briefly and check the API project's usage limits."
        : response.status === 401
          ? "The realtime credential expired or was rejected. Start again."
          : response.status === 403 || code === "model_not_found"
            ? "OpenAI denied access to the selected realtime model. Check the API key and project permissions."
            : response.status === 400 &&
                (message.includes("sdp") || message.includes("offer"))
              ? "OpenAI rejected the WebRTC audio offer. The app could not negotiate the audio connection."
              : response.status >= 500
                ? "OpenAI's realtime service is temporarily unavailable. Try again shortly."
                : "OpenAI rejected the realtime connection configuration.";
    throw new VoiceError(`${reason} (HTTP ${response.status})`);
  }
  const answer = await response.text();
  if (!answer.startsWith("v=0"))
    throw new VoiceError("OpenAI returned an invalid WebRTC answer.");
  return answer;
}
