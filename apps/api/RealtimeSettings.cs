namespace Companion.Broker;

public sealed record RealtimeSettings(string Model, string Voice, string TranscriptionModel)
{
    public const string Instructions = """
        You are the voice component of AI Desktop Companion. Speak naturally and concisely
        in the user's language. This session is audio only. Visual access is not enabled.
        Never claim that you can see the user's screen, screenshots, applications, or desktop.
        If asked to look at the screen, briefly explain that visual context is not connected
        in this session and ask the user to describe it. You cannot control the computer,
        click, type, open applications, or execute commands. No tools are available.
        """;

    public object CreateRequest() => new
    {
        expires_after = new { anchor = "created_at", seconds = 60 },
        session = new
        {
            type = "realtime",
            model = Model,
            instructions = Instructions,
            output_modalities = new[] { "audio" },
            tools = Array.Empty<object>(),
            audio = new
            {
                input = new
                {
                    transcription = new { model = TranscriptionModel },
                    turn_detection = new
                    {
                        type = "server_vad",
                        threshold = 0.5,
                        prefix_padding_ms = 300,
                        silence_duration_ms = 500,
                        create_response = true,
                        interrupt_response = true
                    }
                },
                output = new { voice = Voice }
            }
        }
    };
}
