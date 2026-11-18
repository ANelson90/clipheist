#!/usr/bin/env bash
# Regenerates the small synthetic test videos used by the test suite (requires ffmpeg).
# All content is generated from ffmpeg test sources: no third-party or game footage.
set -euo pipefail
cd "$(dirname "$0")"
Q="-loglevel error -y"

# 59.94 fps VP9/Opus WebM: brightness encodes the frame index
ffmpeg $Q -f lavfi -i "color=c=gray:s=640x360:r=60000/1001:d=7,geq=lum='mod(N*5\,250)+3':cb=128:cr=128" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:d=7" -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -c:a libopus -b:a 48k -shortest cfr5994.webm

# 29.97 fps H.264 (with B-frames) + AAC MP4
ffmpeg $Q -f lavfi -i "testsrc2=s=640x360:r=30000/1001:d=7" -f lavfi -i "sine=frequency=550:sample_rate=44100:d=7" \
  -c:v libx264 -preset veryfast -crf 30 -bf 2 -g 30 -c:a aac -b:a 64k -movflags +faststart -shortest bframes2997.mp4

# 60 fps moving pattern for effects/transitions
ffmpeg $Q -f lavfi -i "testsrc2=s=640x360:r=60:d=6" -f lavfi -i "sine=frequency=440:sample_rate=48000:d=6" \
  -c:v libvpx-vp9 -b:v 800k -deadline realtime -cpu-used 8 -c:a libopus -b:a 48k -shortest pattern60.webm

# 60 s "gameplay" with three action bursts (fast motion + loud noise at 10-14 s, 31-35 s, 48-52 s) and a flash at 24 s
ffmpeg $Q -f lavfi -i "smptebars=s=640x360:r=30:d=60" -f lavfi -i "testsrc2=s=640x360:r=30:d=60" \
  -f lavfi -i "sine=frequency=180:sample_rate=48000:d=60" -f lavfi -i "anoisesrc=color=white:sample_rate=48000:d=60:amplitude=0.8" \
  -filter_complex "[0][1]overlay=enable='between(t,10,14)+between(t,31,35)+between(t,48,52)'[v1];[v1]eq=brightness=0.5:enable='between(t,24,24.4)'[v];[2]volume=0.05[a1];[3]volume='if(between(t,11,13)+between(t,32,34)+between(t,49,51),0.9,0.003)':eval=frame[a2];[a1][a2]amix=inputs=2:normalize=0[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 32 -g 60 -c:a aac -b:a 64k -movflags +faststart action.mp4

# 120 BPM kick/hat loop for beat-sync tests
ffmpeg $Q -f lavfi -i "aevalsrc='0.9*sin(2*PI*60*t)*exp(-25*mod(t,0.5))+0.2*sin(2*PI*440*t)*exp(-40*mod(t+0.25,0.5))':s=48000:d=12" \
  -c:a libmp3lame -b:a 64k beat120.mp3

ls -la
