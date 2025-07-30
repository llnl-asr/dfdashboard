#!/bin/bash

if [[ -z $ROOT_DIR ]]; then
    # Traverse up root dir until got _root_dir_
    ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    while [[ "$ROOT_DIR" != "/" && ! -f "$ROOT_DIR/_root_dir_" ]]; do ROOT_DIR="$(dirname "$ROOT_DIR")"; done; [[ -f "$ROOT_DIR/_root_dir_" ]] || { echo "cannot find root dir of the project!"; exit 1; }
fi

# load necessary utilities
source $ROOT_DIR/scripts/utils.sh

# =========================
# Arguments
# =========================
ENV_DIR="$ROOT_DIR/.venv"
WITHOUT_DFTRACER=0

usage() {
    echo "Usage: $0 --env-dir <path>"
    echo "    --env-dir (default: $ROOT_DIR/.env)"
    exit 1
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-dir)
            ENV_DIR="$2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Validation of arguments
## making sure env_dir are defined properly
[[ -z "$ENV_DIR" ]] && log ERROR "Error: --env-dir are required." && echo && usage
# =========================

hm=$(hostname)

# env: load specific platform configuration
if [[ $hm == *corona* ]]; then
    source $ROOT_DIR/scripts/platforms/corona/env.sh
fi

# env: prelude
# place where we load necessary modules for specific platform
env_prelude

# cache folder
pkgdir=$ROOT_DIR/.cache/pip
mkdir -p $pkgdir
export PIP_CACHE_DIR=$pkgdir

# re-exporting venv dir
export VENV_DIR="$ENV_DIR"
export VIRTUAL_ENV="$ENV_DIR"
env_create_virtual_env
source $VENV_DIR/bin/activate

log "Python version: $(python --version)"

export PYTHONPATH="$ROOT_DIR:$PYTHONPATH"

# install_py_pkg_if_needed "uv"