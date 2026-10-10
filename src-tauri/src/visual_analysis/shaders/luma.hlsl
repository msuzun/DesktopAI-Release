cbuffer AnalysisConstants : register(b0) {
    uint2 sourceSize;
    uint2 analysisSize;
    uint2 tileGrid;
    float noiseThreshold;
    uint baseline;
};
Texture2D<float4> sourceImage : register(t0);
SamplerState linearClamp : register(s0);
RWTexture2D<float> luma : register(u0);

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    if (any(id.xy >= analysisSize)) return;
    // Fixed 4x4 stratified bilinear footprint: bounded work even on 4K/ultrawide.
    // A BGRA_UNORM SRV exposes logical RGBA components; do not swap R and B here.
    // These are SDR gamma-encoded luma coefficients, not HDR/linear-light luminance.
    float value = 0;
    [unroll] for (uint y = 0; y < 4; ++y) {
        [unroll] for (uint x = 0; x < 4; ++x) {
            float2 uv = (float2(id.xy) + (float2(x, y) + 0.5) / 4.0) / float2(analysisSize);
            value += dot(sourceImage.SampleLevel(linearClamp, uv, 0).rgb, float3(0.2126, 0.7152, 0.0722));
        }
    }
    luma[id.xy] = value / 16.0;
}
