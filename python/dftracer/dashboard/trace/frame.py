"""DataFrame plumbing: dtypes, empty frames, rows, grouping and Arrow output.

Pure functions over dftracer-utils' DataFrame. They carry no trace state, so a
query module can use them without a reader.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any, Union, cast

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
from dftracer.utils import DataFrame, Series
from dftracer.utils.columnar import Agg, F, GroupBy, count

Row = dict[str, Any]

_INT_TYPES = {"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"}
_FLOAT_TYPES = {"float32", "float64"}


def _dtype(value: str) -> str:
    """Column dtype of an index column, in numpy terms for empty frames."""
    if value in _INT_TYPES:
        return "int64"
    if value in _FLOAT_TYPES:
        return "float64"
    return "str"


def _empty(columns: tuple[str, ...], types: dict[str, str] | None = None) -> DataFrame:
    """An empty frame carrying the right dtype per column."""
    types = types or {}
    spec: dict[str, np.ndarray] = {}
    for c in columns:
        kind = types.get(c, "int64" if c in ("pid", "tid", "ts", "dur", "count") else "str")
        if kind == "float64":
            spec[c] = np.array([], dtype=np.float64)
        elif kind == "int64":
            spec[c] = np.array([], dtype=np.int64)
        else:
            spec[c] = np.array([], dtype=str)
    return DataFrame.from_dict(spec)


def _rows(df: DataFrame) -> list[Row]:
    data = df.to_dict()
    if not data:
        return []
    keys = list(data)
    return [dict(zip(keys, vals)) for vals in zip(*(data[k] for k in keys))]


def _first(df: DataFrame) -> Row:
    rows = _rows(df.head(1))
    return rows[0] if rows else {}


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) else 0.0


def _int(v: Any) -> int:
    return int(v) if isinstance(v, (int, float)) else 0


def _col(df: DataFrame, name: str) -> Series:
    """One column as a Series (the engine types ``df[name]`` as a union)."""
    return cast(Series, df[name])


def _group(df: DataFrame, *keys: Union[str, Sequence[str]]) -> GroupBy:
    """``DataFrame.group_by`` narrowed to the lazy ``GroupBy``."""
    return cast(GroupBy, df.group_by(*keys))  # ty: ignore[invalid-argument-type]


def _agg(gb: GroupBy, *aggs: Agg) -> DataFrame:
    """``GroupBy.agg`` narrowed to a DataFrame."""
    return gb.agg(*aggs)


def _arrow_table(df: DataFrame, schema: pa.Schema) -> pa.Table:
    """The frame as an Arrow table with ``schema``.

    A grouped column comes back dictionary-encoded over ``string_view`` values,
    which pyarrow 26 cannot cast or decode; rebuild those from their values.
    """
    table = df.to_arrow()
    arrays = []
    for field, column in zip(table.schema, table.columns):
        arr = column.combine_chunks()
        if pa.types.is_dictionary(field.type):
            values = arr.dictionary
            if pa.types.is_string_view(values.type):
                values = values.cast(pa.string())
            arr = pc.take(values, arr.indices.cast(pa.int64()))
        elif pa.types.is_string_view(field.type):
            arr = arr.cast(pa.string())
        arrays.append(arr)
    return pa.table(arrays, names=table.schema.names).cast(schema)


def _ret_json(df: DataFrame) -> Series | str:
    """The timeline's args payload: a minimal JSON object with the I/O size.

    A frame with no ``ret`` column has no payload at all, so the caller gets the
    empty string it puts straight into JSON.
    """
    if "ret" not in df.columns:
        return ""
    pre = _col(df.assign(_p='{"ret":'), "_p")
    post = _col(df.assign(_q="}"), "_q")
    return pre.str_cat(_col(df, "ret").astype("string")).str_cat(post).fillna("")


def _log_hist(
    df: DataFrame, column: str, lo: float, hi: float, nbuckets: int
) -> tuple[list[float], list[int]]:
    lg0, lg1 = math.log10(lo), math.log10(hi)
    edges = [10 ** (lg0 + (lg1 - lg0) * i / nbuckets) for i in range(nbuckets + 1)]
    expr = F(column)
    binned = df.assign(
        _b=(((expr.log10() - lg0) / (lg1 - lg0)) * nbuckets)
        .floor()
        .clip(0, nbuckets - 1)
        .cast("int64")
    )
    counts = [0] * nbuckets
    for r in _rows(_agg(_group(binned, "_b"), count())):
        b = int(r["_b"])
        if 0 <= b < nbuckets:
            counts[b] = int(r["count"])
    return edges, counts
