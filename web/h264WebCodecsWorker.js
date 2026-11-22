let pendingFrames = [],
    underflow = true,
    sps,
    decoder,
    socket,
    height,
    width,
    windowHeight,
    windowWidth,
    ctx;

const MAX_BUFFER_SIZE = 4;
const MAX_DECODE_QUEUE_SIZE = 8;
const MAX_TEXTURE_POOL_SIZE = 5;
const STATS_INTERVAL_MS = 1000;

let dropDeltaUntilKeyframe = false;
let skippedFrames = 0;
let lastStatsTime = 0;

const texturePool = [];

function getTexture(gl) {
    if(texturePool.length > 0) return texturePool.pop();
    return gl.createTexture();
}

function releaseTexture(gl, texture) {
    if (texturePool.length < MAX_TEXTURE_POOL_SIZE) {
        texturePool.push(texture);
    } else {
        gl.deleteTexture(texture);
    }
}

async function renderFrame() {
    if (pendingFrames.length === 0) {
        return;
    }
    const frame = pendingFrames.shift();
    drawImageToCanvas(gl, frame);
    sendStatsToMainThread();

    if (pendingFrames.length > 0) {
        await renderFrame();
    }
}

function drawImageToCanvas(gl, image) {
    const texture = getTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

    if (isPowerOf2(width) && isPowerOf2(height)) {
        gl.generateMipmap(gl.TEXTURE_2D);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindTexture(gl.TEXTURE_2D, null);
    releaseTexture(gl, texture);

    if (image.close) {
        image.close();
    }
}

function nalHeaderOffset(bytes) {
    if (!bytes || bytes.length < 3) {
        return -1;
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes.length > 3 && bytes[3] === 0x01) {
        return 4;
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) {
        return 3;
    }
    return -1;
}

function nalType(bytes) {
    const offset = nalHeaderOffset(bytes);
    if (offset < 0 || offset >= bytes.length) {
        return -1;
    }
    return bytes[offset] & 0x1f;
}

function decodeBacklogged() {
    if (pendingFrames.length > MAX_BUFFER_SIZE) {
        return true;
    }
    return !!decoder && typeof decoder.decodeQueueSize === 'number' &&
        decoder.decodeQueueSize > MAX_DECODE_QUEUE_SIZE;
}

function decodeNal(dat, isKey) {
    if (!decoder || decoder.state !== 'configured') {
        self.postMessage({ error: true });
        return;
    }

    if (!isKey && (dropDeltaUntilKeyframe || decodeBacklogged())) {
        // Deltas are only decodable after the next keyframe, so drop them all until one arrives.
        dropDeltaUntilKeyframe = true;
        skippedFrames++;
        return;
    }

    let data = dat;
    if (isKey) {
        if (!sps) {
            self.postMessage({ error: true });
            return;
        }
        data = appendByteArray(sps, dat);
    }

    const chunk = new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: 0,
        duration: 0,
        data: data
    });

    try {
        decoder.decode(chunk);
        if (isKey) {
            dropDeltaUntilKeyframe = false;
        }
    } catch (e) {
        if (!isKey) {
            dropDeltaUntilKeyframe = true;
        }
        self.postMessage({ error: true });
    }
}

function videoMagic(dat) {
    const unittype = nalType(dat);

    if (unittype === 1) {
        decodeNal(dat, false);
    } else if (unittype === 5) {
        decodeNal(dat, true);
    }
}

function headerMagic(dat) {
    const offset = nalHeaderOffset(dat);
    const unittype = nalType(dat);

    if (unittype === 7) {
        if (dat.length < offset + 4) {
            self.postMessage({ error: true });
            return;
        }

        let config = {
            codec: "avc1.",
            codedHeight: height,
            codedWidth: width,
            displayAspectWidth: windowWidth,
            displayAspectHeight: windowHeight,
            hardwareAcceleration: "prefer-hardware",
            optimizeForLatency: true
        }
        for (let i = offset + 1; i < offset + 4; ++i) {
            var h = dat[i].toString(16);
            if (h.length < 2) {
                h = '0' + h;
            }
            config.codec += h;
        }
        // Copy so a retained SPS doesn't pin the whole message buffer.
        sps = dat.slice();
        dropDeltaUntilKeyframe = true;
        try {
            decoder.configure(config);
        } catch (e) {
            self.postMessage({ error: e });
        }

        return;
    }
    else if (unittype === 8)
        sps = sps ? appendByteArray(sps, dat) : dat.slice()
    else
        videoMagic(dat);
}

