import { MeshGenerator } from "./meshGenerator.js";
import { GUI } from "lil-gui";

//
// webgl setup and canvas
//
const canvas = document.getElementById("canvas");
const gl =
  canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false }) ||
  canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });

if (!gl) {
  const container = document.getElementById("container");
  const errorDiv = document.createElement("div");
  errorDiv.textContent = "WebGL not supported";
  errorDiv.className = "webgl-error";
  container.parentNode.replaceChild(errorDiv, container);
  throw new Error("WebGL not supported");
}

//
// parameters
//

//
// step 2: noise field generator
//

// noise function constants (used in GLSL shader)
// randomize seed on startup for variation
const NOISE_CONSTANTS = {
  // magic numbers for noise function - randomized on startup
  NOISE_X: 12.9898 + Math.random() * 100.0,
  NOISE_Y: 78.233 + Math.random() * 100.0,
  NOISE_MULTIPLIER: 43758.5453,
};

//
// step 3: shaders
//

// shared noise functions for shaders
const noiseFunctionsGLSL = `
    // simple 2D noise function
    float noise(vec2 p) {
        float n = sin(dot(p, vec2(${NOISE_CONSTANTS.NOISE_X}, ${NOISE_CONSTANTS.NOISE_Y}))) * ${NOISE_CONSTANTS.NOISE_MULTIPLIER};
        return fract(n);
    }

    float smoothNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);

        float a = noise(i);
        float b = noise(i + vec2(1.0, 0.0));
        float c = noise(i + vec2(0.0, 1.0));
        float d = noise(i + vec2(1.0, 1.0));

        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
`;

