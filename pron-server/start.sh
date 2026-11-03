#!/bin/bash
# SpeakMate 发音评测服务启动脚本
source ~/envs/pron/bin/activate
export PATH="$HOME/.local/espeak/usr/bin:$PATH"
export ESPEAK_DATA_PATH="$HOME/.local/espeak/usr/lib/x86_64-linux-gnu/espeak-ng-data"
export LD_LIBRARY_PATH="$HOME/.local/espeak/usr/lib/x86_64-linux-gnu"
export PHONEMIZER_ESPEAK_LIBRARY="$HOME/.local/espeak/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1"
export PHONEMIZER_ESPEAK_PATH="$HOME/.local/espeak/usr/bin/espeak-ng"
export HF_HUB_OFFLINE=1
export PRON_PORT=8600
exec python /mnt/d/Work/SpeakMate/pron-server/server.py
