#!/bin/bash

## Colors taken from
## https://github.com/saforem2/ezpz/blob/361e6bd8b4873c50b84152f9e4cce20003eecf18/src/ezpz/bin/utils.sh#L27

if [[ -n "${NO_COLOR:-}" || -n "${NOCOLOR:-}" || "${COLOR:-}" == 0 || "${TERM}" == "dumb" ]]; then
    # Enable color support for `ls` and `grep`
    # shopt -s dircolors
    # shopt -s colorize
    # shopt -s colorize_grep
    export RESET=''
    export BLACK=''
    export RED=''
    export BRIGHT_RED=''
    export GREEN=''
    export BRIGHT_GREEN=''
    export YELLOW=''
    export BRIGHT_YELLOW=''
    export BLUE=''
    export BRIGHT_BLUE=''
    export MAGENTA=''
    export BRIGHT_MAGENTA=''
    export CYAN=''
    export BRIGHT_CYAN=''
    export WHITE=''
    export BRIGHT_WHITE=''
else
    # --- Color Codes ---
    # Usage: printf "${RED}This is red text${RESET}\n"
    export RESET='\e[0m'
    # BLACK='\e[1;30m' # Avoid black text
    export RED='\e[1;31m'
    export BRIGHT_RED='\e[1;91m' # Added for emphasis
    export GREEN='\e[1;32m'
    export BRIGHT_GREEN='\e[1;92m' # Added for emphasis
    export YELLOW='\e[1;33m'
    export BRIGHT_YELLOW='\e[1;93m' # Added for emphasis
    export BLUE='\e[1;34m'
    export BRIGHT_BLUE='\e[1;94m' # Added for emphasis
    export MAGENTA='\e[1;35m'
    export BRIGHT_MAGENTA='\e[1;95m' # Added for emphasis
    export CYAN='\e[1;36m'
    export BRIGHT_CYAN='\e[1;96m' # Added for emphasis
    export WHITE='\e[1;37m'       # Avoid white on light terminals
    export BRIGHT_WHITE='\e[1;97m' # Added for emphasis
fi

DEFAULT_LOG_LEVEL="${DEFAULT_LOG_LEVEL:-INFO}"
export DEFAULT_LOG_LEVEL

log() {
    local level
    local string
    local ts
    ts=$(get_tstamp_ns)

    # Check if the first argument is a log level
    case "$1" in
        DEBUG|INFO|WARN|ERROR|FATAL)
            level="$1"
            shift
            string="$*"
            ;;
        *)
            level="$DEFAULT_LOG_LEVEL"
            string="$*"
            ;;
    esac

    local log_level
    case "${level}" in
        DEBUG) log_level="${CYAN}D${RESET}" ;;
        INFO) log_level="${GREEN}I${RESET}" ;;
        WARN) log_level="${YELLOW}W${RESET}" ;;
        ERROR) log_level="${RED}E${RESET}" ;;
        FATAL) log_level="${RED}F${RESET}" ;;
        *) log_level="${GREEN}I${RESET}" ;; # Default to INFO
    esac

    log_msg="[${log_level}][${BRIGHT_BLUE}${ts}${RESET}] ${string}"
    # Redirect ERROR and FATAL to stderr
    if [[ "$level" == "ERROR" || "$level" == "FATAL" ]]; then
        echo -e "$log_msg" >&2
    elif [[ "$level" == "DEBUG" ]]; then
        if is_debug_mode; then
            echo -e "$log_msg"
        fi
    else
        echo -e "$log_msg"
    fi
}

get_tstamp_ns() {
    date "+%Y-%m-%d %H:%M:%S,%N"
}

get_tstamp() {
    # date "+%Y-%m-%d-%H%M%S"
    date "+%Y-%m-%d-%H-%M-%S"
}

get_tstamp_uniq() {
    echo "$(date "+%Y-%m-%d-%H-%M-%S")-$$-$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 4)"
}

is_defined() {
    local var="$1"
    [[ -n "${!var+x}" && -n "${!var}" ]]
}

is_truthy() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes) return 0 ;;
        *) return 1 ;;
    esac
}

is_falsy() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
        0|false|no|"") return 0 ;;
        *) return 1 ;;
    esac
}