const vertexShaderSource = `#version 300 es
    in vec2 a_position;
    in vec2 a_uv;
    in float a_triangleOffset;
    out vec2 v_uv;
    out float v_triangleOffset;

    void main() {
        v_uv = a_uv;
        v_triangleOffset = a_triangleOffset;
        
        // noise-based distortion is applied pre-tesselation in meshGenerator
        // vertex shader just passes through the position
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

// sawtooth gradient shader - black to white gradient looping over V direction
// uses noise texture as mask for thresholding
const sawtoothFragmentShaderSource = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    in float v_triangleOffset;
    out vec4 fragColor;
    uniform float u_time;
    uniform sampler2D u_noiseTexture;
    uniform float u_threshold;
    uniform vec2 u_resolution;
    uniform float u_sawtoothCycleSpeed;

    ${noiseFunctionsGLSL}

    void main() {
        // sample noise texture at fragment position for masking
        // convert UV to screen coordinates, then to texture coordinates
        vec2 screenPos = gl_FragCoord.xy;
        vec2 noiseUV = screenPos / u_resolution;
        float noiseValue = texture(u_noiseTexture, noiseUV).r;
        
        // fade edges using smoothstep for soft transition
        // fadeWidth: 0.08
        float fadeWidth = 0.08;
        float fadeStart = u_threshold - fadeWidth * 0.5;
        float fadeEnd = u_threshold + fadeWidth * 0.5;
        float alpha = smoothstep(fadeStart, fadeEnd, noiseValue);
        
        // create sawtooth pattern: fract() creates repeating pattern from 0 to 1
        // sawtoothFrequency: 2.0
        float value = v_uv.y * 2.0 + u_time * u_sawtoothCycleSpeed + v_triangleOffset * 12. * 2.0;
        float sawtooth = fract(value);
        
        // color gradient uses same animation speed
        float colorSawtooth = fract(v_uv.y * 5.0 + u_time * u_sawtoothCycleSpeed + v_triangleOffset * 5.0);
        
        // grayscale gradient (black to white) - smooth sawtooth
        vec3 grayscale = vec3(sawtooth);
        
        // step function that cycles between R, G, B
        vec3 rgbStep;
        
        if (colorSawtooth < .333) { // one third
            rgbStep = vec3(1.0, 0.0, 0.0); // red
        } else if (colorSawtooth < .666) { // two thirds
            rgbStep = vec3(0.0, .8, 0.0); // green
        } else {
            rgbStep = vec3(0.2, 0.2, 1.0); // blue
        }
        
        // fade rgb in and out over the top of grayscale using linear interpolation
        // sawtoothFadeSpeed: 0.1
        // map sin output from [-1,1] to [0.2,1]
        float fadeAmount = 0.2 + (sin(u_time * 0.1) + 1.0) * 0.4;        
        vec3 finalColor = rgbStep * fadeAmount + grayscale * (1.0 - fadeAmount);
        
        // output with alpha fade
        fragColor = vec4(finalColor, alpha);
    }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  return program;
}

//
// step 4: webgl setup and rendering
//
const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
const sawtoothFragmentShader = createShader(
  gl,
  gl.FRAGMENT_SHADER,
  sawtoothFragmentShaderSource
);
const sawtoothProgram = createProgram(gl, vertexShader, sawtoothFragmentShader);

// noise shaders for noise field visualization
const noiseVertexShaderSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;

    void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

const noiseFragmentShaderSource = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform float u_time;
    uniform vec2 u_resolution;
    uniform float u_noiseSpeed;
    uniform float u_noiseOffset;
    uniform float u_noiseValue;
    uniform float u_noiseMin;
    uniform float u_noiseMax;
    uniform float u_ringMax;
    uniform float u_ringRadius;
    uniform float u_ringFalloff;
    uniform float u_ringDistortionStrength;
    uniform float u_ringDistortionSpeed;
    uniform float u_ringNoiseMix;

    ${noiseFunctionsGLSL}

    void main() {
        vec2 center = u_resolution * 0.5;
        vec2 pos = v_uv * u_resolution;
        vec2 npos = (pos - center) / u_resolution;
        
        float dist = length(npos);
        float angle = atan(npos.y, npos.x);
        // ringRadiusScale: 2.5
        float radius = dist * 2.5;
        
        vec2 noisePos = vec2(
            radius * cos(angle) + u_time * u_noiseSpeed,
            radius * sin(angle) + u_time * u_noiseSpeed
        );
        
        // noise octave settings
        float noiseOctave1Scale = 1.7;
        float noiseOctave1Weight = .7;
        float noiseOctave2Scale = 6.0;
        float noiseOctave2Weight = 0.3;
        float noiseOctave3Scale = 0.5;
        float noiseOctave3Weight = 0.5;
        
        float value = smoothNoise(noisePos * noiseOctave1Scale) * noiseOctave1Weight;
        value += smoothNoise(noisePos * noiseOctave2Scale) * noiseOctave2Weight;
        // value += smoothNoise(noisePos * noiseOctave3Scale) * noiseOctave3Weight;
        
        // base noise value
        // noiseBaseScale: 0.7
        // noiseBaseOffset: 0.3
        // noiseGamma: 1.03
        value = value * 0.7 + 0.3;
        value = pow(value, 1.03);
        
        // subtract constant from noise before compositing with ring
        value = value - u_noiseOffset;
        
        // normalize and map to min / max
        // thanks, past me https://stackoverflow.com/a/17029736/738675
        float normalized = (tanh(value) + 1.0) * 0.5; // maps to [0, 1]
        value = normalized * (u_noiseMax - u_noiseMin) + u_noiseMin; // maps to [u_noiseMin, u_noiseMax]
        value = clamp(value, u_noiseMin, u_noiseMax);
        
        // ring parameters - simple fuzzy ring with configurable radius and falloff
        // apply noise distortion to position before calculating ring distance
        vec2 ringDistortionUV = npos * 8.0 + u_time * u_ringDistortionSpeed;
        vec2 ringDistortion;
        ringDistortion.x = smoothNoise(ringDistortionUV) - 0.5;
        ringDistortion.y = smoothNoise(ringDistortionUV + vec2(100.0, 0.0)) - 0.5;
        vec2 distortedNpos = npos + ringDistortion * u_ringDistortionStrength;
        float distortedDist = length(distortedNpos);
        
        // calculate distance from the ring radius
        float distFromRing = abs(distortedDist - u_ringRadius);
        
        // create fuzzy ring using smoothstep for smooth falloff
        float ringValue = 1.0 - smoothstep(0.0, u_ringFalloff, distFromRing);
        
        // scale ring peak by ringMax
        float normalizedRing = ringValue * u_ringMax;
        
        // mix between noise and ring
        value = mix(value, normalizedRing, u_ringNoiseMix);
        
        // store noise value as final fragColor
        fragColor = vec4(value, value, value, 1.0);
    }
`;

