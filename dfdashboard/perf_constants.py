# @Note: this file is temporary only

from enum import StrEnum


class PerfTracerCategory(StrEnum):
    DATASET = "ds"
    PREPROCESS = "pp"
    CHECKPOINT = "ck"
    DATAMODULE = "dm"
    FETCH_DATA = "fe"
    TRAIN_COMPUTE = "trco"
    TEST_COMPUTE = "teco"
    RUNTIME = "rt"
    DEVICE = "dv"
    PIPELINE = "pi"


class PerfTracerPreprocess(StrEnum):
    TOTAL = "total"
    COLLATE = "collate"


class PerfTracerFetchData(StrEnum):
    ITER = "iter"
    YIELD = "yield"


class PerfTracerDataModule(StrEnum):
    INIT = "init"
    SETUP = "setup"


class PerfTracerTrainCompute(StrEnum):
    FORWARD = "fwd"
    BACKWARD = "bwd"
    STEP = "step"


class PerfTracerTestCompute(StrEnum):
    FORWARD = "fwd"
    STEP = "step"


class PerfTracerDevice(StrEnum):
    TRANSFER = "trf"


class PerfTracerPipeline(StrEnum):
    EPOCH = "epoch"
    STEP = "step"
    TRAIN_LOOP = "train_loop"


class PerfTracerDataset(StrEnum):
    GETITEM = "getitem"


__all__ = [
    "PerfTracerCategory",
    "PerfTracerFetchData",
    "PerfTracerTrainCompute",
    "PerfTracerTestCompute",
    "PerfTracerDevice",
    "PerfTracerPipeline",
    "PerfTracerDataset",
    "PerfTracerDataModule",
]
