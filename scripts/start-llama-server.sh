#!/bin/bash
# ─── Start llama-server (llama.cpp) for Little Life ──────────────────────────
#
# This starts llama-server with continuous batching for maximum throughput.
# Use this INSTEAD of Ollama for the chat model. Embeddings still go via Ollama.
#
# Prerequisites:
#   1. Download llama-server from https://github.com/ggerganov/llama.cpp/releases
#   2. Download a GGUF model (e.g., gemma-2-9b-it-Q5_K_M.gguf)
#   3. Set MODEL_PATH below
#
# After starting, update .env:
#   LLM_BACKEND=openai
#   LLM_BASE_URL=http://localhost:8080
#
# Keep Ollama running for embeddings (EMBED_BASE_URL=http://localhost:11434)
# ──────────────────────────────────────────────────────────────────────────────

# ─── Configuration ───────────────────────────────────────────────────────────
LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"  # Path to llama-server binary
MODEL_PATH="${MODEL_PATH:-}"                  # Path to .gguf model file
PORT=8080
GPU_LAYERS=99        # Offload all layers to GPU
CONTEXT_SIZE=4096    # Context window
PARALLEL=4           # Concurrent request slots (continuous batching)
BATCH_SIZE=512       # Batch size for prompt processing

if [ -z "$MODEL_PATH" ]; then
  echo "Error: MODEL_PATH not set."
  echo ""
  echo "Usage:"
  echo "  MODEL_PATH=/path/to/model.gguf bash scripts/start-llama-server.sh"
  echo ""
  echo "Download models from https://huggingface.co (search for GGUF format)"
  echo "Recommended: gemma-2-9b-it-Q5_K_M.gguf or similar 8-12B model"
  exit 1
fi

echo "Starting llama-server..."
echo "  Model: $MODEL_PATH"
echo "  Port: $PORT"
echo "  Parallel slots: $PARALLEL"
echo "  GPU layers: $GPU_LAYERS"
echo ""
echo "Once running, update .env:"
echo "  LLM_BACKEND=openai"
echo "  LLM_BASE_URL=http://localhost:$PORT"
echo ""

exec "$LLAMA_SERVER" \
  --model "$MODEL_PATH" \
  --port "$PORT" \
  --n-gpu-layers "$GPU_LAYERS" \
  --ctx-size "$CONTEXT_SIZE" \
  --parallel "$PARALLEL" \
  --batch-size "$BATCH_SIZE" \
  --cont-batching \
  --flash-attn
