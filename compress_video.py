#!/usr/bin/env python3
"""Compress one video to a Telegram-friendly MP4 without changing the source.

Run ``python compress_video.py`` for interactive use, or pass ``--input`` and
optional ``--output``/``--target-mb`` arguments.
Requires ffmpeg and ffprobe on PATH.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_TARGET_MB = 47
MAX_TARGET_MB = 49
DEFAULT_AUDIO_KBPS = 128
MAX_ATTEMPTS = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Video file to compress")
    parser.add_argument("--output", type=Path, help="Output MP4 path (default: <name>_compressed.mp4)")
    parser.add_argument(
        "--target-mb",
        type=float,
        default=DEFAULT_TARGET_MB,
        help=f"Maximum output size in MB (default: {DEFAULT_TARGET_MB}; maximum: {MAX_TARGET_MB})",
    )
    parser.add_argument(
        "--audio-kbps",
        type=int,
        default=DEFAULT_AUDIO_KBPS,
        help=f"AAC audio bitrate in kbps (default: {DEFAULT_AUDIO_KBPS})",
    )
    return parser.parse_args()


def prompt_for_input() -> Path:
    raw_path = input("Video file path (you can drag a file here): ").strip().strip('"')
    if not raw_path:
        raise ValueError("No input video was provided.")
    return Path(raw_path)


def get_duration(ffprobe: str, video_path: Path) -> float:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    duration_value = json.loads(result.stdout)["format"].get("duration")
    if duration_value is None:
        raise ValueError("Could not determine the video duration.")
    duration = float(duration_value)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Could not determine a valid video duration.")
    return duration


def run_ffmpeg(command: list[str]) -> None:
    subprocess.run(command, check=True)


def compress_video(
    ffmpeg: str,
    source: Path,
    destination: Path,
    target_bytes: int,
    audio_kbps: int,
    duration: float,
) -> int:
    audio_bits_per_second = audio_kbps * 1000
    available_bits_per_second = target_bytes * 8 / duration
    video_kbps = int((available_bits_per_second - audio_bits_per_second - 24_000) / 1000 * 0.94)
    if video_kbps < 100:
        raise ValueError(
            "The target size is too small for this video's duration at the selected audio bitrate."
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial_output = destination.with_name(f".{destination.stem}.partial.mp4")
    if partial_output.exists():
        partial_output.unlink()

    try:
        with tempfile.TemporaryDirectory(prefix="video-compress-") as temp_dir:
            pass_log = str(Path(temp_dir) / "ffmpeg-pass")
            for attempt in range(1, MAX_ATTEMPTS + 1):
                print(
                    f"Compressing (pass {attempt}/{MAX_ATTEMPTS}, "
                    f"video bitrate {video_kbps} kbps)…"
                )
                if partial_output.exists():
                    partial_output.unlink()
                run_ffmpeg(
                    [
                        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                        "-i", str(source),
                        "-map", "0:v:0", "-an",
                        "-c:v", "libx264", "-preset", "medium",
                        "-b:v", f"{video_kbps}k", "-pass", "1",
                        "-passlogfile", pass_log,
                        "-f", "null", "NUL" if os.name == "nt" else "/dev/null",
                    ]
                )
                run_ffmpeg(
                    [
                        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                        "-i", str(source),
                        "-map", "0:v:0", "-map", "0:a?",
                        "-c:v", "libx264", "-preset", "medium",
                        "-b:v", f"{video_kbps}k", "-pass", "2",
                        "-passlogfile", pass_log,
                        "-c:a", "aac", "-b:a", f"{audio_kbps}k",
                        "-movflags", "+faststart",
                        str(partial_output),
                    ]
                )
                actual_bytes = partial_output.stat().st_size
                if actual_bytes <= target_bytes:
                    partial_output.replace(destination)
                    return actual_bytes
                if attempt < MAX_ATTEMPTS:
                    ratio = target_bytes / actual_bytes
                    video_kbps = max(100, int(video_kbps * ratio * 0.94))

        raise ValueError(
            f"Could not reach the target size after {MAX_ATTEMPTS} attempts. "
            "Try a larger target size or a lower audio bitrate."
        )
    finally:
        if partial_output.exists():
            partial_output.unlink()


def main() -> int:
    args = parse_args()
    if not math.isfinite(args.target_mb) or not 1 <= args.target_mb <= MAX_TARGET_MB:
        print(f"Target size must be between 1 and {MAX_TARGET_MB} MB.", file=sys.stderr)
        return 2
    if not 32 <= args.audio_kbps <= 320:
        print("Audio bitrate must be between 32 and 320 kbps.", file=sys.stderr)
        return 2

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print(
            "FFmpeg and ffprobe are required. Install FFmpeg and add its bin folder to PATH.",
            file=sys.stderr,
        )
        return 2

    try:
        source = args.input if args.input else prompt_for_input()
        source = source.expanduser().resolve()
        if not source.is_file():
            raise ValueError(f"Input video was not found: {source}")
        if source.suffix.lower() not in {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}:
            raise ValueError("Choose a supported video file (MP4, MOV, MKV, AVI, WEBM, or M4V).")
        if source.stat().st_size == 0:
            raise ValueError("The input video is empty.")
        duration = get_duration(ffprobe, source)

        destination = args.output.expanduser().resolve() if args.output else source.with_name(
            f"{source.stem}_compressed.mp4"
        )
        if destination == source:
            raise ValueError("The output must be a different file so the original stays safe.")
        if destination.exists():
            raise ValueError(
                f"Output already exists: {destination}. Choose another name with --output."
            )

        target_bytes = int(args.target_mb * 1_000_000)
        original_bytes = source.stat().st_size
        print(f"Source: {source}")
        print(f"Original size: {original_bytes / 1_000_000:.2f} MB")
        print(f"Target: at most {args.target_mb:.1f} MB")
        if original_bytes <= target_bytes:
            shutil.copy2(source, destination)
            output_bytes = original_bytes
            print("Already under the target; copied without re-encoding.")
        else:
            output_bytes = compress_video(
                ffmpeg,
                source,
                destination,
                target_bytes,
                args.audio_kbps,
                duration,
            )
        print(f"Compressed video saved: {destination}")
        print(f"Output size: {output_bytes / 1_000_000:.2f} MB")
        print(f"Reduced by: {(1 - output_bytes / original_bytes) * 100:.1f}%")
        return 0
    except (
        OSError,
        TypeError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"Compression failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
