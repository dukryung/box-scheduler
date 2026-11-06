"""Meeting transcription for Box Scheduler, run on the Mac mini or a Linux server.

Whisper (large-v3-turbo; on Apple's GPU through MLX on a Mac, on the CPU through
faster-whisper elsewhere) writes down what was said, and sherpa-onnx (pyannote
segmentation + a speaker embedding model) tells the speakers apart. Jobs run one
at a time; the API polls for the result.

  POST   /v1/jobs?language=ko&speakers=3&prompt=...   body: the audio file
  GET    /v1/jobs/{id}      status, stage, and when done the segments
  DELETE /v1/jobs/{id}
  GET    /health

It listens on 127.0.0.1 unless STT_HOST says otherwise; on the Mac mini the API
reaches it through the SSH tunnel.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import soundfile as sf

HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "11435"))
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("STT_MODELS", os.path.join(HERE, "models"))
# mlx (Apple Silicon) | faster (CPU, faster-whisper)
BACKEND = os.environ.get("STT_BACKEND", "mlx" if sys.platform == "darwin" else "faster")
WHISPER = os.environ.get("STT_WHISPER", "mlx-community/whisper-large-v3-turbo" if BACKEND == "mlx" else "large-v3-turbo")
THREADS = int(os.environ.get("STT_THREADS", "0"))  # faster-whisper's CPU threads; 0 is its own choice
SEGMENTATION = os.path.join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
EMBEDDING = os.path.join(MODELS, os.environ.get("STT_EMBEDDING", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"))
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
# Two voices whose embeddings are closer than this are taken for one speaker
# (when the number of speakers is not given).
THRESHOLD = float(os.environ.get("STT_THRESHOLD", "0.9"))
MAX_BYTES = 400 * 1024 * 1024
LINE_CHARS = 300  # a long turn is cut into lines of about this length
KEEP_SECONDS = 6 * 3600
# A job is stopped after LIMIT_BASE seconds plus LIMIT_RATIO times the recording's
# length (it normally takes about a quarter of the length).
LIMIT_BASE = 300
LIMIT_RATIO = 1.5  # finished jobs are forgotten after this
RATE = 16000

# Lines Whisper is known to make up in silence or noise.
MADE_UP = ("시청해 주셔서 감사합니다", "구독과 좋아요", "MBC 뉴스", "자막 제공", "다음 영상에서")

jobs = {}
lock = threading.Lock()
work = queue.Queue()


def now():
    return time.time()


def public(job):
    out = {k: job[k] for k in ("id", "status", "stage", "error", "created", "started", "finished", "duration")}
    if job["status"] == "queued":
        with lock:
            waiting = [j for j in jobs.values() if j["status"] == "queued"]
        out["position"] = sorted(waiting, key=lambda j: j["created"]).index(job) + 1
    if job["status"] == "done":
        out["result"] = job["result"]
    return out


def decode(path):
    wav = path + ".wav"
    subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", wav], check=True)
    samples, rate = sf.read(wav, dtype="float32", always_2d=False)
    assert rate == RATE
    return wav, samples


_diarizer = {}


def diarizer(speakers):
    import sherpa_onnx

    key = speakers or 0
    if key not in _diarizer:
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEGMENTATION),
                num_threads=4,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMBEDDING, num_threads=4),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=speakers or -1, threshold=THRESHOLD),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise RuntimeError("diarization models are missing")
        _diarizer[key] = sherpa_onnx.OfflineSpeakerDiarization(config)
    return _diarizer[key]


def diarize(samples, speakers):
    turns = diarizer(speakers).process(samples).sort_by_start_time()
    return [(t.start, t.end, t.speaker) for t in turns]


def transcribe(samples, language, prompt):
    if BACKEND == "faster":
        return transcribe_cpu(samples, language, prompt)
    import mlx_whisper

    return mlx_whisper.transcribe(
        samples,
        path_or_hf_repo=WHISPER,
        language=language or None,
        initial_prompt=prompt or None,
        word_timestamps=True,
        # Carrying text over makes Whisper repeat itself after a long pause.
        condition_on_previous_text=False,
        hallucination_silence_threshold=2.0,
    )


def transcribe_cpu(samples, language, prompt):
    """The same as transcribe, through faster-whisper, in mlx-whisper's shape."""
    from faster_whisper import WhisperModel

    model = WhisperModel(WHISPER, device="cpu", compute_type="int8", cpu_threads=THREADS)
    segments, info = model.transcribe(
        samples,
        language=language or None,
        initial_prompt=prompt or None,
        word_timestamps=True,
        condition_on_previous_text=False,
        hallucination_silence_threshold=2.0,
    )
    return {
        "language": info.language,
        "segments": [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "no_speech_prob": s.no_speech_prob,
                "avg_logprob": s.avg_logprob,
                "words": [{"word": w.word, "start": w.start, "end": w.end} for w in s.words or []],
            }
            for s in segments
        ],
    }


