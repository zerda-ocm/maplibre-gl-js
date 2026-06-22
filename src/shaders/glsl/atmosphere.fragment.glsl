#ifdef GL_ES
precision highp float;
#endif

in vec3 view_direction;

uniform vec3 u_sun_pos;
uniform vec3 u_globe_position;
uniform float u_globe_radius;
uniform float u_atmosphere_blend;

/*
 * Optimized Atmosphere shader for MapLibre Globe geometry
 */

const float PI = 3.141592653589793;
const int iSteps = 4; // Tweak this (e.g., 3 to 5) to balance performance and quality

/* radius of the planet */
const float EARTH_RADIUS = 6371e3;
/* radius of the atmosphere */
const float ATMOS_RADIUS = 6471e3;

// Simplified ray-sphere intersection assuming rd is normalized
vec2 rsi(vec3 r0, vec3 rd, float sr) {
    float b = dot(rd, r0);
    float c = dot(r0, r0) - (sr * sr);
    float d = b * b - c;
    if (d < 0.0) return vec2(1e5, -1e5);
    float sig = sqrt(d);
    return vec2(-b - sig, -b + sig);
}

vec4 atmosphere(
    vec3 r, vec3 r0, vec3 pSun, float iSun,
    float rPlanet, float rAtmos,
    vec3 kRlh, float kMie,
    float shRlh, float shMie, float g,
    vec2 p, vec2 p2, bool hitsPlanet
) {
    if (p.x > p.y) {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }

    if (p.x < 0.0) {
        p.x = 0.0;
    }

    if (hitsPlanet) {
        p.y = min(p.y, p2.x);
    }

    float iStepSize = (p.y - p.x) / float(iSteps);
    float iTime = p.x + iStepSize * 0.5;

    vec3 totalRlh = vec3(0.0);
    vec3 totalMie = vec3(0.0);

    float iOdRlh = 0.0;
    float iOdMie = 0.0;

    vec3 sunDir = normalize(pSun);
    float mu = dot(r, sunDir);
    float mumu = mu * mu;
    float gg = g * g;
    float pRlh = 3.0 / (16.0 * PI) * (1.0 + mumu);
    float pMie = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * g, 1.5) * (2.0 + gg));

    for (int i = 0; i < iSteps; i++) {
        vec3 iPos = r0 + r * iTime;
        float len = length(iPos);
        float iHeight = len - rPlanet;

        // Calculate and reuse exponential density factors
        float expRlh = exp(-iHeight / shRlh);
        float expMie = exp(-iHeight / shMie);

        float odStepRlh = expRlh * iStepSize;
        float odStepMie = expMie * iStepSize;

        iOdRlh += odStepRlh;
        iOdMie += odStepMie;

        // Fast analytical approximation of the secondary ray optical depth towards the sun
        vec3 up = iPos / len;
        float cosZenith = dot(up, sunDir);
        float sunPathFactor = 1.0 / (max(cosZenith, 0.0) + 0.15);

        float jOdRlh = expRlh * shRlh * sunPathFactor;
        float jOdMie = expMie * shMie * sunPathFactor;

        // Combine transmittance
        vec3 attn = exp(-(kMie * (iOdMie + jOdMie) + kRlh * (iOdRlh + jOdRlh)));

        totalRlh += odStepRlh * attn;
        totalMie += odStepMie * attn;

        iTime += iStepSize;
    }

    float opacity = exp(-(length(kRlh) * length(totalRlh) + kMie * length(totalMie)));
    opacity = min(0.5, opacity * 2.0);

    vec3 color = iSun * (pRlh * kRlh * totalRlh + pMie * kMie * totalMie) * 0.6;

    return vec4(color, opacity);
}