const noiseVertexShader = createShader(
  gl,
  gl.VERTEX_SHADER,
  noiseVertexShaderSource
);
const noiseFragmentShader = createShader(
  gl,
  gl.FRAGMENT_SHADER,
  noiseFragmentShaderSource
);
const noiseProgram = createProgram(gl, noiseVertexShader, noiseFragmentShader);

// debug shader for visualizing the noise texture mask
const debugVertexShaderSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;

    void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

const debugFragmentShaderSource = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_noiseTexture;
    uniform float u_threshold;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_noiseSpeed;
    uniform float u_noiseOffset;
    uniform float u_noiseValue;
    uniform float u_noiseMin;
    uniform float u_noiseMax;
    uniform float u_ringMax;
    uniform float u_ringRadius;
    uniform float u_ringFalloff;
    uniform float u_ringDistortionStrength;
    uniform float u_ringDistortionSpeed;
    uniform float u_ringNoiseMix;
    uniform bool u_showNoise;
    uniform bool u_showRing;

    ${noiseFunctionsGLSL}

    void main() {
        vec2 center = u_resolution * 0.5;
        vec2 pos = v_uv * u_resolution;
        vec2 npos = (pos - center) / u_resolution;
        
        float dist = length(npos);
        float angle = atan(npos.y, npos.x);
        float radius = dist * 2.5;
        
        vec2 noisePos = vec2(
            radius * cos(angle) + u_time * u_noiseSpeed,
            radius * sin(angle) + u_time * u_noiseSpeed
        );
        
        // compute noise contribution
        float noiseOctave1Scale = 1.7;
        float noiseOctave1Weight = 1.;
        float noiseOctave2Scale = 6.0;
        float noiseOctave2Weight = 0.3;
        float noiseOctave3Scale = 0.5;
        float noiseOctave3Weight = 0.5;
        
        float noiseContribution = smoothNoise(noisePos * noiseOctave1Scale) * noiseOctave1Weight;
        // noiseContribution += smoothNoise(noisePos * noiseOctave2Scale) * noiseOctave2Weight;
        // noiseContribution += smoothNoise(noisePos * noiseOctave3Scale) * noiseOctave3Weight;
        
        noiseContribution = noiseContribution * 0.7 + 0.3;
        noiseContribution = pow(noiseContribution, 1.03);
        noiseContribution = noiseContribution - u_noiseOffset;
        
        // normalize noise
        float normalizedNoise = (tanh(noiseContribution) + 1.0) * 0.5;
        noiseContribution = normalizedNoise * (u_noiseMax - u_noiseMin) + u_noiseMin;
        noiseContribution = clamp(noiseContribution, u_noiseMin, u_noiseMax);
        
        // compute ring contribution - simple fuzzy ring with configurable radius and falloff
        // apply noise distortion to position before calculating ring distance
        vec2 ringDistortionUV = npos * 8.0 + u_time * u_ringDistortionSpeed;
        vec2 ringDistortion;
        ringDistortion.x = smoothNoise(ringDistortionUV) - 0.5;
        ringDistortion.y = smoothNoise(ringDistortionUV + vec2(100.0, 0.0)) - 0.5;
        vec2 distortedNpos = npos + ringDistortion * u_ringDistortionStrength;
        float distortedDist = length(distortedNpos);
        
        // calculate distance from the ring radius
        float distFromRing = abs(distortedDist - u_ringRadius);
        
        // create fuzzy ring using smoothstep for smooth falloff
        float ringValue = 1.0 - smoothstep(0.0, u_ringFalloff, distFromRing);
        
        // scale the ring peak by ringMax
        float ringContribution = ringValue * u_ringMax;
        
        // compute final combined value using mix
        float finalValue = mix(noiseContribution, ringContribution, u_ringNoiseMix);
        
        // determine what to display
        float displayValue;
        if (u_showNoise && u_showRing) {
            // show final combined texture
            displayValue = finalValue;
        } else if (u_showNoise) {
            // show noise only
            displayValue = noiseContribution;
        } else if (u_showRing) {
            // show ring only
            displayValue = ringContribution;
        } else {
            // fallback: show final (shouldn't happen if debug mode is on)
            displayValue = finalValue;
        }
        
        // sample the actual texture for threshold visualization
        vec2 screenPos = gl_FragCoord.xy;
        vec2 noiseUV = screenPos / u_resolution;
        vec2 distortionUV = noiseUV * 8.0 + u_time * 0.03;
        vec2 distortion;
        distortion.x = smoothNoise(distortionUV) - 0.5;
        distortion.y = smoothNoise(distortionUV + vec2(100.0, 0.0)) - 0.5;
        noiseUV += distortion * 0.081;
        float textureValue = texture(u_noiseTexture, noiseUV).r;
        
        // display as grayscale
        vec3 color = vec3(displayValue);
        
        // apply red tint to values above threshold (based on final texture value)
        if (textureValue > u_threshold) {
            color = mix(color, vec3(1.0, 0.0, 0.0), 0.5);
        }
        
        fragColor = vec4(color, 1.0);
    }