def speaker_at(turns, start, end):
    """The speaker who talks most between start and end, or the nearest one."""
    best, overlap = None, 0.0
    for s, e, who in turns:
        o = min(e, end) - max(s, start)
        if o > overlap:
            best, overlap = who, o
    if best is not None:
        return best, True
    mid = (start + end) / 2
    near = min(turns, key=lambda t: min(abs(t[0] - mid), abs(t[1] - mid)), default=None)
    if near is None:
        return 0, False
    return near[2], min(abs(near[0] - mid), abs(near[1] - mid)) < 1.0


def made_up(seg):
    text = seg.get("text", "").strip()
    if not text:
        return True
    if any(m in text for m in MADE_UP):
        return True
    return seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0


def join(words):
    return "".join(w["word"] for w in words).strip()


def merge(whisper, turns):
    """Splits Whisper's text at speaker changes and labels each piece."""
    pieces = []
    for seg in whisper["segments"]:
        if made_up(seg):
            continue
        words = seg.get("words") or [{"word": seg["text"], "start": seg["start"], "end": seg["end"]}]
        run, who = [], None
        for w in words:
            speaker, heard = speaker_at(turns, w["start"], w["end"]) if turns else (0, True)
            if not heard:
                continue  # no one is talking there: Whisper made it up
            if run and speaker != who:
                pieces.append({"start": run[0]["start"], "end": run[-1]["end"], "speaker": who, "text": join(run)})
                run = []
            run.append(w)
            who = speaker
        if run:
            pieces.append({"start": run[0]["start"], "end": run[-1]["end"], "speaker": who, "text": join(run)})

    # One line per turn: pieces of the same speaker close together become one.
    lines = []
    for p in pieces:
        if not p["text"]:
            continue
        last = lines[-1] if lines else None
        if last and last["speaker"] == p["speaker"] and p["start"] - last["end"] < 3.0 and len(last["text"]) < LINE_CHARS:
            last["text"] = (last["text"] + " " + p["text"]).strip()
            last["end"] = p["end"]
        else:
            lines.append(dict(p))

    # Speakers are numbered by when they first talk.
    order = {}
    for line in lines:
        order.setdefault(line["speaker"], len(order) + 1)
    for line in lines:
        line["speaker"] = order[line["speaker"]]
        line["start"] = round(line["start"], 2)
        line["end"] = round(line["end"], 2)
    return lines, len(order)


def work_on(wav, language, speakers, prompt):
    """Runs in a child process: writes the stages and then the result to stdout."""
    samples, _ = sf.read(wav, dtype="float32", always_2d=False)
    print("STAGE transcribe", flush=True)
    t = now()
    whisper = transcribe(samples, language, prompt)
    transcribed = now() - t
    print("STAGE diarize", flush=True)
    t = now()
    turns = diarize(samples, speakers) if len(samples) > RATE else []
    diarized = now() - t
    segments, found = merge(whisper, turns)
    result = {
        "language": whisper.get("language", language),
        "speakers": found,
        "segments": segments,
        "timing": {"diarize": round(diarized, 1), "transcribe": round(transcribed, 1)},
    }
    print("RESULT " + json.dumps(result, ensure_ascii=False), flush=True)


