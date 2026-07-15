#!/bin/bash
# Start the understand-anything dashboard
export GRAPH_DIR="E:/00lixins/web-access-main"
export UNDERSTAND_ACCESS_TOKEN="my-token-123"
cd "C:/Users/lixins/.claude/plugins/cache/Understand-Anything/understand-anything/2.7.5/packages/dashboard"
npx vite --port 4399
