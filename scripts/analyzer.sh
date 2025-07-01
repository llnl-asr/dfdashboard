#!/bin/bash

if [[ -z $ROOT_DIR ]]; then
    # Traverse up root dir until got _root_dir_
    ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    while [[ "$ROOT_DIR" != "/" && ! -f "$ROOT_DIR/_root_dir_" ]]; do ROOT_DIR="$(dirname "$ROOT_DIR")"; done; [[ -f "$ROOT_DIR/_root_dir_" ]] || { echo "cannot find root dir of the project!"; exit 1; }
fi

# load necessary utilities
source $ROOT_DIR/scripts/utils.sh

source $ROOT_DIR/scripts/setup-env.sh --env-dir $ROOT_DIR/.venv/analyzer --framework tensorflow --without-dftracer

DEVELOPMENT=1

# dependencies
install_py_pkg_if_needed "numpy"
install_py_pkg_if_needed "seaborn"
install_py_pkg_if_needed "matplotlib"
install_py_pkg_if_needed "pandas"
install_py_pkg_if_needed "dask[complete]" "dask"
install_py_pkg_if_needed "pyarrow"
install_py_pkg_if_needed "rich"
install_py_pkg_if_needed "zindex-py" "zindex_py"
install_py_pkg_if_needed "python-intervals" "intervals"
install_py_pkg_if_needed "tyro"
install_py_pkg_if_needed "PyYAML" "yaml"
install_py_pkg_if_needed "scipy"

# for corona just make sure we rerun this again
# pip install numpy==$NP_VERSION


# if [[ "$DEVELOPMENT" == "1" ]]; then
#     export PYTHONPATH="/usr/workspace/sinurat1/dlio_benchmark:$PYTHONPATH"
# fi
# else
#     install_py_pkg_if_needed "dlio"
# fi

# Execute script
export TF_CPP_MIN_LOG_LEVEL=3

glob_disable
    python -m src.analyzer.main $@
glob_enable