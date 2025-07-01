#!/bin/bash

env_prelude() {
    log "Setting up environment on corona"

    # tcsh users: to reinit modules for a bash script
    source /etc/profile.d/z00_lmod.sh

    module use /opt/toss/modules/modulefiles/

    export GCC_VERSION="12.1.1"
    require_module gcc/$GCC_VERSION
    export CC=`which gcc`
    export CXX=`which g++`

    export PY_VERSION="3.12"
    require_module python/$PY_VERSION
}

env_create_virtual_env() {
    assert "is_defined VENV_DIR" "VENV_DIR must be defined and not empty"
    if [[ ! -f $VENV_DIR/bin/python ]]; then
        virtualenv --system-site-packages $VENV_DIR
        python3 -m venv $VENV_DIR
    fi
}