is_debug_mode() {
    is_truthy "$DEBUG_MODE"
}

assert() {
    if ! eval "$1"; then
        log ERROR "Assertion failed: ${2:-$1}" >&2
        exit 1
    fi
}

todo() {
    local file="${BASH_SOURCE[1]}"
    local line="${BASH_LINENO[0]}"

    if [[ $# -eq 0 ]]; then
        log ERROR "Not implemented yet at $file:$line"
    else
        log ERROR "$1: not implemented yet at $file:$line"
    fi
    exit 1
}

load_module() {
    local module="$1"
    local fatal="$2"

    log "Loading module $module"
    if is_debug_mode; then
        module load $module
    else
        module load $module > /dev/null 2>&1
        if [[ $? -ne 0 ]]; then
            log ERROR "┗━━ Failed to load module $module"
            if is_truthy "$fatal"; then
                exit 1
            fi
        else
            log "┗━━ Successfully load module $module"
        fi
    fi
}

require_module() {
    local module="$1"
    load_module "$module" 1
}

normalize_rocm_wheel_version() {
    local version="${1//\"/}"
    IFS='.' read -r -a parts <<< "$version"

    local major="${parts[0]:-0}"
    local minor="${parts[1]:-0}"
    local patch="${parts[2]:-0}"

    local norm="${major}${minor}${patch}"

    while [[ ${#norm} -lt 3 ]]; do
        norm="${norm}0"
    done

    echo "$norm"
}

is_version() {
    local v1="${1//\"/}"
    local op="$2"
    local v2="${3//\"/}"

    # Split into arrays
    IFS='.' read -r -a a1 <<< "$v1"
    IFS='.' read -r -a a2 <<< "$v2"

    # Pad missing parts with zeros
    for i in 0 1 2; do
        a1[$i]=${a1[$i]:-0}
        a2[$i]=${a2[$i]:-0}
    done

    # Compose comparable numbers
    local n1=$((10#${a1[0]} * 100 + 10#${a1[1]} * 10 + 10#${a1[2]}))
    local n2=$((10#${a2[0]} * 100 + 10#${a2[1]} * 10 + 10#${a2[2]}))

    case "$op" in
        LESS_THAN)
            [[ $n1 -lt $n2 ]]
            ;;
        LESS_EQUAL)
            [[ $n1 -le $n2 ]]
            ;;
        GREATER_THAN)
            [[ $n1 -gt $n2 ]]
            ;;
        GREATER_EQUAL)
            [[ $n1 -ge $n2 ]]
            ;;
        EQUAL)
            [[ $n1 -eq $n2 ]]
            ;;
        *)
            echo "Invalid operator: $op" >&2
            return 2
            ;;
    esac
}

# Function: check_py_pkg_installed
# Purpose: Check if a Python package directory exists in the site-packages directory
# Usage: check_py_pkg_installed <package_name>
# Requirements:
#   - PY_VERSION environment variable must be set (e.g., "3.10")
#   - The corresponding python executable (e.g., python3.10) must be available
check_py_pkg_installed() {
    assert "is_defined PY_VERSION" "PY_VERSION must be defined and not empty"

    if [ -z "$1" ]; then
        echo "Usage: check_py_pkg_installed <package_name>"
        return 1
    fi

    local pkg_name="$1"
    local pkg_dir_name="$2"
    local py_exec="python${PY_VERSION}"

    if [ "$pkg_dir_name" == "" ]; then
        pkg_dir_name="$pkg_name"
    fi

    # Get the site-packages directory for the specified Python version
    local site_packages_dir
    site_packages_dir=$($py_exec -c "import site; print(site.getsitepackages()[0])" 2>/dev/null)

    # Check if the python executable and site-packages directory were found
    if [ -z "$site_packages_dir" ] || [ ! -d "$site_packages_dir" ]; then
        log ERROR "Error: Could not determine site-packages for Python $PY_VERSION."
        return 3
    fi

    if [ -f "$site_packages_dir/$pkg_dir_name.py" ]; then
        # Check if the package file exists in site-packages
        return 0
    elif [ -d "$site_packages_dir/$pkg_dir_name" ]; then
        # Check if the package directory exists in site-packages
        return 0
    else
        # log ERROR "Package '$pkg_name' is NOT installed in Python $PY_VERSION."
        return 4
    fi
}

# Function: check_py_pkg_or_exit
# Purpose: Check if a Python package is installed; exit script if not found
# Usage: check_py_pkg_or_exit <package_name>
check_py_pkg_or_exit() {
    # Call the check_py_pkg_installed function with the given package name
    check_py_pkg_installed "$1"
    local status=$?
    if [ $status -eq 4 ]; then
        log ERROR "Exiting: Required Python package '$1' is not installed."
        exit 1
    elif [ $status -ne 0 ]; then
        log ERROR "Exiting: Error occurred during package check."
        exit $status
    fi
}

install_py_pkg_if_needed() {
    assert "is_defined PY_VERSION" "PY_VERSION must be defined and not empty"

    local pkg="$1"
    local pkg_dir="$2"

    # Check if the package is already installed
    check_py_pkg_installed "$pkg" "$pkg_dir"
    local status=$?
    if [ $status -eq 0 ]; then
        log DEBUG "Python package '$pkg' is already installed. Exiting."
    elif [ $status -eq 4 ]; then
        log "Python package '$pkg' is not installed. Installing..."
        # Attempt to install the package
        python${PY_VERSION} -m pip install "$pkg"
        if [ $? -eq 0 ]; then
            log "Successfully installed '$pkg'."
        else
            log ERROR "Failed to install '$pkg'."
            exit 3
        fi
    else
        log ERROR "Error occurred during package check."
        exit $status
    fi
}

install_mpi4py_if_needed() {
    # mpi4py has problem with GCC 12.0 debugging symbols
    #   which is still a persisting problem in this issue:
    #   https://github.com/mpi4py/mpi4py/issues/652  
    #   because of this compilation exponentially slower and increase memory
    #   here we will pass CFLAGS to remove `-g`
    # or if you are too afraid, just use older version of mpi4py
    #   I tested that mpi4py==3.16.0 able to compile fast
    OLD_CFLAGS="$CFLAGS"
    export CFLAGS="-Wsign-compare -DNDEBUG -fwrapv -Wall -fstack-protector-strong -Wformat -Werror=format-security -fwrapv -O3" 
    install_py_pkg_if_needed mpi4py
    unset CFLAGS
    export CFLAGS="$OLD_CFLAGS"
}

dftracer_preload_loc() {
    assert "is_defined VENV_DIR" "VENV_DIR must be defined and not empty"
    assert "is_defined PY_VERSION" "PY_VERSION must be defined and not empty"

    if [[ -f "${VENV_DIR}/lib/python${PY_VERSION}/site-packages/dftracer/lib64/libdftracer_preload.so" ]]; then
        echo "${VENV_DIR}/lib/python${PY_VERSION}/site-packages/dftracer/lib64/libdftracer_preload.so"
    elif [[ -f "${VENV_DIR}/lib/python${PY_VERSION}/site-packages/dftracer/lib/libdftracer_preload.so" ]]; then
        echo "${VENV_DIR}/lib/python${PY_VERSION}/site-packages/dftracer/lib/libdftracer_preload.so"
    else
        log ERROR "dftracer preload lib -- NOT FOUND, exiting..."
        exit 1
    fi
}

set_dftracer_env() {
    if is_truthy $DISABLE_DFTRACER; then
        log INFO "dftracer is disabled"
        return
    fi
    check_py_pkg_installed pydftracer dftracer
    export DFTRACER_ENABLE=1
    export DFTRACER_INC_METADATA=1
    export DFTRACER_PRELOAD=$(dftracer_preload_loc)
    export LD_PRELOAD="${DFTRACER_PRELOAD}:${LD_PRELOAD}"
    log "DFTracer"
    log "┣━━ Enabled      = 1"
    log "┣━━ INC METADATA = 1"
    log "┗━━ PRELOAD      = $DFTRACER_PRELOAD"
}

s_pushd() {
    pushd "$@" > /dev/null 2>&1
    local new_dir="$PWD"
    log "Entering \"$new_dir\""
}

s_popd() {
    local prev_dir="$PWD"
    # Perform popd
    popd "$@" > /dev/null 2>&1
    log "Exiting \"$prev_dir\""
}

glob_disable() {
    set -f
}

glob_enable() {
    set +f
}