FROM debian:bookworm-slim AS whisper-build

ARG WHISPER_VERSION=v1.8.6

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git cmake build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp.git whisper.cpp \
    && cmake -S whisper.cpp -B whisper.cpp/build \
        -DWHISPER_BUILD_EXAMPLES=ON \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build whisper.cpp/build --config Release --target whisper-cli -j2 \
    && mkdir -p /out/bin /out/lib /out/models \
    && cp whisper.cpp/build/bin/whisper-cli /out/bin/whisper-cli \
    && find whisper.cpp/build -type f \( -name 'libwhisper.so*' -o -name 'libggml*.so*' \) -exec cp -a {} /out/lib/ \; \
    && cd /out/lib \
    && ln -s libwhisper.so.1.8.6 libwhisper.so.1 \
    && ln -s libggml.so.0.13.1 libggml.so.0 \
    && ln -s libggml-base.so.0.13.1 libggml-base.so.0 \
    && ln -s libggml-cpu.so.0.13.1 libggml-cpu.so.0 \
    && cd /tmp \
    && bash whisper.cpp/models/download-ggml-model.sh base /out/models

FROM node:24-bookworm-slim AS app-build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY policies ./policies
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    LD_LIBRARY_PATH=/opt/whisper/lib \
    WHISPER_CLI_PATH=/opt/whisper/bin/whisper-cli \
    WHISPER_MODEL_PATH=/opt/whisper/models/ggml-base.bin \
    FFMPEG_CLI_PATH=/usr/bin/ffmpeg \
    TESSERACT_CLI_PATH=/usr/bin/tesseract \
    MEDIA_UNDERSTANDING_ENABLED=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=app-build /app/package*.json ./
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/dist ./dist
COPY --from=app-build /app/policies ./policies
COPY --from=whisper-build /out/bin/whisper-cli /opt/whisper/bin/whisper-cli
COPY --from=whisper-build /out/lib/ /opt/whisper/lib/
COPY --from=whisper-build /out/models/ggml-base.bin /opt/whisper/models/ggml-base.bin

RUN useradd --system --uid 10001 --create-home appuser \
    && chown -R appuser:appuser /app /opt/whisper

USER appuser

CMD ["npm", "start"]
