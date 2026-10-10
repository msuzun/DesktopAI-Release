using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Companion.Broker;

public sealed record ClientCredential(string ClientSecret, long ExpiresAt, string Model);
public sealed record BrokerFailure(string Code, string Message);
public sealed record BrokerResult(int Status, ClientCredential? Credential, BrokerFailure? Error);

public sealed class SessionBroker(HttpClient client, RealtimeSettings settings)
{
    public async Task<BrokerResult> CreateAsync(string? apiKey, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(apiKey) || apiKey == "your_key_here")
            return Failure(503, "api_key_missing", "Set OPENAI_API_KEY in the broker terminal, then restart the broker.");

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/realtime/client_secrets");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            request.Content = JsonContent.Create(settings.CreateRequest());
            using var response = await client.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                // Never forward upstream bodies: they can contain request configuration or secrets.
                return response.StatusCode switch
                {
                    HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => Failure(502, "openai_access_denied", "OpenAI rejected the broker credential or model access. Check the server-side key and project permissions."),
                    HttpStatusCode.TooManyRequests => Failure(429, "openai_rate_limit", "OpenAI quota or rate limit reached. Check API billing and try again later."),
                    _ => Failure(502, "credential_creation_failed", "OpenAI could not create a realtime credential. Check the configured model and voice.")
                };
            }

            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var root = document.RootElement;
            if (!root.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.String ||
                value.GetString() is not { } secret || !secret.StartsWith("ek_", StringComparison.Ordinal) ||
                !root.TryGetProperty("expires_at", out var expiry) || !expiry.TryGetInt64(out var expiresAt) ||
                expiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() ||
                !root.TryGetProperty("session", out var session) ||
                !session.TryGetProperty("model", out var model) || model.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(model.GetString()))
                return Failure(502, "invalid_credential", "OpenAI returned an invalid realtime credential.");

            return new(200, new(secret, expiresAt, model.GetString()!), null);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Failure(504, "openai_timeout", "OpenAI did not respond in time. Try again.");
        }
        catch (HttpRequestException)
        {
            return Failure(502, "openai_unavailable", "The broker could not reach OpenAI. Check its internet connection.");
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException)
        {
            return Failure(502, "invalid_credential", "The realtime credential response was invalid.");
        }
    }

    private static BrokerResult Failure(int status, string code, string message) => new(status, null, new(code, message));
}
