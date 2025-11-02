in vec2 a_pos;
in float a_radius;
in vec2 a_flags;

uniform vec2 u_viewport_size;

out float v_radius;
out vec2 v_extrude;
out float v_collision;
out float v_widthMultiplier;

void main() {
    float radius = a_radius;
    float collision = a_flags.x;
    float packedFlags = a_flags.y;
    float widthEncoded = floor(packedFlags / 4.0);
    float vertexIdx = mod(packedFlags, 4.0);
    float widthMultiplier = widthEncoded > 0.0 ? widthEncoded / 100.0 : 1.0;

    vec2 quadVertexOffset = vec2(
        mix(-1.0, 1.0, float(vertexIdx >= 2.0)),
        mix(-1.0, 1.0, float(vertexIdx >= 1.0 && vertexIdx <= 2.0)));

    vec2 quadVertexExtent = vec2(quadVertexOffset.x * radius * widthMultiplier, quadVertexOffset.y * radius);

    // Apply small padding for the anti-aliasing effect to fit the quad
    // Note that v_radius and v_extrude are in screen coordinates already
    float padding_factor = 1.2;
    v_radius = radius;
    v_extrude = quadVertexExtent * padding_factor;
    v_collision = collision;
    v_widthMultiplier = widthMultiplier;

    gl_Position = vec4((a_pos / u_viewport_size * 2.0 - 1.0) * vec2(1.0, -1.0), 0.0, 1.0) + vec4(quadVertexExtent * padding_factor / u_viewport_size * 2.0, 0.0, 0.0);
}