function appendByteArray(buffer1, buffer2) {
    const tmp = new Uint8Array((buffer1.byteLength | 0) + (buffer2.byteLength | 0));
    tmp.set(buffer1, 0);
    tmp.set(buffer2, buffer1.byteLength | 0);
    return tmp;
}

// Splits Annex-B access units by start code, without copying bytes.
function separateNalUnits(bytes) {
    const units = [];
    if (!bytes || bytes.length < 4) {
        return units;
    }

    let currentStart = -1;
    let index = 0;

    while (index <= bytes.length - 4) {
        let codeLength = 0;
        if (bytes[index] === 0x00 && bytes[index + 1] === 0x00 &&
            bytes[index + 2] === 0x00 && bytes[index + 3] === 0x01) {
            codeLength = 4;
        } else if (bytes[index] === 0x00 && bytes[index + 1] === 0x00 && bytes[index + 2] === 0x01) {
            codeLength = 3;
        }

        if (codeLength === 0) {
            index += 1;
            continue;
        }

        if (currentStart >= 0 && index > currentStart) {
            units.push(bytes.subarray(currentStart, index));
        }
        currentStart = index;
        index += codeLength;
    }

    if (currentStart >= 0 && currentStart < bytes.length) {
        units.push(bytes.subarray(currentStart));
    }

    return units;
}

function handleMessage(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    const units = separateNalUnits(bytes);
    for (let i = 0; i < units.length; ++i) {
        headerMagic(units[i]);
    }

    trimPendingFrames();
}

function trimPendingFrames() {
    // pendingFrames holds already-decoded frames, so dropping the oldest never breaks decoding.
    while (pendingFrames.length > MAX_BUFFER_SIZE) {
        const frame = pendingFrames.shift();
        if (frame && frame.close) {
            frame.close();
        }
        skippedFrames++;
    }
}

function sendStatsToMainThread() {
    const now = Date.now();
    if (now - lastStatsTime < STATS_INTERVAL_MS) {
        return;
    }
    lastStatsTime = now;

    const stats = {
        skippedFrames: skippedFrames,
        bufferLength: pendingFrames.length,
    };
    postMessage(stats);
}

function initializeGL(gl) {
    const vertexSource = `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_position, 0, 1);
            v_texCoord = a_texCoord;
        }
    `;
    const fragmentSource = `
        precision mediump float;
        uniform sampler2D u_image;
        varying vec2 v_texCoord;
        void main() {
            gl_FragColor = texture2D(u_image, v_texCoord);
        }
    `;

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    positionLocation = gl.getAttribLocation(program, "a_position");
    texcoordLocation = gl.getAttribLocation(program, "a_texCoord");

    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]), gl.STATIC_DRAW);

    texcoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0]), gl.STATIC_DRAW);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.useProgram(program);
    gl.enableVertexAttribArray(positionLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(texcoordLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
    gl.vertexAttribPointer(texcoordLocation, 2, gl.FLOAT, false, 0, 0);
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (success) {
        return shader;
    }
    console.log(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
}

self.onmessage = function (event) {
    if (event.data.canvas && event.data.displayWidth && event.data.displayHeight) {
        const offscreenCanvas = event.data.canvas;
        height = event.data.displayHeight;
        width = event.data.displayWidth;
        windowHeight = event.data.windowHeight;
        windowWidth = event.data.windowWidth;
        gl = offscreenCanvas.getContext("webgl2");
        if (!gl) {
            gl = offscreenCanvas.getContext("webgl");
        }
        if (!gl) {
            throw new Error("Failed to get WebGL context.");
        }

        initializeGL(gl);
        decoder = new VideoDecoder({
            output: (frame) => {
                pendingFrames.push(frame);
                if (underflow) {
                    renderFrame();
                }
            },
            error: e => self.postMessage({ error: e }),
        });
    } else if (event.data.h264Data) {
        handleMessage(event.data.h264Data);
    }
}

function isPowerOf2(value) {
    return (value & (value - 1)) == 0;
}