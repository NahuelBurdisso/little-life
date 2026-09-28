#!/bin/bash
# ─── Little Life LLM Setup ───────────────────────────────────────────────────
# Configures Ollama for parallel inference and pulls required models.
#
# Usage:
#   bash scripts/setup-llm.sh              # Default: single model, parallel=4
#   bash scripts/setup-llm.sh --tiered     # Pull a light model for routine tasks
#   bash scripts/setup-llm.sh --check      # Just check current status
#
# Requirements: Ollama installed and running (ollama serve)
# ──────────────────────────────────────────────────────────────────────────────

set -e

HEAVY_MODEL="huihui_ai/gemma-4-abliterated:e4b"
LIGHT_MODEL="qwen2.5:3b"
EMBED_MODEL="mxbai-embed-large"
NUM_PARALLEL=4

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Check Ollama ────────────────────────────────────────────────────────────

check_ollama() {
  if ! command -v ollama &>/dev/null; then
    echo -e "${RED}Ollama not found. Install from https://ollama.com${NC}"
    exit 1
  fi

  if ! ollama ps &>/dev/null; then
    echo -e "${RED}Ollama not running. Start with: ollama serve${NC}"
    exit 1
  fi

  echo -e "${GREEN}Ollama is running${NC}"
  echo ""
  echo "Loaded models:"
  ollama ps
  echo ""
  echo "Available models:"
  ollama list
  echo ""

  # Check GPU
  if command -v nvidia-smi &>/dev/null; then
    echo "GPU status:"
    nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader
    echo ""
  fi
}

# ─── Pull Models ─────────────────────────────────────────────────────────────

pull_model() {
  local model=$1
  local label=$2
  if ollama list 2>/dev/null | grep -q "$(echo "$model" | cut -d: -f1)"; then
    echo -e "${GREEN}$label already available: $model${NC}"
  else
    echo -e "${CYAN}Pulling $label: $model ...${NC}"
    ollama pull "$model"
    echo -e "${GREEN}$label ready${NC}"
  fi
}

# ─── Configure Parallel Inference ────────────────────────────────────────────

configure_parallel() {
  echo -e "${CYAN}Configuring Ollama for parallel inference (NUM_PARALLEL=$NUM_PARALLEL)${NC}"
  echo ""
  echo -e "${YELLOW}To enable parallel inference, set this environment variable BEFORE starting Ollama:${NC}"
  echo ""
  echo "  On Windows (PowerShell):"
  echo "    \$env:OLLAMA_NUM_PARALLEL = \"$NUM_PARALLEL\""
  echo "    ollama serve"
  echo ""
  echo "  On Windows (System Environment Variables):"
  echo "    1. Search 'Environment Variables' in Start menu"
  echo "    2. Add system variable: OLLAMA_NUM_PARALLEL = $NUM_PARALLEL"
  echo "    3. Restart Ollama"
  echo ""
  echo "  On Linux/Mac:"
  echo "    OLLAMA_NUM_PARALLEL=$NUM_PARALLEL ollama serve"
  echo ""
  echo -e "${YELLOW}Current Ollama process does NOT pick up env changes — restart required.${NC}"
}

# ─── Update .env for Tiered Models ───────────────────────────────────────────

update_env_tiered() {
  local envfile="$(dirname "$0")/../.env"
  if [ -f "$envfile" ]; then
    sed -i "s|^LIGHT_MODEL=.*|LIGHT_MODEL=$LIGHT_MODEL|" "$envfile"
    echo -e "${GREEN}Updated .env: LIGHT_MODEL=$LIGHT_MODEL${NC}"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

case "${1:-}" in
  --check)
    check_ollama
    ;;
  --tiered)
    check_ollama
    echo "─── Pulling models ───"
    pull_model "$HEAVY_MODEL" "Heavy (conversations)"
    pull_model "$LIGHT_MODEL" "Light (planning/goals)"
    pull_model "$EMBED_MODEL" "Embeddings"
    echo ""
    echo "─── Configuring ───"
    configure_parallel
    update_env_tiered
    echo ""
    echo -e "${GREEN}Setup complete!${NC}"
    echo ""
    echo "VRAM estimate:"
    echo "  Heavy ($HEAVY_MODEL):  ~11 GB"
    echo "  Light ($LIGHT_MODEL):   ~2 GB"
    echo "  Embed ($EMBED_MODEL):  ~0.7 GB"
    echo "  Total:                 ~14 GB / 24 GB"
    echo ""
    echo "Restart Ollama with OLLAMA_NUM_PARALLEL=$NUM_PARALLEL, then run: npm run dev"
    ;;
  *)
    check_ollama
    echo "─── Pulling models ───"
    pull_model "$HEAVY_MODEL" "Chat"
    pull_model "$EMBED_MODEL" "Embeddings"
    echo ""
    echo "─── Configuring ───"
    configure_parallel
    echo ""
    echo -e "${GREEN}Setup complete!${NC}"
    echo "Restart Ollama with OLLAMA_NUM_PARALLEL=$NUM_PARALLEL, then run: npm run dev"
    ;;
esac
