cbuffer AnalysisConstants : register(b0) {
    uint2 sourceSize;
    uint2 analysisSize;
    uint2 tileGrid;
    float noiseThreshold;
    uint baseline;
};
Texture2D<float> currentLuma : register(t0);
Texture2D<float> previousLuma : register(t1);
struct Tile { float differenceSum; uint changedPixels; uint pixelCount; uint padding; };
RWStructuredBuffer<Tile> tileMetrics : register(u0);
groupshared float sums[64];
groupshared uint changed[64];
groupshared uint counts[64];

// One workgroup owns one tile. Integer partitions cover all edge pixels exactly
// once; reductions are synchronized and normalized later by actual pixel count.
[numthreads(8, 8, 1)]
void main(uint3 group : SV_GroupID, uint lane : SV_GroupIndex) {
    uint2 start = group.xy * analysisSize / tileGrid;
    uint2 end = (group.xy + 1) * analysisSize / tileGrid;
    uint2 size = end - start;
    float sum = 0;
    uint changedCount = 0;
    uint count = 0;
    for (uint i = lane; i < size.x * size.y; i += 64) {
        uint2 p = start + uint2(i % size.x, i / size.x);
        float d = 0;
        // First frame never reads the uninitialized previous luma texture.
        if (baseline == 0) d = abs(currentLuma.Load(int3(p, 0)) - previousLuma.Load(int3(p, 0)));
        if (d > noiseThreshold) { sum += d; changedCount++; }
        count++;
    }
    sums[lane] = sum;
    changed[lane] = changedCount;
    counts[lane] = count;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) {
            sums[lane] += sums[lane + stride];
            changed[lane] += changed[lane + stride];
            counts[lane] += counts[lane + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        Tile t;
        t.differenceSum = sums[0];
        t.changedPixels = changed[0];
        t.pixelCount = counts[0];
        t.padding = 0;
        tileMetrics[group.y * tileGrid.x + group.x] = t;
    }
}
