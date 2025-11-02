in float v_radius;
in vec2 v_extrude;
in float v_collision;
in float v_widthMultiplier;

void main() {
    float alpha = 0.5;
    float stroke_radius = 0.9;

    float widthMultiplier = v_widthMultiplier > 0.0 ? v_widthMultiplier : 1.0;
    vec2 normalizedExtrude = vec2(v_extrude.x / widthMultiplier, v_extrude.y);
    float distance_to_center = length(normalizedExtrude);
    float distance_to_edge = abs(distance_to_center - v_radius);
    float opacity_t = smoothstep(-stroke_radius, 0.0, -distance_to_edge);

    vec4 color;
    if (v_collision > 1.5) {
        color = vec4(0.0, 0.0, 0.0, 0.8);
    } else if (v_collision > 0.5) {
        color = vec4(1.0, 0.0, 0.0, 0.2);
    } else {
        color = vec4(0.0, 0.0, 1.0, 0.2);
    }

    fragColor = color * alpha * opacity_t;
}