def run(job):
    """Decodes the recording, then transcribes it in a child process, which is
    stopped if it takes far longer than it should (Whisper can get stuck
    repeating itself) so the jobs behind it still run."""
    path = job["path"]
    wav = None
    try:
        job["stage"] = "decode"
        wav, samples = decode(path)
        job["duration"] = round(len(samples) / RATE, 2)
        del samples
        deadline = now() + LIMIT_BASE + job["duration"] * LIMIT_RATIO
        child = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--work", wav, job["language"], str(job["speakers"]), job["prompt"]],
            stdout=subprocess.PIPE, text=True,
        )
        timer = threading.Timer(max(1.0, deadline - now()), child.kill)
        timer.start()
        result = None
        try:
            for line in child.stdout:
                if line.startswith("STAGE "):
                    job["stage"] = line[6:].strip()
                elif line.startswith("RESULT "):
                    result = json.loads(line[7:])
            child.wait()
        finally:
            timer.cancel()
        if result is None:
            if now() >= deadline:
                raise RuntimeError("transcription took too long and was stopped")
            raise RuntimeError(f"transcription stopped (exit {child.returncode})")
        job["result"] = result
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001 - any failure is the job's
        traceback.print_exc()
        job["status"] = "failed"
        job["error"] = str(e)[:500] or e.__class__.__name__
    finally:
        job["stage"] = None
        job["finished"] = now()
        for p in (path, wav):
            if p and os.path.exists(p):
                os.remove(p)


def worker():
    while True:
        job = work.get()
        if job["status"] != "queued":
            continue
        job["status"] = "running"
        job["started"] = now()
        run(job)


def sweep():
    while True:
        time.sleep(600)
        with lock:
            for id in [i for i, j in jobs.items() if j["finished"] and now() - j["finished"] > KEEP_SECONDS]:
                del jobs[id]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def job(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["v1", "jobs"]:
            with lock:
                return jobs.get(parts[2])
        return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            with lock:
                waiting = sum(1 for j in jobs.values() if j["status"] in ("queued", "running"))
            return self.send(200, {"ok": True, "model": WHISPER, "jobs": waiting})
        job = self.job()
        if not job:
            return self.send(404, {"error": "no such job"})
        self.send(200, public(job))

    def do_DELETE(self):
        job = self.job()
        if not job:
            return self.send(404, {"error": "no such job"})
        with lock:
            if job["status"] == "queued":
                job["status"] = "failed"
                job["error"] = "cancelled"
                job["finished"] = now()
                if os.path.exists(job["path"]):
                    os.remove(job["path"])
            if job["status"] != "running":
                jobs.pop(job["id"], None)
        self.send(200, {"ok": True})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/v1/jobs":
            return self.send(404, {"error": "not found"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0:
            return self.send(400, {"error": "no audio"})
        if size > MAX_BYTES:
            return self.send(413, {"error": "audio too large"})
        q = parse_qs(url.query)
        try:
            speakers = int(q.get("speakers", ["0"])[0])
        except ValueError:
            speakers = 0
        fd, path = tempfile.mkstemp(prefix="box-stt-")
        with os.fdopen(fd, "wb") as f:
            left = size
            while left:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left:
            os.remove(path)
            return self.send(400, {"error": "audio cut short"})
        job = {
            "id": uuid.uuid4().hex,
            "status": "queued",
            "stage": None,
            "error": None,
            "created": now(),
            "started": None,
            "finished": None,
            "duration": None,
            "path": path,
            "language": q.get("language", ["ko"])[0][:8],
            "speakers": max(0, min(speakers, 20)),
            "prompt": q.get("prompt", [""])[0][:400],
            "result": None,
        }
        with lock:
            jobs[job["id"]] = job
        work.put(job)
        self.send(202, public(job))

    def log_message(self, fmt, *args):
        if os.environ.get("STT_LOG"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "--work":
        work_on(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5])
        sys.exit(0)
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=sweep, daemon=True).start()
    print(f"box-stt on {HOST}:{PORT}, whisper {WHISPER} ({BACKEND})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
