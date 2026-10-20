"""
DigiPin Urban Intelligence — Video Audio Builder
=================================================
Generates TTS narration audio and merges with recorded video.

Pipeline:
  1. Read narration-log.json (timestamps from recorder)
  2. Generate TTS audio per narration using edge-tts
  3. Merge all audio tracks at correct timestamps using ffmpeg
  4. Combine with video → final MP4 with audio

Prerequisites:
  pip install edge-tts
  ffmpeg must be in PATH (download from https://ffmpeg.org)

Usage:
  python build-final-video.py
  python build-final-video.py --voice en-US-GuyNeural
  python build-final-video.py --music path/to/bgm.mp3
"""

import asyncio
import json
import os
import subprocess
import sys
import shutil
from pathlib import Path

import make_bgm

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ════════════════════════════════════════════════════════════
# CONFIGURATION
# ════════════════════════════════════════════════════════════

VIDEO_DIR = Path("video-output")
AUDIO_DIR = VIDEO_DIR / "narration-clips"
INPUT_VIDEO = VIDEO_DIR / "DigiPin-Walkthrough-Final.webm"
NARRATION_LOG = VIDEO_DIR / "narration-log.json"
OUTPUT_VIDEO = VIDEO_DIR / "DigiPin-Final-WithAudio.mp4"

# TTS voice options (pick one):
#   en-IN-PrabhatNeural   — Indian English male (natural, fits DigiPin's India context)
#   en-IN-NeerjaNeural    — Indian English female
#   en-US-GuyNeural       — American English male (clear, professional)
#   en-US-JennyNeural     — American English female
#   en-GB-RyanNeural      — British English male
DEFAULT_VOICE = "en-IN-PrabhatNeural"

# Background music volume (0.0 to 1.0, relative to narration)
BGM_VOLUME = 0.08

# Narration volume boost (1.0 = normal, 1.5 = louder)
NARRATION_VOLUME = 1.3


def find_ffmpeg():
    """Auto-detect ffmpeg, checking PATH and common WinGet install locations."""
    if shutil.which("ffmpeg"):
        return "ffmpeg", "ffprobe"

    # Search WinGet install directory on Windows
    winget_dir = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    if winget_dir.exists():
        for ffmpeg_exe in winget_dir.rglob("ffmpeg.exe"):
            ffprobe_exe = ffmpeg_exe.parent / "ffprobe.exe"
            if ffprobe_exe.exists():
                return str(ffmpeg_exe), str(ffprobe_exe)

    return None, None


FFMPEG, FFPROBE = find_ffmpeg()


# ════════════════════════════════════════════════════════════
# STEP 1: GENERATE TTS AUDIO
# ════════════════════════════════════════════════════════════

