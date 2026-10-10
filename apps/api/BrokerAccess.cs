namespace Companion.Broker;

public static class BrokerAccess
{
    public const int Port = 4317;
    public static readonly string[] Origins = ["http://127.0.0.1:1420", "http://localhost:1420", "http://tauri.localhost"];

    public static bool Allows(string host, string origin, string marker, long? bodyLength, bool hasTransferEncoding) =>
        host == $"127.0.0.1:{Port}" &&
        (origin.Length == 0 || Origins.Contains(origin, StringComparer.Ordinal)) &&
        marker == "voice-m3" && (bodyLength is null or 0) && !hasTransferEncoding;
}
