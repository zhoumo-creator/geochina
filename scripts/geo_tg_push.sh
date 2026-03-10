#!/bin/bash
# GEO China — Telegram Daily Report Push Script
# Deploy this to your Singapore server alongside OpenClaw
# Bot: @test091231bot
#
# Usage:
#   ./geo_tg_push.sh "Your report message here"
#   ./geo_tg_push.sh --file /path/to/report.md
#
# Environment variables required:
#   GEO_TG_BOT_TOKEN  — Bot API token from @BotFather
#   GEO_TG_CHAT_ID    — Your personal chat ID (get via /getUpdates)
#
# To get your chat_id:
#   1. Send any message to @test091231bot
#   2. Run: curl "https://api.telegram.org/bot${GEO_TG_BOT_TOKEN}/getUpdates"
#   3. Find "chat":{"id": YOUR_CHAT_ID} in the response

set -e

# Check env vars
if [ -z "$GEO_TG_BOT_TOKEN" ]; then
    echo "❌ GEO_TG_BOT_TOKEN not set"
    echo "Run: export GEO_TG_BOT_TOKEN='your-token-here'"
    exit 1
fi

if [ -z "$GEO_TG_CHAT_ID" ]; then
    echo "❌ GEO_TG_CHAT_ID not set"
    echo "Run: export GEO_TG_CHAT_ID='your-chat-id'"
    echo ""
    echo "To get your chat ID:"
    echo "  1. Send a message to @test091231bot"
    echo "  2. curl 'https://api.telegram.org/bot${GEO_TG_BOT_TOKEN}/getUpdates'"
    exit 1
fi

API_URL="https://api.telegram.org/bot${GEO_TG_BOT_TOKEN}"

# Read message from arg or file
if [ "$1" == "--file" ] && [ -n "$2" ]; then
    MESSAGE=$(cat "$2")
elif [ -n "$1" ]; then
    MESSAGE="$1"
else
    echo "Usage: $0 \"message\" or $0 --file /path/to/report.md"
    exit 1
fi

# Telegram has a 4096 char limit, split if needed
if [ ${#MESSAGE} -le 4096 ]; then
    curl -s -X POST "${API_URL}/sendMessage" \
        -d "chat_id=${GEO_TG_CHAT_ID}" \
        -d "parse_mode=Markdown" \
        -d "text=${MESSAGE}" > /dev/null
    echo "✅ Report sent to @test091231bot"
else
    # Split into chunks
    echo "$MESSAGE" | fold -w 4000 -s | while IFS= read -r chunk; do
        curl -s -X POST "${API_URL}/sendMessage" \
            -d "chat_id=${GEO_TG_CHAT_ID}" \
            -d "parse_mode=Markdown" \
            -d "text=${chunk}" > /dev/null
        sleep 1
    done
    echo "✅ Report sent to @test091231bot (multi-part)"
fi