async def generate_narration_audio(narrations, voice):
    """Generate TTS audio files for each narration entry."""
    try:
        import edge_tts
    except ImportError:
        print("\n  [!] edge-tts not installed. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "edge-tts"])
        import edge_tts

    # edge-tts pins certifi; trust the system CA bundle too so synthesis works
    # behind a TLS-inspecting proxy.
    import ssl
    import edge_tts.communicate as ec
    ca = os.environ.get("SSL_CERT_FILE") or "/etc/ssl/certs/ca-certificates.crt"
    if os.path.exists(ca):
        ec._SSL_CTX = ssl.create_default_context(cafile=ca)

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n  Generating {len(narrations)} narration clips...")
    print(f"  Voice: {voice}\n")

    for i, entry in enumerate(narrations):
        text = entry["text"]
        output_file = AUDIO_DIR / f"narration_{i:03d}.mp3"

        # Skip if already generated (for re-runs)
        if output_file.exists():
            print(f"  [{i+1:2d}/{len(narrations)}] Cached: {output_file.name}")
            continue

        print(f"  [{i+1:2d}/{len(narrations)}] Generating: {text[:60]}...")
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(str(output_file))

    print(f"\n  All {len(narrations)} clips generated in {AUDIO_DIR}/")


# ════════════════════════════════════════════════════════════
# STEP 2: GET AUDIO DURATIONS
# ════════════════════════════════════════════════════════════

def get_audio_duration_ms(filepath):
    """Get audio file duration in milliseconds using ffprobe."""
    result = subprocess.run(
        [
            FFPROBE, "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            str(filepath)
        ],
        capture_output=True, text=True
    )
    try:
        return int(float(result.stdout.strip()) * 1000)
    except (ValueError, AttributeError):
        return 5000  # fallback 5s


def get_video_duration_ms(filepath):
    """Get video file duration in milliseconds using ffprobe."""
    result = subprocess.run(
        [
            FFPROBE, "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            str(filepath)
        ],
        capture_output=True, text=True
    )
    try:
        return int(float(result.stdout.strip()) * 1000)
    except (ValueError, AttributeError):
        return 0


# ════════════════════════════════════════════════════════════
# STEP 3: MERGE AUDIO + VIDEO WITH FFMPEG
# ════════════════════════════════════════════════════════════

def merge_video_audio(narrations, bgm_path=None):
    """
    Merge all narration clips into a single audio track at correct timestamps,
    then combine with the video file.
    """
    if not INPUT_VIDEO.exists():
        print(f"\n  [ERROR] Video not found: {INPUT_VIDEO}")
        print("  Run 'node extras/record-video.mjs' first to record the video.")
        sys.exit(1)

    video_duration_ms = get_video_duration_ms(INPUT_VIDEO)
    print(f"\n  Video duration: {video_duration_ms/1000:.1f}s")

    # Build ffmpeg filter graph
    # Input 0: video file
    # Input 1..N: narration audio files
    # Input N+1: background music (optional)

    inputs = ["-i", str(INPUT_VIDEO)]
    filter_parts = []
    mix_inputs = []

    clip_count = 0
    for i, entry in enumerate(narrations):
        clip_path = AUDIO_DIR / f"narration_{i:03d}.mp3"
        if not clip_path.exists():
            print(f"  [WARN] Missing clip: {clip_path}")
            continue

        timestamp_ms = entry["time_ms"]
        duration_ms = get_audio_duration_ms(clip_path)

        inputs.extend(["-i", str(clip_path)])
        input_idx = clip_count + 1  # 0 is video

        # adelay: delay this clip to its timestamp position
        # volume: boost narration volume
        filter_parts.append(
            f"[{input_idx}:a]adelay={timestamp_ms}|{timestamp_ms},"
            f"volume={NARRATION_VOLUME}[nar{clip_count}]"
        )
        mix_inputs.append(f"[nar{clip_count}]")
        clip_count += 1

        print(f"  Clip {i+1:2d}: @{timestamp_ms/1000:6.1f}s  dur={duration_ms/1000:.1f}s  {entry['text'][:50]}...")

    if clip_count == 0:
        print("\n  [ERROR] No narration clips found!")
        sys.exit(1)

    # Combine the time-aligned narration clips into one voice track.
    mix_str = "".join(mix_inputs)
    filter_parts.append(
        f"{mix_str}amix=inputs={len(mix_inputs)}:duration=longest:"
        f"dropout_transition=2:normalize=0[voiceraw]"
    )

    # Background music: use the supplied track, else synthesise a royalty-free
    # ambient bed. Mixed under the voice with sidechain ducking so it dips
    # automatically whenever narration plays.
    if not bgm_path:
        bgm_path = VIDEO_DIR / "bgm.mp3"
        print(f"\n  Background music: generating ambient bed ({video_duration_ms/1000:.0f}s)…")
        make_bgm.generate(str(bgm_path), video_duration_ms / 1000 + 2)
    if bgm_path and Path(bgm_path).exists():
        inputs.extend(["-i", str(bgm_path)])
        bgm_input_idx = clip_count + 1
        filter_parts.append(
            f"[{bgm_input_idx}:a]aloop=loop=-1:size=2e+09,"
            f"atrim=0:{video_duration_ms/1000},volume={BGM_VOLUME}[bed]"
        )
        filter_parts.append("[voiceraw]asplit=2[voiceout][voicekey]")
        filter_parts.append(
            "[bed][voicekey]sidechaincompress="
            "threshold=0.015:ratio=8:attack=20:release=400[bgduck]"
        )
        filter_parts.append(
            "[voiceout][bgduck]amix=inputs=2:duration=longest:normalize=0,"
            "dynaudnorm=f=250:g=7,aresample=44100[aout]"
        )
        print(f"  Background music: {bgm_path} (volume={BGM_VOLUME}, ducked)")
    else:
        if bgm_path:
            print(f"  [WARN] Background music not found: {bgm_path}. Continuing without music.")
            bgm_path = None
        filter_parts.append("[voiceraw]aresample=44100[aout]")

    filter_graph = ";\n".join(filter_parts)

    # Build final ffmpeg command
    cmd = [
        FFMPEG, "-y",
        *inputs,
        "-filter_complex", filter_graph,
        "-map", "0:v",          # video from input 0
        "-map", "[aout]",       # mixed audio
        "-c:v", "libx264",      # re-encode video as H.264
        "-preset", "medium",
        "-crf", "20",           # high quality
        "-c:a", "aac",          # AAC audio
        "-b:a", "192k",         # good audio bitrate
        "-shortest",            # stop when shortest stream ends
        str(OUTPUT_VIDEO)
    ]

    print(f"\n  Merging {clip_count} narration clips + video...")
    print(f"  Output: {OUTPUT_VIDEO}\n")

    # Write the filter graph to a temp file for debugging
    filter_file = VIDEO_DIR / "ffmpeg-filter.txt"
    filter_file.write_text(filter_graph)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print("  [ERROR] ffmpeg failed:")
            print(result.stderr[-2000:] if len(result.stderr) > 2000 else result.stderr)
            # Try simpler approach without complex filter
            print("\n  Retrying with simplified merge...")
            merge_simple(narrations)
        else:
            file_size = OUTPUT_VIDEO.stat().st_size / (1024 * 1024)
            print(f"\n  Video saved: {OUTPUT_VIDEO}")
            print(f"  File size: {file_size:.1f} MB")
            print(f"  Narration clips: {clip_count}")
            if bgm_path:
                print(f"  Background music: included")
    except FileNotFoundError:
        print("\n  [ERROR] ffmpeg not found!")
        print("  Install ffmpeg: https://ffmpeg.org/download.html")
        print("  Or: winget install ffmpeg")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("\n  [ERROR] ffmpeg timed out after 5 minutes")
        sys.exit(1)


def merge_simple(narrations):
    """
    Simpler fallback: concatenate all narration into one audio file,
    then merge with video. Less precise timing but more compatible.
    """
    concat_list = VIDEO_DIR / "concat-list.txt"
    lines = []

    for i, entry in enumerate(narrations):
        clip_path = AUDIO_DIR / f"narration_{i:03d}.mp3"
        if clip_path.exists():
            lines.append(f"file '{clip_path.resolve()}'")

    if not lines:
        print("  [ERROR] No clips for simple merge")
        return

    concat_list.write_text("\n".join(lines))

    # Concatenate all narration clips
    concat_audio = VIDEO_DIR / "narration-combined.mp3"
    subprocess.run([
        FFMPEG, "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(concat_list),
        "-c:a", "libmp3lame", "-b:a", "192k",
        str(concat_audio)
    ], capture_output=True)

    # Merge with video
    subprocess.run([
        FFMPEG, "-y",
        "-i", str(INPUT_VIDEO),
        "-i", str(concat_audio),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(OUTPUT_VIDEO)
    ])

    if OUTPUT_VIDEO.exists():
        file_size = OUTPUT_VIDEO.stat().st_size / (1024 * 1024)
        print(f"\n  Video saved (simple merge): {OUTPUT_VIDEO}")
        print(f"  File size: {file_size:.1f} MB")


# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════

async def main():
    """CLI: synthesize narration and assemble the final DigiPin explainer video."""
    import argparse
    parser = argparse.ArgumentParser(description="Build DigiPin video with narration audio")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"TTS voice (default: {DEFAULT_VOICE})")
    parser.add_argument("--music", default=None, help="Path to background music file (MP3/WAV)")
    parser.add_argument("--regenerate", action="store_true", help="Regenerate all audio clips")
    args = parser.parse_args()

    print("\n  +--------------------------------------------+")
    print("  |  DigiPin Video Audio Builder               |")
    print("  |  TTS: edge-tts | Merge: ffmpeg             |")
    print("  +--------------------------------------------+")

    # Check prerequisites
    global FFMPEG, FFPROBE
    if not FFMPEG:
        print("\n  [ERROR] ffmpeg not found!")
        print("  Install: winget install Gyan.FFmpeg")
        print("  Or download from: https://ffmpeg.org/download.html")
        sys.exit(1)

    print(f"  ffmpeg: {FFMPEG}")
    print(f"  ffprobe: {FFPROBE}")

    # Load narration log
    if not NARRATION_LOG.exists():
        print(f"\n  [ERROR] Narration log not found: {NARRATION_LOG}")
        print("  Run 'node extras/record-video.mjs' first to record the video.")
        sys.exit(1)

    with open(NARRATION_LOG) as f:
        narrations = json.load(f)

    print(f"\n  Found {len(narrations)} narration entries")

    # Clear cached clips if regenerating
    if args.regenerate and AUDIO_DIR.exists():
        shutil.rmtree(AUDIO_DIR)
        print("  Cleared cached audio clips")

    # Step 1: Generate TTS audio
    await generate_narration_audio(narrations, args.voice)

    # Step 2: Merge audio + video
    merge_video_audio(narrations, args.music)

    print("\n  Done! Play the final video:")
    print(f"  start {OUTPUT_VIDEO}\n")


if __name__ == "__main__":
    asyncio.run(main())
