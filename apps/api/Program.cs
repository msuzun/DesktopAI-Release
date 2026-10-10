using System.Net;
using System.Threading.RateLimiting;
using Companion.Broker;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);
if (!builder.Environment.IsDevelopment())
    throw new InvalidOperationException("This unauthenticated broker is development-only. Use the Development launch profile locally.");

// A fixed loopback listener avoids accidentally exposing a credential broker on a LAN.
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, BrokerAccess.Port));
var realtime = builder.Configuration.GetRequiredSection("Realtime");
var settings = new RealtimeSettings(
    realtime["Model"] ?? throw new InvalidOperationException("Realtime:Model is required."),
    realtime["Voice"] ?? throw new InvalidOperationException("Realtime:Voice is required."),
    realtime["TranscriptionModel"] ?? throw new InvalidOperationException("Realtime:TranscriptionModel is required."));
builder.Services.AddSingleton(settings);
builder.Services.AddHttpClient<SessionBroker>(client => client.Timeout = TimeSpan.FromSeconds(20))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(BrokerAccess.Origins).WithMethods("POST").WithHeaders("X-Desktop-Companion")));
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.AddFixedWindowLimiter("sessions", limiter =>
    {
        limiter.PermitLimit = 10;
        limiter.Window = TimeSpan.FromMinutes(1);
        limiter.QueueLimit = 0;
        limiter.AutoReplenishment = true;
    });
});
var app = builder.Build();
app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers.Pragma = "no-cache";
    await next();
});
app.UseCors();
app.UseRateLimiter();
app.MapPost("/api/realtime/session", async (HttpContext context, SessionBroker broker) =>
{
    var request = context.Request;
    if (!BrokerAccess.Allows(request.Host.Value ?? "", request.Headers.Origin.ToString(),
        request.Headers["X-Desktop-Companion"].ToString(), request.ContentLength, request.Headers.ContainsKey("Transfer-Encoding")))
        return Results.Json(new BrokerFailure("request_rejected", "Only the local desktop client may request a voice credential."), statusCode: 403);

    var result = await broker.CreateAsync(Environment.GetEnvironmentVariable("OPENAI_API_KEY"), context.RequestAborted);
    return result.Credential is { } credential
        ? Results.Json(credential, statusCode: result.Status)
        : Results.Json(result.Error, statusCode: result.Status);
}).RequireRateLimiting("sessions");
app.Run();