`;

const debugVertexShader = createShader(
  gl,
  gl.VERTEX_SHADER,
  debugVertexShaderSource
);
const debugFragmentShader = createShader(
  gl,
  gl.FRAGMENT_SHADER,
  debugFragmentShaderSource
);
const debugProgram = createProgram(gl, debugVertexShader, debugFragmentShader);

// get attribute and uniform locations
const positionLocation = gl.getAttribLocation(sawtoothProgram, "a_position");
const uvLocation = gl.getAttribLocation(sawtoothProgram, "a_uv");
const triangleOffsetLocation = gl.getAttribLocation(
  sawtoothProgram,
  "a_triangleOffset"
);
const sawtoothTimeLocation = gl.getUniformLocation(sawtoothProgram, "u_time");
const sawtoothNoiseTextureLocation = gl.getUniformLocation(
  sawtoothProgram,
  "u_noiseTexture"
);
const sawtoothThresholdLocation = gl.getUniformLocation(
  sawtoothProgram,
  "u_threshold"
);
const sawtoothResolutionLocation = gl.getUniformLocation(
  sawtoothProgram,
  "u_resolution"
);
const sawtoothCycleSpeedLocation = gl.getUniformLocation(
  sawtoothProgram,
  "u_sawtoothCycleSpeed"
);
// vertex shader uniforms

// noise program locations
const noisePositionLocation = gl.getAttribLocation(noiseProgram, "a_position");
const noiseTimeLocation = gl.getUniformLocation(noiseProgram, "u_time");
const noiseResolutionLocation = gl.getUniformLocation(
  noiseProgram,
  "u_resolution"
);
const noiseSpeedLocation = gl.getUniformLocation(noiseProgram, "u_noiseSpeed");
const noiseOffsetLocation = gl.getUniformLocation(
  noiseProgram,
  "u_noiseOffset"
);
const noiseValueLocation = gl.getUniformLocation(noiseProgram, "u_noiseValue");
const noiseMinLocation = gl.getUniformLocation(noiseProgram, "u_noiseMin");
const noiseMaxLocation = gl.getUniformLocation(noiseProgram, "u_noiseMax");
const ringMaxLocation = gl.getUniformLocation(noiseProgram, "u_ringMax");
const ringRadiusLocation = gl.getUniformLocation(noiseProgram, "u_ringRadius");
const ringFalloffLocation = gl.getUniformLocation(
  noiseProgram,
  "u_ringFalloff"
);
const ringDistortionStrengthLocation = gl.getUniformLocation(
  noiseProgram,
  "u_ringDistortionStrength"
);
const ringDistortionSpeedLocation = gl.getUniformLocation(
  noiseProgram,
  "u_ringDistortionSpeed"
);
const ringNoiseMixLocation = gl.getUniformLocation(
  noiseProgram,
  "u_ringNoiseMix"
);

// debug program locations
const debugPositionLocation = gl.getAttribLocation(debugProgram, "a_position");
const debugTimeLocation = gl.getUniformLocation(debugProgram, "u_time");
const debugNoiseTextureLocation = gl.getUniformLocation(
  debugProgram,
  "u_noiseTexture"
);
const debugThresholdLocation = gl.getUniformLocation(
  debugProgram,
  "u_threshold"
);
const debugResolutionLocation = gl.getUniformLocation(
  debugProgram,
  "u_resolution"
);
const debugNoiseSpeedLocation = gl.getUniformLocation(
  debugProgram,
  "u_noiseSpeed"
);
const debugNoiseOffsetLocation = gl.getUniformLocation(
  debugProgram,
  "u_noiseOffset"
);
const debugNoiseValueLocation = gl.getUniformLocation(
  debugProgram,
  "u_noiseValue"
);
const debugNoiseMinLocation = gl.getUniformLocation(debugProgram, "u_noiseMin");
const debugNoiseMaxLocation = gl.getUniformLocation(debugProgram, "u_noiseMax");
const debugRingMaxLocation = gl.getUniformLocation(debugProgram, "u_ringMax");
const debugRingRadiusLocation = gl.getUniformLocation(
  debugProgram,
  "u_ringRadius"
);
const debugRingFalloffLocation = gl.getUniformLocation(
  debugProgram,
  "u_ringFalloff"
);
const debugRingDistortionStrengthLocation = gl.getUniformLocation(
  debugProgram,
  "u_ringDistortionStrength"
);
const debugRingDistortionSpeedLocation = gl.getUniformLocation(
  debugProgram,
  "u_ringDistortionSpeed"
);
const debugRingNoiseMixLocation = gl.getUniformLocation(
  debugProgram,
  "u_ringNoiseMix"
);
const debugShowNoiseLocation = gl.getUniformLocation(
  debugProgram,
  "u_showNoise"
);
const debugShowRingLocation = gl.getUniformLocation(debugProgram, "u_showRing");

// full-screen quad for debug visualization
const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const quadIndices = new Uint16Array([0, 1, 2, 1, 3, 2]);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
const quadIndexBuffer = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

// create buffers
let positionBuffer = gl.createBuffer();
let uvBuffer = gl.createBuffer();
let offsetBuffer = gl.createBuffer();
let indexBuffer = gl.createBuffer();

// initialize mesh generator, imported from meshGenerator.js
const meshGenerator = new MeshGenerator(
  canvas.width,
  canvas.height,
  0.02, // voronoiNoiseScale
  30.0, // voronoiNoiseStrength
  0.03 // voronoiAnimationSpeed
);

// parameters
const params = {
  threshold: 0.262,
  noiseOffset: 0,
  noiseValue: 0.82,
  noiseMin: -0.953,
  noiseMax: 0.452,
  ringMax: 0.515,
  ringRadius: 0.238,
  ringFalloff: 0.045,
  ringDistortionStrength: 0.0655,
  ringDistortionSpeed: 0.1,
  noiseSpeed: 0.1,
  sawtoothCycleSpeed: 4,
  ringNoiseMix: 0.299,
  debugMode: false,
  debugNoise: false,
  debugRing: false,
};

// create offscreen framebuffer and texture for noise field
const noiseTexture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
gl.texImage2D(
  gl.TEXTURE_2D,
  0,
  gl.RGBA,
  canvas.width,
  canvas.height,
  0,
  gl.RGBA,
  gl.UNSIGNED_BYTE,
  null
);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const noiseFramebuffer = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, noiseFramebuffer);
gl.framebufferTexture2D(
  gl.FRAMEBUFFER,
  gl.COLOR_ATTACHMENT0,
  gl.TEXTURE_2D,
  noiseTexture,
  0
);

// check framebuffer status
if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
  console.error("framebuffer not complete");
}

gl.bindFramebuffer(gl.FRAMEBUFFER, null);

function updateMesh() {
  // generate mesh every frame
  const mesh = meshGenerator.generateMesh();

  // create typed arrays from mesh data
  const vertexArray = new Float32Array(mesh.vertices);
  const uvArray = new Float32Array(mesh.uvs);
  const offsetArray = new Float32Array(mesh.offsets);

  // max index ~=7500, a uint16 is fine
  const indexArray = new Uint16Array(mesh.indices);

  // upload position data
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertexArray, gl.DYNAMIC_DRAW);

  // upload UV data
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, uvArray, gl.DYNAMIC_DRAW);

  // upload offset data
  gl.bindBuffer(gl.ARRAY_BUFFER, offsetBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, offsetArray, gl.DYNAMIC_DRAW);

  // upload index data
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.DYNAMIC_DRAW);

  // return count and index type (hardcoded to UNSIGNED_SHORT)
  return {
    count: mesh.indices.length,
    type: gl.UNSIGNED_SHORT,
  };
}

let lastTime = 0;
function render(time) {
  // update mesh generator time for Voronoi distortion animation
  const deltaTime = lastTime > 0 ? (time - lastTime) / 1000.0 : 0.016;
  lastTime = time;
  meshGenerator.update(deltaTime);

  // render noise field to offscreen texture
  gl.bindFramebuffer(gl.FRAMEBUFFER, noiseFramebuffer);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(noiseProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(noisePositionLocation);
  gl.vertexAttribPointer(noisePositionLocation, 2, gl.FLOAT, false, 0, 0);

  // set time uniform (convert ms to seconds)
  gl.uniform1f(noiseTimeLocation, time / 1000.0);
  gl.uniform2f(noiseResolutionLocation, canvas.width, canvas.height);
  gl.uniform1f(noiseSpeedLocation, params.noiseSpeed);
  gl.uniform1f(noiseOffsetLocation, params.noiseOffset);
  gl.uniform1f(noiseValueLocation, params.noiseValue);
  gl.uniform1f(noiseMinLocation, params.noiseMin);
  gl.uniform1f(noiseMaxLocation, params.noiseMax);
  gl.uniform1f(ringMaxLocation, params.ringMax);
  gl.uniform1f(ringRadiusLocation, params.ringRadius);
  gl.uniform1f(ringFalloffLocation, params.ringFalloff);
  gl.uniform1f(ringDistortionStrengthLocation, params.ringDistortionStrength);
  gl.uniform1f(ringDistortionSpeedLocation, params.ringDistortionSpeed);
  gl.uniform1f(ringNoiseMixLocation, params.ringNoiseMix);

  // draw noise field to texture
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

  // switch back to main framebuffer
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // clear canvas with transparent background
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (params.debugMode && (params.debugNoise || params.debugRing)) {
    // debug mode: show noise and/or ring contributions with red tint for values above threshold
    gl.useProgram(debugProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(debugPositionLocation);
    gl.vertexAttribPointer(debugPositionLocation, 2, gl.FLOAT, false, 0, 0);

    // set time uniform (convert ms to seconds)
    gl.uniform1f(debugTimeLocation, time / 1000.0);

    // set noise texture and threshold uniforms
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
    gl.uniform1i(debugNoiseTextureLocation, 0);
    gl.uniform1f(debugThresholdLocation, params.threshold);
    gl.uniform2f(debugResolutionLocation, canvas.width, canvas.height);

    // set noise and ring parameters
    gl.uniform1f(debugNoiseSpeedLocation, params.noiseSpeed);
    gl.uniform1f(debugNoiseOffsetLocation, params.noiseOffset);
    gl.uniform1f(debugNoiseValueLocation, params.noiseValue);
    gl.uniform1f(debugNoiseMinLocation, params.noiseMin);
    gl.uniform1f(debugNoiseMaxLocation, params.noiseMax);
    gl.uniform1f(debugRingMaxLocation, params.ringMax);
    gl.uniform1f(debugRingRadiusLocation, params.ringRadius);
    gl.uniform1f(debugRingFalloffLocation, params.ringFalloff);
    gl.uniform1f(
      debugRingDistortionStrengthLocation,
      params.ringDistortionStrength
    );
    gl.uniform1f(debugRingDistortionSpeedLocation, params.ringDistortionSpeed);
    gl.uniform1f(debugRingNoiseMixLocation, params.ringNoiseMix);

    // set debug flags
    gl.uniform1i(debugShowNoiseLocation, params.debugNoise ? 1 : 0);
    gl.uniform1i(debugShowRingLocation, params.debugRing ? 1 : 0);

    // disable blending for debug view
    gl.disable(gl.BLEND);

    // draw full-screen quad
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  } else {
    // normal mode: render mesh
    const { count: indexCount, type: indexType } = updateMesh();

    gl.useProgram(sawtoothProgram);

    // enable blending for alpha fade
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // set up attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, offsetBuffer);
    gl.enableVertexAttribArray(triangleOffsetLocation);
    gl.vertexAttribPointer(triangleOffsetLocation, 1, gl.FLOAT, false, 0, 0);

    // set time uniform
    gl.uniform1f(sawtoothTimeLocation, time / 1000.0);

    // set noise texture and threshold uniforms
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
    gl.uniform1i(sawtoothNoiseTextureLocation, 0);
    gl.uniform1f(sawtoothThresholdLocation, params.threshold);
    gl.uniform2f(sawtoothResolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(sawtoothCycleSpeedLocation, params.sawtoothCycleSpeed);

    // draw mesh
    if (indexCount > 0) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.drawElements(gl.TRIANGLES, indexCount, indexType, 0);
    }
  }

  // animate and retriangulate every frame
  requestAnimationFrame(render);
}

// function to copy settings to clipboard
function copySettingsToClipboard() {
  const settings = JSON.stringify(params, null, 2);
  navigator.clipboard
    .writeText(settings)
    .then(() => {
      console.log("Settings copied to clipboard");
    })
    .catch((err) => {
      console.error("Failed to copy settings:", err);
    });
}

// function to update photo visibility based on debug mode
function updatePhotoVisibility() {
  const photos = document.querySelectorAll(".photo");
  const isDebugActive =
    params.debugMode && (params.debugNoise || params.debugRing);
  photos.forEach((photo) => {
    if (isDebugActive) {
      // hide all photos in debug mode
      photo.style.opacity = "0";
      photo.style.pointerEvents = "none";
    } else {
      // restore original behavior - CSS classes will handle visibility
      photo.style.opacity = "";
      photo.style.pointerEvents = "";
    }
  });
}

// initialize GUI
const gui = new GUI();
const debugModeController = gui.add(params, "debugMode").name("Debug Mode");
debugModeController.onChange(() => {
  updatePhotoVisibility();
});
const debugNoiseController = gui.add(params, "debugNoise").name("Debug Noise");
debugNoiseController.onChange(() => {
  updatePhotoVisibility();
});
const debugRingController = gui.add(params, "debugRing").name("Debug Ring");
debugRingController.onChange(() => {
  updatePhotoVisibility();
});
gui.add(params, "threshold", 0.0, 1.0).name("Threshold");
gui.add(params, "noiseOffset", -5.0, 5.0).name("Noise Offset");
gui.add(params, "noiseValue", 0.0, 5.0).name("Noise Value");
gui.add(params, "noiseMin", -2.0, 1.0).name("Noise Min");
gui.add(params, "noiseMax", -1.0, 2.0).name("Noise Max");
gui.add(params, "ringMax", 0.0, 5.0).name("Ring Max");
gui.add(params, "ringRadius", 0.0, 1.0).name("Ring Radius");
gui.add(params, "ringFalloff", 0.0, 0.5).name("Ring Falloff");
gui
  .add(params, "ringDistortionStrength", 0.0, 0.5)
  .name("Ring Distortion Strength");
gui.add(params, "ringDistortionSpeed", 0.0, 5.0).name("Ring Distortion Speed");
gui.add(params, "ringNoiseMix", 0.0, 1.0).name("Ring/Noise Mix");
gui.add(params, "noiseSpeed", 0.0, 5.0).name("Noise Speed");
gui.add(params, "sawtoothCycleSpeed", 0.0, 20.0).name("Sawtooth Cycle Speed");
gui
  .add({ copySettings: copySettingsToClipboard }, "copySettings")
  .name("Copy Settings");

// hide GUI by default
gui.hide();

// toggle GUI visibility with 'c' key
document.addEventListener("keydown", (event) => {
  if (event.key === "c" || event.key === "C") {
    if (gui._hidden) {
      gui.show();
    } else {
      gui.hide();
    }
  }
});

// initialize photo visibility based on debug mode
updatePhotoVisibility();

// start animation
render(0);
