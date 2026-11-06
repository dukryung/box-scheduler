# The meeting transcription service on a Linux server without a GPU (Whisper on the
# CPU through faster-whisper). The models (Whisper large-v3-turbo about 1.6 GB, the
# diarization models about 45 MB) are baked into the image, so it runs offline.
#   docker build -t box-stt stt
#   docker run -d --name box-stt --restart unless-stopped -p <LAN IP>:11435:11435 box-stt
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir faster-whisper sherpa-onnx soundfile numpy

ENV HF_HOME=/app/hf
ARG R=https://github.com/k2-fsa/sherpa-onnx/releases/download
WORKDIR /app/models
RUN curl -sSfL $R/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj \
    && curl -sSfLO $R/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
RUN python -c 'from faster_whisper import download_model; download_model("large-v3-turbo")'

WORKDIR /app
COPY server.py .
ENV STT_BACKEND=faster STT_HOST=0.0.0.0 STT_PORT=11435 HF_HUB_OFFLINE=1
EXPOSE 11435
CMD ["python", "server.py"]
