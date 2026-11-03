#!/bin/zsh
# Sets up the meeting transcription service on the Mac mini (Apple Silicon, Homebrew
# with python@3.12 and ffmpeg). Run it there from this folder: ./install.sh
# It installs into ~/box-stt, downloads the models (Whisper large-v3-turbo about
# 1.6 GB, the diarization models about 45 MB) and starts it at login on 127.0.0.1:11435.
set -e
DIR=~/box-stt
BREW=/opt/homebrew/bin
R=https://github.com/k2-fsa/sherpa-onnx/releases/download

mkdir -p $DIR/models
cp server.py $DIR/server.py
[ -d $DIR/venv ] || $BREW/python3.12 -m venv $DIR/venv
$DIR/venv/bin/pip install -q --upgrade pip
$DIR/venv/bin/pip install -q mlx-whisper sherpa-onnx soundfile numpy

cd $DIR/models
if [ ! -f sherpa-onnx-pyannote-segmentation-3-0/model.onnx ]; then
  curl -sSfL $R/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj
fi
[ -f 3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx ] ||
  curl -sSfLO $R/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
$DIR/venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("mlx-community/whisper-large-v3-turbo")'

PLIST=~/Library/LaunchAgents/com.boxscheduler.stt.plist
cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.boxscheduler.stt</string>
  <key>ProgramArguments</key>
  <array><string>$DIR/venv/bin/python</string><string>$DIR/server.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$BREW:/usr/bin:/bin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DIR/stt.log</string>
  <key>StandardErrorPath</key><string>$DIR/stt.log</string>
</dict>
</plist>
EOF
launchctl bootout gui/$(id -u)/com.boxscheduler.stt 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $PLIST
for i in $(seq 1 30); do curl -sf 127.0.0.1:11435/health && echo && exit 0; sleep 1; done
echo "the service did not start; see $DIR/stt.log" >&2
exit 1