void main() {
    vec3 r = normalize(view_direction);
    vec3 scale_camera_pos = -u_globe_position * EARTH_RADIUS / u_globe_radius;

    // Precompute intersections once for the atmosphere and the glow
    vec2 pAtmos = rsi(scale_camera_pos, r, ATMOS_RADIUS);
    vec2 pPlanet = rsi(scale_camera_pos, r, EARTH_RADIUS);
    bool hitsPlanet = (pPlanet.x <= pPlanet.y && pPlanet.x > 0.0);

    float tClosest = -dot(scale_camera_pos, r);
    vec3 closestPos = scale_camera_pos + r * tClosest;
    float d = length(closestPos);

    // 1. Center 85% Transparency Mask
    // If the ray hits the planet, smoothly fade out the atmosphere starting at 85% of the radius down to 0% at the center.
    float planetMask = 1.0;
    if (hitsPlanet) {
        planetMask = smoothstep(0.85 * EARTH_RADIUS, 1.0 * EARTH_RADIUS, d);
    }

    // 2. Camera Basis Projection for Directional Haze
    // Constructs camera-relative axes to determine direction in screen/globe space
    vec3 cam_forward = normalize(-scale_camera_pos);
    vec3 world_up = vec3(0.0, 0.0, 1.0); // MapLibre's world up is typically Z
    if (abs(dot(cam_forward, world_up)) > 0.99) {
        world_up = vec3(0.0, 1.0, 0.0);
    }
    vec3 cam_right = normalize(cross(cam_forward, world_up));
    vec3 cam_up = cross(cam_right, cam_forward);

    // Map 2D coordinate on the globe disk in the range [-1.0, 1.0] regardless of distance or zoom
    float cam_dist = length(scale_camera_pos);
    vec2 norm_disk_pos = vec2(dot(r, cam_right), dot(r, cam_up)) * (cam_dist / EARTH_RADIUS);

    // Calculate direction alignment: Peaks exactly in the lower-right (1.0, -1.0) and falls off smoothly
    float len = max(length(norm_disk_pos), 1e-5);
    float lr_align = dot(norm_disk_pos / len, vec2(0.70710678, -0.70710678));
    float lr_factor = pow(max(lr_align, 0.0), 2.0); // Restricts haze smoothly to the lower-right quadrant

    // 3. Curved Atmosphere Profile for Haze
    // Uses a Gaussian curve to follow the exact curvature of the globe's edge.
    // Tweak 'scale' (e.g., 0.02 to 0.03) to make the ring profile wider or thinner.
    float scale = 0.025 * EARTH_RADIUS;
    float diff = (d - EARTH_RADIUS) / scale;
    float rim_profile = exp(-diff * diff);

    // Combine curve profile, directional alignment, and subtle peak opacity factor (0.08)
    float lr_haze = rim_profile * lr_factor * 0.08;

    vec4 color = atmosphere(
        r,                              // ray direction
        scale_camera_pos,               // ray origin
        u_sun_pos,                      // position of the sun
        22.0,                           // intensity of the sun
        EARTH_RADIUS,                   // radius of the planet in meters
        ATMOS_RADIUS,                   // radius of the atmosphere in meters
        vec3(6.0e-6),                   // Rayleigh scattering coefficient
        10e-6,                          // Mie scattering coefficient
        8e3,                            // Rayleigh scale height
        1.1e3,                          // Mie scale height
        0.758,                          // Mie preferred scattering direction
        pAtmos,
        pPlanet,
        hitsPlanet
    );

    // Consolidated background halo/glow logic (outside the planet)
    if (!hitsPlanet) {
        float glowRadius = EARTH_RADIUS * 1.05;
        if (tClosest > 0.0 && d < glowRadius) {
            float edge = glowRadius - EARTH_RADIUS;
            float x = clamp((glowRadius - d) / edge, 0.0, 1.0);

            // Base glow shape and sun attenuation
            float baseGlow = pow(x, 1.5);
            vec3 sunDir = normalize(u_sun_pos);
            vec3 nClosest = closestPos / d;
            float sunDot = dot(nClosest, sunDir);
            float sunAttenuation = clamp(sunDot * 0.8 + 0.2, 0.0, 1.0);
            float glow = baseGlow * sunAttenuation;

            // Color tinting: blend green at the outer edge, blue elsewhere
            vec3 blueTint = vec3(0.6, 0.75, 1.0);
            vec3 greenTint = vec3(0.15, 1.0, 0.35);
            float outerBand = 0.7;
            float outerMix = 1.0 - smoothstep(0.0, outerBand, x);
            vec3 tint = mix(blueTint, greenTint, outerMix);

            float baseIntensity = 0.4;
            float outerBoost = 1.2;
            float intensity = baseIntensity + outerMix * outerBoost;

            color.rgb += tint * glow * intensity;
            color.rgb = clamp(color.rgb, 0.0, 1.0);
        }
    }

    // Blend the subtle lower-right curved haze into the linear color
    // Tweak the RGB vector here to change the color of the lower-right haze accent
    vec3 hazeColor = vec3(0.55, 0.72, 1.0) * lr_haze;
    color.rgb += hazeColor;
    color.rgb = clamp(color.rgb, 0.0, 1.0);
    color.a = clamp(color.a - lr_haze, 0.0, 1.0); // Modulate opacity with the haze factor

    // Apply exposure and gamma correction
    color.rgb = 1.0 - exp(-1.0 * color.rgb);
    color = pow(color, vec4(1.0 / 2.2));

    // Combine atmosphere blend and apply the 85% transparency mask
    float finalAlpha = (1.0 - color.a) * u_atmosphere_blend * planetMask;
    vec3 finalRGB = color.rgb * planetMask; // Multiply color to keep output safe for premultiplied alpha

    fragColor = vec4(finalRGB, finalAlpha);
}
